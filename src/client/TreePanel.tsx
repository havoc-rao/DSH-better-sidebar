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
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import clsx from 'clsx'
import { IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type GitStatusResult } from './api.ts'
import { FileTree, gitKindCss } from './FileTree.tsx'
import type { Context } from '../context-types.ts'
import { buildGitStatusMap, subscribeGitStatusChanged } from './git-status.ts'
import { t } from './locales.ts'
import { resolveSidebarPath } from './produced-files.ts'
import { searchKeyAction, clampSearchIndex } from './search-keys.ts'
import { setSearchActive, setSearchInputElement } from './keybindings.ts'
import css from './sidebar.module.css'

export function TreePanel(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  /** Passed through to FileTree (v0.16.0+): enables icon-theme row icons. */
  ctx?: Context
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** File context-menu "open in a new tab" (passed through to FileTree). */
  onOpenFileNewTab?: (path: string) => void
  /** File context-menu "open to the side" (passed through to FileTree). */
  onOpenFileSide?: (path: string) => void
  onReferenceFile: (path: string) => void
  /** Full-window presentation: the panel fills its host instead of docking
   *  at a fixed width. */
  full?: boolean
  /** Whether this tab is the ACTIVE, VISIBLE one (v0.14.0+): only a visible
   *  tree panel registers itself as the global search-focus target, so a
   *  hidden tab's docked panel can never swallow ⌘P / ⌘F. */
  visible?: boolean
}) {
  const { sessionId, cwd, expanded, ctx, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide, onReferenceFile, full, visible } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ matches: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  /** The highlighted result row (keyboard navigation). */
  const [activeIndex, setActiveIndex] = useState(0)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // ── Git status decorations (VSCode-style) ───────────────────────────────
  // Fetched per panel on mount / session change / the refresh button, plus
  // every time the git panel bumps the shared change bus (stage, commit,
  // discard…). Failures degrade silently to a clean tree — the git panel is
  // the place that surfaces git errors.
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null)
  const gitRequest = useRef(0)
  const loadGitStatus = useCallback(() => {
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
  }, [sessionId, cwd])
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

  const needle = query.trim()
  useEffect(() => {
    if (needle === '') {
      setResults(null)
      setError(null)
      setActiveIndex(0)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      api.fsSearch({ sessionId, cwd }, needle, controller.signal).then((found) => {
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
  }, [sessionId, cwd, needle])

  // Publish the transient UI markers the keybinding context reads: the
  // active state (query or focus) and — only while VISIBLE — this input as
  // the global search-focus target (an invisible tab's docked panel must
  // never claim it). The marker lives module-level and is cleared on
  // unmount / hidden, so ⌘P / ⌘F always reach the panel the user sees.
  useEffect(() => { setSearchActive(needle !== '' || focused) }, [needle, focused])
  useEffect(() => {
    if (visible === false) return
    setSearchInputElement(inputRef.current)
    return () => { setSearchInputElement(null) }
  }, [visible])

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

  return (
    <div className={clsx(css.editorTreePanel, full === true && css.editorTreePanelFull)}>
      <div className={css.editorTreeSearch}>
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
        <Tooltip label={t('refresh')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('refresh')}
            onClick={() => { setRefreshTick(tick => tick + 1) }}
          >
            <IconRefreshOutline16 size={14} />
          </button>
        </Tooltip>
      </div>
      {needle === '' ? (
        <FileTree
          sessionId={sessionId}
          cwd={cwd}
          expanded={expanded}
          ctx={ctx}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          onOpenFileNewTab={onOpenFileNewTab}
          onOpenFileSide={onOpenFileSide}
          onReferenceFile={onReferenceFile}
          refreshTick={refreshTick}
          gitStatus={overlay.map}
        />
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
    </div>
  )
}