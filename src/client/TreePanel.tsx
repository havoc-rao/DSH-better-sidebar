/**
 * The files window's tree surface: a global file-name search box on top
 * (300ms debounce; an in-flight search is aborted by the next keystroke)
 * over either the shared controlled FileTree (empty query) or the flat
 * result list (relative paths; click opens through the caller's mode-aware
 * open). Owns its refresh tick: the icon next to the search input clears
 * the tree cache. EditorHost docks it as the tab's right panel (wrapped in
 * a drag-resize handle) and provides the file context-menu open escapes.
 *
* Keyboard-first (v0.14.0+): the search box navigates like a quick-open
 * list — ArrowDown/ArrowUp move a highlighted result (wrap-around), Enter
 * opens the highlighted result, Escape clears the query (an empty query
 * blurs the input). The input also registers itself as THE live files
 * search input (only while `visible`) so the global ⌘P / ⌘F keybindings
 * can focus it from anywhere.
 *
 * Uploads (header pickers, the tree's drag-drop and "upload here" menu)
 * all funnel through here: one session at a time, shown in a full-window
 * progress overlay with cancel, followed by a tree refresh and a one-line
 * hint under the search row (success fades, failures and cancels stay).
 * OS file drags are shielded at the panel host (see Sidebar.tsx), so a
 * drop over the file window uploads here and never reaches DSH's chat
 * intake.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import clsx from 'clsx'
import { IconFolderOpen16, IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type GitStatusResult } from './api.ts'
import { FileTree, gitKindCss } from './FileTree.tsx'
import { fileTreeCapabilityOn, useFileTreeRoots, useFileTreeSource } from './file-tree-source.ts'
import { useFileTreeSection } from './file-tree-section.ts'
import type { Context } from '../context-types.ts'
import { buildGitStatusMap, subscribeGitStatusChanged } from './git-status.ts'
import { IconUploadOutline16 } from './icons.tsx'
import type { OpenWithTarget } from './open-with.ts'
import { t } from './locales.ts'
import { resolveSidebarPath } from './produced-files.ts'
import { searchKeyAction, clampSearchIndex } from './search-keys.ts'
import { setSearchActive, setSearchInputElement } from './keybindings.ts'
import { UploadOverlay } from './UploadOverlay.tsx'
import {
  summarizeResults, uploadHintText, uploadItemsFromFiles, uploadToDir,
  UPLOAD_HINT_MS, type UploadItem,
} from './upload.ts'
import css from './sidebar.module.css'

/** One in-flight upload session (the overlay's progress source). */
interface UploadSession {
  dir: string
  done: number
  total: number
  /** Relative path of the file being uploaded ('' when none is in flight). */
  current: string
  controller: AbortController
}

export function TreePanel(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
/** Passed through to FileTree (v0.16.0+): enables icon-theme row icons. */
  ctx?: Context
  /** Files highlighted by a "Show in folder" reveal (absolute paths). */
  revealed?: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** File context-menu "open in a new tab" (passed through to FileTree). */
  onOpenFileNewTab?: (path: string) => void
  /** File context-menu "open to the side" (passed through to FileTree). */
  onOpenFileSide?: (path: string) => void
  /** The "open with" menu surface (passed through to FileTree; absent →
   *  the whole section is hidden). */
  openWithTargets?: OpenWithTarget[]
  openWithPinned?: string[]
  openWithSsh?: boolean
  onOpenWith?: (targetId: string, path: string) => void
  onToggleOpenWithPin?: (targetId: string) => void
  onReferenceFile: (path: string) => void
  /** Full-window presentation: the panel fills its host instead of docking
   *  at a fixed width. */
  full?: boolean
  /** Whether this tab is the ACTIVE, VISIBLE one (v0.14.0+): only a visible
   *  tree panel registers itself as the global search-focus target, so a
   *  hidden tab's docked panel can never swallow ⌘P / ⌘F. */
  visible?: boolean
}) {
const { sessionId, cwd, expanded, ctx, revealed, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin, onReferenceFile, full, visible } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ matches: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
/** The highlighted result row (keyboard navigation). */
  const [activeIndex, setActiveIndex] = useState(0)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // ── File-tree data source (v0.17.0+) ────────────────────────────────────
  // The provider resolved for this session (undefined = local host). It
  // gates the panel's local-only chrome: search, upload pickers and git
  // status all ride the provider's declared capabilities — undeclared
  // abilities degrade OFF in provider mode, local sessions keep everything.
  const fileSource = useFileTreeSource(ctx, sessionId, cwd)
  // Multi-root (v0.18.0+): the session's resolved REMOTE roots. Panel-level
  // capabilities stay LOCAL whenever the local root exists — the search box
  // serves the LOCAL starting point, uploads land in local dirs, git
  // decorations describe the local repo — so multi-root mode keeps every
  // panel surface exactly as a local session has it. Remote-root
  // degradation is per-ROOT inside the tree (FileTree receives this same
  // resolution, so the provider's `roots` is consulted once per change).
  const resolvedRoots = useFileTreeRoots(ctx, sessionId, cwd)
  const multiRoot = (resolvedRoots?.length ?? 0) > 0
  const localMode = fileSource === undefined || multiRoot
  const uploadOn = localMode || fileTreeCapabilityOn(fileSource, 'upload')
  const gitOn = localMode || fileTreeCapabilityOn(fileSource, 'git')
  const searchOn = localMode
    || (fileSource.capabilities.search === true && fileSource.source.search !== undefined)

  // ── Upper-module slot (v0.19.0+): the FIRST section whose `match`
  //    accepts this session renders in an independent region ABOVE the
  //    local tree; no match → undefined, and the tree renders exactly as
  //    before (no wrapper, no extra DOM). Live: re-resolves on registry
  //    ticks (a plugin activating/deactivating shows/hides the section
  //    immediately) and on session/cwd changes.
  const section = useFileTreeSection(ctx, sessionId, cwd)

  // ── Git status decorations (VSCode-style) ───────────────────────────────
  // Fetched per panel on mount / session change / the refresh button, plus
  // every time the git panel bumps the shared change bus (stage, commit,
  // discard…). Failures degrade silently to a clean tree — the git panel is
  // the place that surfaces git errors.
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null)
  const gitRequest = useRef(0)
  const loadGitStatus = useCallback(() => {
    // Provider sessions: decorations only exist when the provider declared
    // git support (the local host's git.status cannot describe remote
    // paths); the map stays null → the tree renders clean, footer hidden.
    if (!gitOn) {
      setGitStatus(null)
      return
    }
    if (cwd === undefined || cwd === '') {
      setGitStatus(null)
      return
    }
    const request = ++gitRequest.current
    api.gitStatus({ sessionId, cwd }).then((result) => {
      if (gitRequest.current !== request) return
      setGitStatus(result)
    }).catch(() => {
      if (gitRequest.current !== request) return
      setGitStatus(null)
    })
  }, [sessionId, cwd, gitOn])
  useEffect(() => { loadGitStatus() }, [loadGitStatus, refreshTick])
  // Re-colors the explorer when the git panel refreshes/mutates.
  useEffect(() => {
    const dispose = subscribeGitStatusChanged(loadGitStatus)
    return () => {
      dispose()
      // Invalidate any in-flight status (unmount / session switch).
      gitRequest.current += 1
    }
  }, [loadGitStatus])
  const overlay = useMemo(() => buildGitStatusMap(gitStatus, cwd), [gitStatus, cwd])

  // ── Uploads (header pickers; the tree receives its own drag-drop) ──────
  /** One-line upload status under the search row ('' hides the hint). */
  const [uploadStatus, setUploadStatus] = useState('')
  /** Whether the status line is a failure/cancel (error color, stays visible). */
  const [uploadFailed, setUploadFailed] = useState(false)
  /** The in-flight upload session (null → no overlay, buttons enabled). */
  const [upload, setUpload] = useState<UploadSession | null>(null)
  /** True between the cancel click and the session settling (button disabled). */
  const [cancelling, setCancelling] = useState(false)
  /** Set by cancelUpload; the settle path shows 'upload cancelled' instead of
   *  summarizing the partial results. */
  const cancelledRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  /** Start one upload session into `dir` (absolute, inside the workspace). */
  const startUpload = (dir: string, items: UploadItem[]): void => {
    // Provider sessions without declared upload support never upload (the
    // local upload route cannot write remote paths).
    if (items.length === 0 || cwd === undefined || upload !== null || !uploadOn) return
    cancelledRef.current = false
    const controller = new AbortController()
    setUploadFailed(false)
    setUploadStatus(uploadHintText(0, items.length, '', dir, t))
    setUpload({ dir, done: 0, total: items.length, current: '', controller })
    void uploadToDir({ sessionId, cwd }, dir, items, (done, total, current) => {
      if (current !== '') setUploadStatus(uploadHintText(done, total, current, dir, t))
      setUpload(session => session === null ? session : { ...session, done, total, current })
    }, controller.signal).then((results) => {
      setUpload(null)
      setCancelling(false)
      // Reload the tree whatever the outcome: files may have landed before a
      // cancel, and failures leave whatever did succeed visible.
      setRefreshTick(tick => tick + 1)
      if (cancelledRef.current) {
        setUploadStatus(t('uploadCancelled'))
        setUploadFailed(true)
        return
      }
      const status = summarizeResults(results, t)
      setUploadStatus(status)
      setUploadFailed(results.some(result => !result.ok))
      // Success messages are transient; failures stay until the next action.
      if (results.every(result => result.ok)) {
        window.setTimeout(() => {
          setUploadStatus(current => current === status ? '' : current)
        }, UPLOAD_HINT_MS)
      }
    })
  }

  /** Cancel the in-flight upload (aborts the request; the host drops its temp). */
  const cancelUpload = (): void => {
    if (upload === null || cancelling) return
    cancelledRef.current = true
    setCancelling(true)
    upload.controller.abort()
  }

  const folderInputProps = { webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>

  const needle = query.trim()
  useEffect(() => {
    if (needle === '') {
      setResults(null)
      setError(null)
      setActiveIndex(0)
      return
    }
    // Provider sessions without a declared provider search never hit the
    // local host search route (it cannot see remote paths); the box is
    // hidden anyway — this guard keeps a stale query from fetching.
    if (!searchOn) {
      setResults(null)
      setError(null)
      setActiveIndex(0)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const request: Promise<{ matches: string[]; truncated: boolean }> = (async () => {
        // Provider search only serves v0.17 SINGLE-provider sessions; in
        // multi-root mode the box always acts on the LOCAL root, so the
        // local host route owns every query (a remote root's listing
        // namespace would need its own search surface — v0.18 keeps the
        // box local-only).
        if (!multiRoot && fileSource !== undefined && fileSource.source.search !== undefined) {
          const found = await fileSource.source.search(needle, controller.signal)
          if ('error' in found) throw new Error(found.error)
          return { matches: found.matches, truncated: found.truncated === true }
        }
        return api.fsSearch({ sessionId, cwd }, needle, controller.signal)
      })()
      request.then((found) => {
        setResults(found)
        setError(null)
        setActiveIndex(0)
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setResults(null)
        setError(failure instanceof Error ? failure.message : String(failure))
        setActiveIndex(0)
      })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [sessionId, cwd, needle, searchOn, fileSource, multiRoot])

// Publish the transient UI markers the keybinding context reads: the
  // active state (query or focus) and — only while VISIBLE — this input as
  // the global search-focus target (an invisible tab's docked panel must
  // never claim it). The marker lives module-level and is cleared on
  // unmount / hidden, so ⌘P / ⌘F always reach the panel the user sees.
  useEffect(() => { setSearchActive(searchOn && (needle !== '' || focused)) }, [needle, focused, searchOn])
  useEffect(() => {
    if (visible === false || !searchOn) return
    setSearchInputElement(inputRef.current)
    return () => { setSearchInputElement(null) }
  }, [visible, searchOn])

  const matches = results?.matches ?? []
  const rowCount = matches.length

  /** Keep the highlighted row in view after a keyboard move. */
  const revealActive = (index: number): void => {
    if (rowCount <= 0) return
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-search-row="${index}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }

  /** The search box keydown: quick-open list semantics (see search-keys.ts). */
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const action = searchKeyAction({
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    }, query, rowCount, activeIndex)
    switch (action.type) {
      case 'move':
        event.preventDefault()
        setActiveIndex(action.index)
        revealActive(action.index)
        break
      case 'open':
        event.preventDefault()
        onOpenFile(resolveSidebarPath(cwd, matches[action.index]!))
        break
      case 'clear':
        event.preventDefault()
        setQuery('')
        setActiveIndex(0)
        break
      case 'blur':
        event.preventDefault()
        inputRef.current?.blur()
        break
      case 'none':
        break
    }
  }

  const busy = upload !== null

  // The LOCAL tree (the lower module — every panel-level capability above
  // keeps serving only this surface). Hoisted so the no-match path renders
  // it DIRECTLY (byte-for-byte the pre-slot DOM); a matched section wraps
  // it in the dual-module stack instead.
  const localTree = (
    <FileTree
      sessionId={sessionId}
      cwd={cwd}
      expanded={expanded}
      /* Multi-root (v0.18.0+): the panel's own resolution — the tree's
         row-level gates (per-root capability faces) must stay in step
         with the panel-level gates above. Passed down so `roots` is
         consulted exactly once per registry change. */
      roots={resolvedRoots}
      ctx={ctx}
      revealed={revealed}
      onToggle={onToggle}
      onOpenFile={onOpenFile}
      onOpenFileNewTab={onOpenFileNewTab}
      onOpenFileSide={onOpenFileSide}
      openWithTargets={openWithTargets}
      openWithPinned={openWithPinned}
      openWithSsh={openWithSsh}
      onOpenWith={onOpenWith}
      onToggleOpenWithPin={onToggleOpenWithPin}
      onReferenceFile={onReferenceFile}
      refreshTick={refreshTick}
      gitStatus={overlay.map}
      onUploadRequest={startUpload}
      busy={busy}
    />
  )

  return (
    <div className={clsx(css.editorTreePanel, full === true && css.editorTreePanelFull)}>
      <div className={css.editorTreeSearch}>
        {searchOn ? (
          <input
            ref={inputRef}
            className={css.editorSearchInput}
            value={query}
            placeholder={t('editorSearchPlaceholder')}
            spellCheck={false}
            data-dsh-sidebar-search=""
            onChange={(event) => { setQuery(event.target.value) }}
            onFocus={() => { setFocused(true) }}
            onBlur={() => { setFocused(false) }}
            onKeyDown={onSearchKeyDown}
          />
        ) : null}
<Tooltip label={t('refresh')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('refresh')}
            title={t('refresh')}
            onClick={() => { setRefreshTick(tick => tick + 1) }}
          >
            <IconRefreshOutline16 size={14} />
          </button>
        </Tooltip>
        {uploadOn && (
          <>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('uploadFiles')}
              title={t('uploadFiles')}
              disabled={busy}
              onClick={() => { fileInputRef.current?.click() }}
            >
              <IconUploadOutline16 size={14} />
            </button>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('uploadFolder')}
              title={t('uploadFolder')}
              disabled={busy}
              onClick={() => { folderInputRef.current?.click() }}
            >
              <IconFolderOpen16 size={14} />
            </button>
          </>
        )}
        {uploadOn && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(event) => {
                if (cwd !== undefined) startUpload(cwd, uploadItemsFromFiles(event.target.files ?? []))
                event.target.value = ''
              }}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              {...folderInputProps}
              style={{ display: 'none' }}
              onChange={(event) => {
                if (cwd !== undefined) startUpload(cwd, uploadItemsFromFiles(event.target.files ?? []))
                event.target.value = ''
              }}
            />
          </>
        )}
      </div>
      {uploadStatus !== '' && (
        <div className={clsx(css.editorSearchHint, uploadFailed && css.editorError)} title={uploadStatus}>{uploadStatus}</div>
      )}
      {needle === '' ? (
        /* Dual-module (v0.19.0+): with a matched section the tree area is a
           vertical stack — the injected upper module (independent scroll
           region, content-driven height capped at half the panel, separated
           from the tree by a hairline) over the LOCAL tree, which keeps its
           own scroll context and every existing capability. The wrapper
           exists ONLY on the matched path; sectionless renders the local
           tree directly (byte-for-byte the pre-slot DOM). While the local
           search box is active the results list REPLACES the whole tree
           area (both modules), so the section renders exclusively in tree
           mode. The section is only ever the match winner's —
           `section.render` receives the session scope; better-sidebar
           applies no panel capability to it. */
        section === undefined
          ? localTree
          : (
            <div className={css.explorerDual}>
              <div className={css.explorerSection} data-dsh-file-tree-section={section.id}>
                {section.render({ sessionId, cwd, ctx: ctx! })}
              </div>
              {localTree}
            </div>
          )
      ) : (
        <div className={css.explorerBody}>
          {error !== null && <div className={clsx(css.editorSearchHint, css.editorError)}>{error}</div>}
          {error === null && results === null && <div className={css.editorSearchHint}>{t('loading')}</div>}
          {error === null && results !== null && results.matches.length === 0 && (
            <div className={css.editorSearchHint}>{t('editorSearchNoResults')}</div>
          )}
          {error === null && results !== null && results.matches.map((rel, index) => {
            const active = index === clampSearchIndex(activeIndex, results.matches.length)
            return (
              <button
                key={rel}
                type="button"
                data-search-row={index}
                className={clsx(css.editorSearchResult, active && css.editorSearchResultActive)}
                aria-current={active ? 'true' : undefined}
                title={rel}
                onMouseEnter={() => { setActiveIndex(index) }}
                onClick={() => { onOpenFile(resolveSidebarPath(cwd, rel)) }}
              >
                {rel}
              </button>
            )
          })}
          {error === null && results !== null && results.matches.length > 0 && (
            <div className={clsx(css.editorSearchHint, css.editorSearchNavHint)}>{t('searchNavHint')}</div>
          )}
          {error === null && results?.truncated === true && (
            <div className={css.editorSearchHint}>{t('editorSearchTruncated')}</div>
          )}
        </div>
      )}
{/*
        The VSCode-style status footer: changed-file counts under the tree
        root, colored by status family (most severe first). Only in a repo
        with changes; hidden rows/dirs never count twice — the counts are
        the changed FILES, the same set the badges decorate.
      */}
      {overlay.counts.length > 0 && (
        <div className={css.explorerGitFooter} title={t('explorerGitFooter')}>
          {overlay.counts.map(count => (
            <span key={count.letter} className={clsx(css.explorerGitFooterItem, gitKindCss[count.kind])}>
              <span className={css.explorerGitFooterLetter}>{count.letter}</span>
              {count.count}
            </span>
          ))}
        </div>
      )}
      {upload !== null && (
        <UploadOverlay
          dir={upload.dir}
          done={upload.done}
          total={upload.total}
          current={upload.current}
          onCancel={cancelUpload}
          cancelling={cancelling}
        />
      )}
    </div>
  )
}