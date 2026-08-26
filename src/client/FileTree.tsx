/**
 * The controlled file tree behind the files window's tree panel (TreePanel
 * wraps it with the search box): a lazy VSCode-style tree rooted at the
 * session's working directory. Levels load on expansion (one API call per
 * directory), directories sort first, hidden entries render dimmed. The
 * expansion set lives in the per-session state (owned by the caller); the
 * caller also owns the refresh affordance — a `refreshTick` bump wipes the
 * level cache so the visible set reloads.
 *
 * Indent guides: rows paint VSCode-style vertical guide lines under each
 * expanded ancestor (via inline background gradients — see
 * `treeGuideBackground`), with a horizontal corner on expanded directory
 * rows, so the sibling structure reads at a glance.
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu: file rows offer the caller's open escapes
 * (new tab / to the side, only when the callbacks exist) and a download
 * action (the host serves raw bytes, binary-safe); every row can copy the
 * relative or absolute path (with a brief "copied" label replacing the
 * button after a successful write).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16, IconFolderClose16, IconFolderOpen16,
  IconLinkOutline16, Menu, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, downloadUrl, type FsEntry } from './api.ts'
import { gitStatusAt, type GitRowStatus, type GitStatusKind } from './git-status.ts'
import { relativeTo } from './paths.ts'
import { t, type CopyKey } from './locales.ts'
import { useFileIconResolver } from './FileIcon.tsx'
import { commandMenuRows, type CommandMenuWhere } from './commands.ts'
import type { Context } from '../context-types.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
}

/** The tree's indent geometry: one 22px column per depth level plus the
 *  fixed 6px left inset — this is the row padding formula (`depth * 22 + 6`),
 *  hoisted so the guide painter and the paddings can never drift apart. */
const INDENT_STEP = 22
const INDENT_BASE = 6

/** The indent-guide stroke: the app's border token slightly faded (the
 *  repo's color-mix pattern), the visual weight of VSCode's guide lines —
 *  clearly visible but quieter than the row dividers. */
const GUIDE_STROKE = 'color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent)'

/** VSCode-style indent guides for one row, as a CSS background layer set
 *  (zero extra DOM, drops out entirely at depth 0 — the root row): a 1px
 *  vertical stroke under every expanded ancestor at that ancestor's icon
 *  column (the root is always expanded, so depth-1 rows draw one stroke at
 *  x=6), plus — on expanded DIRECTORY rows only — the horizontal corner
 *  segment joining the deepest ancestor stroke to the folder icon (the "├─"
 *  joint). Files and collapsed dirs keep just the verticals, so sibling
 *  structure reads at a glance exactly like the VSCode explorer.
 *
 *  Neighboring rows decide where strokes stop: a row at depth D draws only
 *  the D ancestor columns, so the first shallower sibling below a subtree
 *  simply has no stroke for it — each guide ends flush at its subtree's last
 *  row, never dangling into empty space.
 *
 *  The style is applied inline as background longhands (never the `background`
 *  shorthand): the shorthand would claim `background-color`, which the
 *  stylesheet's row fill and hover fill own.
 */
export function treeGuideBackground(depth: number, isOpenDir: boolean): CSSProperties {
  if (depth <= 0) return {}
  const image: string[] = []
  const size: string[] = []
  const position: string[] = []
  const repeat: string[] = []
  if (isOpenDir) {
    // The corner: a horizontal stroke across the deepest indent column at
    // the row's vertical center (rows are 34px tall → 16.5–17.5px).
    const from = (depth - 1) * INDENT_STEP + INDENT_BASE
    image.push(`linear-gradient(0deg, transparent 16.5px, ${GUIDE_STROKE} 16.5px, ${GUIDE_STROKE} 17.5px, transparent 17.5px)`)
    size.push(`${INDENT_STEP}px 100%`)
    position.push(`${from}px 0`)
    repeat.push('no-repeat')
  }
  for (let k = 0; k < depth; k++) {
    const x = k * INDENT_STEP + INDENT_BASE
    image.push(`linear-gradient(90deg, transparent ${x}px, ${GUIDE_STROKE} ${x}px, ${GUIDE_STROKE} ${x + 1}px, transparent ${x + 1}px)`)
    size.push('100% 100%')
    position.push('0px 0px')
    repeat.push('no-repeat')
  }
  return {
    backgroundImage: image.join(', '),
    backgroundSize: size.join(', '),
    backgroundPosition: position.join(', '),
    backgroundRepeat: repeat.join(', '),
  }
}

/** Root label: the last path segment (mirror of the host rootLabel). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** The status-kind → color-family CSS class (VSCode palette mapped onto DSH
 *  tokens; the values are `string | undefined` under noUncheckedIndexedAccess
 *  and only ever feed clsx). */
export const gitKindCss = {
  modified: css.explorerGitWarn,
  type: css.explorerGitWarn,
  added: css.explorerGitSuccess,
  renamed: css.explorerGitSuccess,
  copied: css.explorerGitSuccess,
  deleted: css.explorerGitError,
  conflict: css.explorerGitError,
  untracked: css.explorerGitMuted,
  ignored: css.explorerGitMuted,
} satisfies Record<GitStatusKind, string | undefined>

/** The status-kind → copy key for the badge tooltip (VSCode-style "Modified"). */
const KIND_TITLE: Record<GitStatusKind, CopyKey> = {
  modified: 'gitStatusModified',
  type: 'gitStatusTypeChanged',
  added: 'gitStatusAdded',
  renamed: 'gitStatusRenamed',
  copied: 'gitStatusCopied',
  deleted: 'gitStatusDeleted',
  conflict: 'gitStatusConflict',
  untracked: 'gitStatusUntracked',
  ignored: 'gitStatusIgnored',
}

/** The row's git badge (a colored letter), or nothing when the row is clean. */
function gitBadge(status: GitRowStatus | undefined): ReactNode {
  if (status === undefined) return null
  return (
    <span className={clsx(css.explorerGitBadge, gitKindCss[status.kind])} title={t(KIND_TITLE[status.kind])}>
      {status.letter}
    </span>
  )
}

export function FileTree(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  /** The client context (v0.16.0+): enables the ACTIVE icon theme's file
   *  icons on rows. Absent → the built-in outline icons (zero change). */
  ctx?: Context
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Context-menu "open in a new tab" (file rows; absent → no entry). */
  onOpenFileNewTab?: (path: string) => void
  /** Context-menu "open to the side" (file rows; absent → no entry). */
  onOpenFileSide?: (path: string) => void
  /** Insert `@<relative path>` into the composer draft. */
  onReferenceFile: (path: string) => void
  /** Bump to wipe the level cache and reload the visible set. */
  refreshTick: number
  /** VSCode-style git decorations: normalized absolute path → row status
   *  (files carry their own status, folders the descendant aggregate).
   *  Absent → the tree renders clean (no badges, no fetch). */
  gitStatus?: ReadonlyMap<string, GitRowStatus>
}) {
  const { sessionId, cwd, expanded, ctx, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide, onReferenceFile, refreshTick, gitStatus } = props
  // The active icon theme's row resolver (null when no theme is active —
  // the built-in outline icons below stay the default).
  const fileIcon = useFileIconResolver(ctx)
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  const loadDir = useCallback((dir: string) => {
    if (dataRef.current[dir] !== undefined) return
    storeLevel(dir, {})
    api.fsTree({ sessionId, cwd }, dir).then((listing) => {
      storeLevel(dir, { entries: listing.entries })
    }).catch((error: unknown) => {
      storeLevel(dir, { error: error instanceof Error ? error.message : String(error) })
    })
  }, [sessionId, cwd, storeLevel])

  // The caller's refresh tick wipes the cache (declared BEFORE the load
  // effect so the reload below sees the empty cache).
  const lastTick = useRef(refreshTick)
  useEffect(() => {
    if (lastTick.current === refreshTick) return
    lastTick.current = refreshTick
    dataRef.current = {}
    setData({})
  }, [refreshTick])

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only the refresh tick wipes the cache.
    const root = cwd
    if (root === undefined) return
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [cwd, expanded, refreshTick, loadDir])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  /** The row's trailing actions: the @-reference button, or the copied label. */
  const rowActions = (entry: FsEntry): ReactNode => {
    if (copiedPath === entry.path) {
      return <span className={css.explorerCopied}>{t('copied')}</span>
    }
    return (
      <button
        type="button"
        className={css.explorerRef}
        aria-label={t('referenceFile')}
        title={t('referenceFile')}
        onClick={(event) => {
          event.stopPropagation()
          onReferenceFile(entry.path)
        }}
      >
        {t('referenceFile')}
      </button>
    )
  }

  const openRowMenu = (event: MouseEvent, path: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setRowMenu({ path, isDir, x: event.clientX, y: event.clientY })
  }

  /** Download a file through the host route (raw bytes, binary-safe). */
  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId, cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const root = cwd

  // Plugin-command rows for the row context menu (v0.16.0+): appended
  // after the built-in rows, driven by the pure builder — zero logic here.
  const rowWhere: CommandMenuWhere = rowMenu === null
    ? 'file-row'
    : rowMenu.isDir
      ? (rowMenu.path === root ? 'root-row' : 'dir-row')
      : 'file-row'
  const commandItems = ctx?.betterSidebar === undefined ? [] : commandMenuRows(
    ctx.betterSidebar.getCommands(),
    rowWhere,
    { path: rowMenu?.path, isDir: rowMenu?.isDir, isRoot: rowMenu !== null && rowMenu.path === root },
  )

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    if (level === undefined) {
      return <div className={css.explorerRow} style={{ paddingLeft: depth * INDENT_STEP + INDENT_BASE }}>{t('loading')}</div>
    }
    if (level.error !== undefined) {
      return (
        <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * INDENT_STEP + INDENT_BASE }}>
          {level.error}
        </div>
      )
    }
    const entries = level.entries ?? []
    return entries.map(entry => {
      const status = gitStatusAt(gitStatus, entry.path)
      if (entry.isDir) {
        const isOpen = expanded.includes(entry.path)
        return (
          <div key={entry.path}>
            <div
              role="button"
              tabIndex={0}
              className={clsx(css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden)}
              style={{
                paddingLeft: depth * INDENT_STEP + INDENT_BASE,
                ...treeGuideBackground(depth, isOpen),
              }}
              onClick={() => { onToggle(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggle(entry.path)
                }
              }}
              onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
            >
              {fileIcon({ name: entry.name, isDir: true, expanded: isOpen }) ?? (isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />)}
              <span className={clsx(css.explorerName, status !== undefined && gitKindCss[status.kind])}>{entry.name}</span>
              {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
              {gitBadge(status)}
              {rowActions(entry)}
            </div>
            {isOpen && renderLevel(entry.path, depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={entry.path}
          role="button"
          tabIndex={0}
          className={clsx(
            css.explorerRow,
            entry.hidden && css.explorerHidden,
            entry.broken && css.explorerBroken,
            status?.deleted === true && css.explorerDeleted,
          )}
          style={{
            paddingLeft: depth * INDENT_STEP + INDENT_BASE,
            ...treeGuideBackground(depth, false),
          }}
          title={entry.broken ? `${entry.path} — ${t('brokenSymlink')}` : entry.path}
          onClick={() => { onOpenFile(entry.path) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpenFile(entry.path)
            }
          }}
          onContextMenu={(event) => { openRowMenu(event, entry.path, false) }}
        >
          {fileIcon({ name: entry.name, isDir: false }) ?? <IconCodeOutline16 size={14} />}
          <span className={clsx(css.explorerName, status !== undefined && gitKindCss[status.kind])}>{entry.name}</span>
          {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
          {gitBadge(status)}
          {rowActions(entry)}
        </div>
      )
    })
  }

  return (
    <div className={css.explorerBody}>
      {root === undefined ? (
        <div className={css.explorerEmpty}>{t('noSession')}</div>
      ) : (
        <>
          <div
            className={css.explorerRow}
            style={{ paddingLeft: INDENT_BASE }}
            onContextMenu={(event) => { openRowMenu(event, root, true) }}
          >
            {fileIcon({ name: baseName(root), isDir: true, expanded: true, isRoot: true }) ?? <IconFolderOpen16 size={14} />}
            <span className={css.explorerName}>{baseName(root)}</span>
            {copiedPath === root
              ? <span className={css.explorerCopied}>{t('copied')}</span>
              : (
                <button
                  type="button"
                  className={css.explorerRef}
                  aria-label={t('referenceFile')}
                  title={t('referenceFile')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onReferenceFile(root)
                  }}
                >
                  {t('referenceFile')}
                </button>
              )}
          </div>
          {data[root] !== undefined && renderLevel(root, 1)}
        </>
      )}
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the tree's overflow clip cannot crop it).
      */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // The open escapes head the FILE menu (dirs only get copy).
          ...(rowMenu?.isDir === false && onOpenFileNewTab !== undefined
            ? [{ id: 'open-new-tab', label: t('openFileNewTab'), icon: <IconCodeOutline16 size={14} /> }]
            : []),
          ...(rowMenu?.isDir === false && onOpenFileSide !== undefined
            ? [{ id: 'open-side', label: t('openFileSide'), icon: <IconFolderOpen16 size={14} /> }]
            : []),
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={14} /> }]
            : []),
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
          ...commandItems,
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'open-new-tab') {
            onOpenFileNewTab?.(target.path)
            return
          }
          if (id === 'open-side') {
            onOpenFileSide?.(target.path)
            return
          }
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          if (id === 'relative') {
            copyPath(relativeTo(cwd ?? '', target.path), target.path)
            return
          }
          if (id === 'absolute') {
            copyPath(target.path, target.path)
            return
          }
          // Plugin commands (v0.16.0+): unknown ids route to the registry;
          // a missing command is a strict no-op (executeCommand returns
          // false) — never falls through into the copy actions.
          ctx?.betterSidebar?.executeCommand(id, {
            where: rowWhere,
            path: target.path,
            isDir: target.isDir,
            isRoot: target.path === root,
          })
        }}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />
    </div>
  )
}
