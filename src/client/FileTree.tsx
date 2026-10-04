/**
 * The controlled file tree behind the files window's tree panel (TreePanel
 * wraps it with the search box): a lazy VSCode-style tree rooted at the
 * session's working directory. Levels load on expansion (one API call per
 * directory; a stale response is dropped by generation guard + abort),
 * directories sort first, hidden entries render dimmed. The expansion set
 * lives in the per-session state (owned by the caller); the caller also owns
 * the refresh affordance — a `refreshTick` bump wipes the level cache so the
 * visible set reloads.
 *
 * Selection (VS Code semantics, no modifier = the old click semantics
 * untouched): Ctrl/Cmd+click toggles a row and sets the anchor, Shift+click
 * selects the visible range from the anchor, Escape / a blank click clears,
 * right-clicking outside the selection collapses it onto the row. A non-empty
 * selection shows the batch bar above the root row (copy paths / delete /
 * clear); the batch delete confirms once and removes sequentially.
 *
 * Git ink: rows read the shared `useGitStatus` store (the changes page reads
 * the same snapshot) — a changed file's name takes its tone and a letter
 * badge, a directory with a change below it is tinted without a letter, and a
 * non-repo silently renders plain.
 *
 * Row actions: hovering a row reveals an @-reference button on the far right
 * (appends `@<relative path>` to the composer draft), and right-click opens a
 * context menu: file rows offer the caller's open escapes (new tab / to the
 * side, only when the callbacks exist), the host's "open in app" section and
 * a download action (the host serves raw bytes, binary-safe); directory rows
 * offer "upload here" and "new folder" (an inline editor at the top of that
 * level); every row can copy the relative or absolute path (with a brief
 * "copied" label replacing the button after a successful write).
 *
 * Rows are memoized components (FileRow / DirRow) fed by stable callbacks and
 * per-row booleans, so a copy flash, a drag target or a selection change only
 * re-renders the rows it touches — not the whole tree.
 *
 * Uploads start here (drag-drop or the context menu picker) but run in the
 * caller: every request is reported through `onUploadRequest(dir, items)`
 * (VSCode semantics — a drop on a file row targets its parent directory),
 * and `busy` gates new drags while one upload is in flight.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  IconArchiveOutlineRegular, IconChevronRightOutlineRegular, IconCloseFillRegular, IconCodeOutlineRegular, IconCopyOutlineRegular,
  IconDownloadOutlineRegular,
  IconEditOutlineRegular, IconFolderOpenRegular, IconLinkOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular,
  Menu, type MenuEntry, type MenuItem, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SiCursor, SiZedindustries } from 'react-icons/si'
import { VscFolderOpened, VscLinkExternal, VscPin, VscPinned } from 'react-icons/vsc'
import { api, archiveBuild, archiveDownloadUrl, archiveStatus, downloadUrl, type FsEntry } from './api.ts'
import { builtinFileIcon, builtinFolderIcon } from './file-icons.tsx'
import { IconUploadOutline16, IconVscode16 } from './icons.tsx'
import { isImeComposition } from './ime-guard.ts'
import { useSubmenuFlip } from './menu-flip.ts'
import type { OpenInApp, OpenInAppEntry } from './open-in-app.ts'
import type { OpenWithTarget } from './open-with.ts'
import { isWithinWorkspace, relativeTo } from './paths.ts'
import { t } from './locales.ts'
import type { BetterSidebarService } from './service.ts'
import {
  Chip, ConfirmDialog, IconButton, Notice, StatusBadge, useGitStatus,
  type GitTone, type StatusTone,
} from './ui/index.ts'
import { uploadItemsFromDrop, uploadItemsFromFiles, type UploadItem } from './upload.ts'
import { pushTreeOp, redoTreeOp, returnTreeOp, undoTreeOp, type TreeMutationOp } from './undo.ts'
import { useFileTreeUi } from './file-tree-ui.ts'
// Type-only (erased — never reaches the client-bundle purity gate): the
// fileTreeUi v2 client-service contract provided by the dsh-file-tree-ui
// plugin. v2 = tree-FRAMEWORK ownership: the provider renders the whole
// tree (container/subtrees, indent guides + hover seat, chevron + fold
// interaction and animations, row chrome slots, drop visuals) from the
// row models built below; this plugin injects row content, expansion state
// data and all DOM semantics (see file-tree-ui.ts for the service seat).
import type { FileTreeRowModel, FileTreeNode, GuideColumn } from 'dsh-file-tree-ui/client-contract'
import { useDirectoryWatch } from './use-dir-watch.ts'
import { usePolling } from './use-polling.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
  /** The host capped this level's listing (a huge directory). */
  truncated?: boolean
}

/** Root label: the last path segment (mirror of the host rootLabel). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** The containing directory of an absolute row path (never the root edge here). */
function parentOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at <= 0 ? path : path.slice(0, at)
}

/** Only OS file drags belong to the upload surface; in-app drags (tab reorder,
 *  split zones) must pass through untouched to the pane's tab-drop handling
 *  (mirror of Sidebar.tsx's panel-host shield gate). */
function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false
}

/** Whether a drag is an IN-TREE row drag (our custom MIME, set by the row's
 *  dragstart; never collides with the OS file drags of the upload surface). */
function isTreeDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('application/x-dsh-tree-drag') ?? false
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** One changed row's tooltip word (the badge's status vocabulary). */
function gitToneLabel(tone: GitTone): string {
  switch (tone) {
    case 'added': return t('gitStatusAdded')
    case 'deleted': return t('gitStatusDeleted')
    case 'untracked': return t('gitStatusUntracked')
    case 'renamed': return t('gitStatusRenamed')
    case 'conflict': return t('gitStatusConflict')
    // A copy is an added path from the tree's point of view, and the
    // `gitStatus*` vocabulary has no separate word for it.
    case 'copied': return t('gitStatusAdded')
    case 'modified': return t('gitStatusModified')
  }
}

/** The badge tone for one git tone (the kit has no separate 'copied' ink). */
function badgeToneOf(tone: GitTone): StatusTone {
  return tone === 'copied' ? 'added' : tone
}

/** The archive progress line's percentage (`0/0` — an empty selection — is 0%). */
function archivePercent(progress: { done: number; total: number }): number {
  if (progress.total <= 0) return 0
  return Math.min(100, Math.round((progress.done / progress.total) * 100))
}

/**
 * The drop overlay's hero art: an arrow rising out of a notched tray
 * (upload zone — the same glyph family as the toolbar's upload icon) and a
 * tilted pair of photo cards (chat zone). Hand-drawn, but every ink is a
 * theme token: the SVG paints `currentColor` and the classes below pick the
 * accent / tint / cut-out inks.
 */
const UploadDropIllustration = () => (
  <svg width="64" height="56" viewBox="0 0 64 56" fill="none" aria-hidden="true">
    <g className={css.uploadDropArtPrimary}>
      <path d="M32 28V11" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <path d="M23 20l9-9 9 9" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </g>
    <path
      className={css.uploadDropArtAccent}
      d="M10 40a4 4 0 0 1 4-4h7l3.2 4.6a5 5 0 0 0 4.1 2.2h7.4a5 5 0 0 0 4.1-2.2L43 36h7a4 4 0 0 1 4 4v2a10 10 0 0 1-10 10H20A10 10 0 0 1 10 42v-2z"
      fill="currentColor"
    />
  </svg>
)

/** The chat zone's art: two tilted photo cards, each with its own
 *  sun-over-mountains motif (the back card carries detail too, so it never
 *  reads as a bare blob). Same token-only rule as the tray above. */
const ChatDropIllustration = () => (
  <svg width="96" height="76" viewBox="0 0 96 76" fill="none" aria-hidden="true">
    <g transform="rotate(-12 24 34)">
      <rect className={css.uploadDropArtAccent} x="6" y="16" width="36" height="36" rx="10" fill="currentColor" />
      <g className={css.uploadDropArtCut}>
        <circle cx="16" cy="27" r="3.5" fill="currentColor" />
        <path d="M11 44l8-9 6 6 4-4 8 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </g>
    <g transform="rotate(8 61 35)">
      <rect className={css.uploadDropArtPrimary} x="40" y="12" width="42" height="46" rx="10" fill="currentColor" />
      <g className={css.uploadDropArtCut}>
        <circle cx="55" cy="27" r="5" fill="currentColor" />
        <path d="M46 50l10-13 7 8 6-6 9 11" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </g>
  </svg>
)

/** The modifier subset row activation needs (clicks and Enter/Space share it). */
interface ActivateModifiers {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * The stable per-row callback bundle. `FileRow` / `DirRow` are memoized, so
 * every handler here must keep its identity for the life of the tree; each
 * one reads the live props/state through the refs the tree maintains.
 */
interface RowActions {
  dragStart(event: DragEvent<HTMLDivElement>, path: string, isDir: boolean): void
  dragEnd(): void
  activate(event: ActivateModifiers, path: string, isDir: boolean): void
  contextMenu(event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean): void
  reference(path: string, isDir: boolean): void
  dragOver(event: DragEvent<HTMLDivElement>, dir: string): void
  drop(event: DragEvent<HTMLDivElement>, path: string, isDir: boolean): void
}

/** One open-in-app entry's leading glyph: the host's icon route / data URL,
 *  or a generic mark when the host has no icon for it. */
function AppGlyph(props: { entry: OpenInAppEntry }): ReactNode {
  const { icon } = props.entry
  if (icon === null || icon === '') return <IconCodeOutlineRegular size={14} />
  return <img className={css.explorerAppIcon} src={icon} alt="" width={14} height={14} />
}

/** One file row's props. Everything is a primitive or a stable reference so
 *  memo() actually bails out. */
interface FileRowProps {
  entry: FsEntry
  depth: number
  /** Registry revision: a fresh value re-resolves the row's icon. */
  iconsVersion: number
  service: BetterSidebarService | undefined
  selected: boolean
  dragging?: boolean
  revealed: boolean
  /** A drag hovers this row's PARENT directory (upload target). */
  dropTarget: boolean
  copied: boolean
  /**
   * The row's git state as PRIMITIVES, never the store's status object: the
   * shared store rebuilds its per-path objects on every poll, so passing the
   * object would re-render every changed row every 2.5s (`React.memo` compares
   * by reference) — exactly the "frequent refresh" the file list was reported
   * for. Two strings make the poll invisible to the rows.
   */
  gitTone: GitTone | undefined
  gitLetter: string | undefined
  actions: RowActions
}

const FileRow = memo(function FileRow(props: FileRowProps): ReactNode {
  const { entry, depth, iconsVersion, service, selected, revealed, dropTarget, copied, gitTone, gitLetter, actions } = props
  // Referenced so a registry change re-renders the row with its new icon.
  void iconsVersion
  const icon = service !== undefined ? service.fileIcon(entry.path, 14) : builtinFileIcon(entry.path, 14)
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(event) => { actions.dragStart(event, entry.path, entry.isDir) }}
      onDragEnd={() => { actions.dragEnd() }}
      className={clsx(
        css.explorerRow, entry.hidden && css.explorerHidden, entry.broken && css.explorerBroken,
        selected && css.explorerRowSelected,
        props.dragging && css.explorerRowDragging,
        dropTarget && css.explorerRowDropTarget,
        revealed && css.explorerRowRevealed,
      )}
      data-dsh-revealed={revealed ? 'true' : undefined}
      data-dsh-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      style={{ paddingLeft: depth * 22 + 6 }}
      title={entry.broken ? `${entry.path} — ${t('brokenSymlink')}` : entry.path}
      onClick={(event) => { actions.activate(event, entry.path, false) }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          actions.activate(event, entry.path, false)
        }
      }}
      onDragOver={(event) => { actions.dragOver(event, parentOf(entry.path)) }}
      onDrop={(event) => { actions.drop(event, entry.path, false) }}
      onContextMenu={(event) => { actions.contextMenu(event, entry.path, false) }}
    >
      {icon}
      <span className={clsx(css.explorerName, gitTone !== undefined && css.explorerGitName)} data-git-tone={gitTone}>
        {entry.name}
      </span>
      {entry.isSymlink && <IconLinkOutlineRegular size={12} className={css.explorerSymlink} />}
      {gitTone !== undefined && gitLetter !== undefined && (
        <StatusBadge tone={badgeToneOf(gitTone)} title={gitToneLabel(gitTone)}>{gitLetter}</StatusBadge>
      )}
      {copied
        ? <span className={css.explorerCopied}>{t('copied')}</span>
        : (
          <button
            type="button"
            className={css.explorerRef}
            aria-label={t('referenceFile')}
            title={t('referenceFile')}
            onClick={(event) => {
              event.stopPropagation()
              actions.reference(entry.path, false)
            }}
          >
            {t('referenceFile')}
          </button>
        )}
    </div>
  )
})

/** One directory row's props (same stability rules as {@link FileRowProps}). */
interface DirRowProps {
  entry: FsEntry
  depth: number
  expanded: boolean
  iconsVersion: number
  service: BetterSidebarService | undefined
  selected: boolean
  dragging?: boolean
  revealed: boolean
  dropTarget: boolean
  /** A change exists at or below this directory (tinted, never lettered). */
  gitChanged: boolean
  copied: boolean
  actions: RowActions
}

const DirRow = memo(function DirRow(props: DirRowProps): ReactNode {
  const { entry, depth, expanded, iconsVersion, service, selected, revealed, dropTarget, gitChanged, copied, actions } = props
  void iconsVersion
  const icon = service !== undefined ? service.folderIcon(entry.path, expanded, 14) : builtinFolderIcon(expanded, 14)
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(event) => { actions.dragStart(event, entry.path, entry.isDir) }}
      onDragEnd={() => { actions.dragEnd() }}
      className={clsx(
        css.explorerRow, entry.hidden && css.explorerHidden,
        selected && css.explorerRowSelected,
        props.dragging && css.explorerRowDragging,
        dropTarget && css.explorerRowDropTarget,
        revealed && css.explorerRowRevealed,
      )}
      data-dsh-revealed={revealed ? 'true' : undefined}
      data-dsh-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      style={{ paddingLeft: depth * 22 + 6 }}
      onClick={(event) => { actions.activate(event, entry.path, true) }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          actions.activate(event, entry.path, true)
        }
      }}
      onDragOver={(event) => { actions.dragOver(event, entry.path) }}
      onDrop={(event) => { actions.drop(event, entry.path, true) }}
      onContextMenu={(event) => { actions.contextMenu(event, entry.path, true) }}
    >
      {icon}
      <span className={clsx(css.explorerName, gitChanged && css.explorerDirChanged)}>{entry.name}</span>
      {entry.isSymlink && <IconLinkOutlineRegular size={12} className={css.explorerSymlink} />}
      {copied
        ? <span className={css.explorerCopied}>{t('copied')}</span>
        : (
          <button
            type="button"
            className={css.explorerRef}
            aria-label={t('referenceFile')}
            title={t('referenceFile')}
            onClick={(event) => {
              event.stopPropagation()
              actions.reference(entry.path, true)
            }}
          >
            {t('referenceFile')}
          </button>
        )}
    </div>
  )
})

/**
 * The workspace ROOT row (the session's own folder). Memoized like the other
 * rows: it has no name/selection churn, so a parent re-render (menu state, copy
 * flash, apps) must not re-resolve its glyph either.
 */
interface RootRowProps {
  path: string
  iconsVersion: number
  service: BetterSidebarService | undefined
  /** A drag hovers the workspace root (drop target). */
  dropTarget: boolean
  /** A change exists at or below the root (tinted). */
  gitChanged: boolean
  copied: boolean
  actions: RowActions
}

const RootRow = memo(function RootRow(props: RootRowProps): ReactNode {
  const { path, iconsVersion, service, dropTarget, gitChanged, copied, actions } = props
  void iconsVersion
  const icon = service !== undefined ? service.folderIcon(path, true, 14) : builtinFolderIcon(true, 14)
  return (
    <div
      className={clsx(css.explorerRow, dropTarget && css.explorerRowDropTarget)}
      style={{ paddingLeft: 6 }}
      onDragOver={(event) => { actions.dragOver(event, path) }}
      onDrop={(event) => { actions.drop(event, path, true) }}
      onContextMenu={(event) => { actions.contextMenu(event, path, true) }}
    >
      {icon}
      <span className={clsx(css.explorerName, gitChanged && css.explorerDirChanged)}>{baseName(path)}</span>
      {copied
        ? <span className={css.explorerCopied}>{t('copied')}</span>
        : (
          <button
            type="button"
            className={css.explorerRef}
            aria-label={t('referenceFile')}
            title={t('referenceFile')}
            onClick={(event) => {
              event.stopPropagation()
              actions.reference(path, true)
            }}
          >
            {t('referenceFile')}
          </button>
        )}
    </div>
  )
})

export function FileTree(props: {
  /** Legacy caller shape; expansion is now owned by the session store. */
  store?: import('./state.ts').SidebarStore
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  /** Files highlighted by a "Show in folder" reveal (absolute paths). */
  revealed: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Context-menu "open in a new tab" (file rows; absent → no entry). */
  onOpenFileNewTab?: (path: string) => void
  /** Context-menu "open to the side" (file rows; absent → no entry). */
  onOpenFileSide?: (path: string) => void
  /**
   * The host's open-in-app handle (EditorHost builds it and injects it).
   * Absent, or reporting the host cannot hand paths to the desktop, hides the
   * HOST half of the "打开方式" section (the plugin's own targets stay).
   */
  openInApp?: OpenInApp
  /**
   * The PLUGIN's own "open with" menu: resolved external targets (already
   * SSH-filtered and in menu order). Absent → no plugin half. Coexists with
   * {@link openInApp} — the section lists both.
   */
  openWithTargets?: OpenWithTarget[]
  /** Ids of targets pinned to the menu's top level (subset of the ids). */
  openWithPinned?: string[]
  /** Whether the workspace is remote (appends the SSH hint to target labels). */
  openWithSsh?: boolean
  /** Open one plugin target externally (reveal or URL — the caller decides). */
  onOpenWith?: (targetId: string, path: string) => void
  /** Toggle one plugin target's pinned state (the submenu row's pushpin). */
  onToggleOpenWithPin?: (targetId: string) => void
  /** Insert `@<relative path>` into the composer draft (file vs directory). */
  onReferenceFile: (path: string, isDir: boolean) => void
  /** A rename landed (old row path → new path): the caller retargets open tabs. */
  onPathRenamed?: (oldPath: string, newPath: string) => void
  /** A delete landed: the caller closes tabs at or under the removed path. */
  onPathDeleted?: (path: string, isDir: boolean) => void
  /** Bump to wipe the level cache and reload the visible set. */
  refreshTick: number
  /** Upload into `dir` (absolute, inside the workspace); runs in the caller. */
  onUploadRequest: (dir: string, items: UploadItem[]) => void
  /** True while an upload is in flight (drops are ignored). */
  busy: boolean
  /**
   * Park the tree out of the layout WITHOUT unmounting it: the search results
   * panel takes the surface while the level cache (and the live watcher) stays
   * warm, so clearing the query is free.
   */
  hidden?: boolean
  /**
   * Whether the owning tab is on screen. Defaults to true; a parked tab
   * passes false so the shared git-status store stops polling for rows
   * nobody can see (the workbench keeps every tab body mounted).
   */
  visible?: boolean
  /**
   * Keep the plugin's own open-with targets in the "打开方式" submenu even when
   * the host reports local applications for the path. Default (false): the
   * host's own list wins, and the plugin's fixed targets (file manager /
   * VS Code / Cursor / Zed / custom editors) show only when the host cannot
   * offer any — so the menu is not two near-identical lists. The caller reads
   * the `openWithPluginTargets` plugin setting and passes it down.
   */
  openWithShowPluginTargets?: boolean
  /**
   * The sidebar registry service: when present, externally registered file
   * icons (`registerFileIcon`) outrank the host's file-type artwork on file rows.
   * Absent → the built-ins alone (the host always passes it today).
   */
  service?: BetterSidebarService
}) {
  // `onToggle` / `onOpenFile` are read through `propsRef` (the stable row
  // callbacks must not change identity when the caller re-renders).
  // `onReferenceFile` is read through `propsRef` like the other row callbacks.
  const {
    sessionId, cwd, expanded, revealed, onOpenFileNewTab, onOpenFileSide,
    openInApp, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin,
    openWithShowPluginTargets,
    onPathRenamed, onPathDeleted, refreshTick, onUploadRequest, busy, hidden, visible, service,
  } = props
  /** The live props for the stable callbacks below (identity churns per render). */
  const propsRef = useRef(props)
  propsRef.current = props
  const { onToggle, onReferenceFile } = props
  const fileTreeUi = useFileTreeUi()
  const [data, setData] = useState<Record<string, LevelData>>({})
  /**
   * Registry revision for the file-icon feature: bumps on ANY registry
   * change (register/dispose of tabs, viewers, or icons — one listener
   * set) so rows re-resolve their icons. Handed to the memoized rows as a
   * prop precisely so the bump reaches them.
   */
  const [iconsVersion, setIconsVersion] = useState(0)
  useEffect(
    () => service?.subscribe(() => { setIconsVersion(version => version + 1) }),
    [service],
  )
  /** One directory's leading glyph for the surfaces WITHOUT a memoized row
   *  (the inline rename and new-folder editors). */
  const dirRowIcon = (path: string, open: boolean): ReactNode =>
    service !== undefined ? service.folderIcon(path, open, 14) : builtinFolderIcon(open, 14)
  const dataRef = useRef(data)
  /** Bumped whenever the cache is wiped: a response from an older generation is dropped. */
  const generationRef = useRef(0)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  // The plugin submenu can tower past the viewport; publish its flip geometry
  // for layout.css while the row menu is open.
  useSubmenuFlip(rowMenu)
  /** The open-in-app rows for the open menu (null entries = listing failed). */
  const [apps, setApps] = useState<{ path: string; entries: readonly OpenInAppEntry[] | null } | null>(null)
  /** The row being renamed inline: its path plus the edit buffer. */
  const [renaming, setRenaming] = useState<{ path: string; value: string; isDir: boolean } | null>(null)
  /** The inline new-folder editor: the directory it inserts into plus the buffer. */
  const [newFolder, setNewFolder] = useState<{ dir: string; value: string } | null>(null)
  /** The delete awaiting the confirmation modal's yes (single row). */
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; isDir: boolean; name: string } | null>(null)
  /** The batch delete awaiting the confirmation modal's yes. */
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false)
  /** True while the batch delete walks its paths (locks the dialog). */
  const [deletingSelected, setDeletingSelected] = useState(false)
  /** The last mutation failure (dismissable strip above the tree). */
  const [actionError, setActionError] = useState<string | null>(null)
  /** A failed re-list that kept the previous rows on screen (hint line). */
  const [loadError, setLoadError] = useState<string | null>(null)
  /** The multi-selection (absolute paths) and its Shift anchor. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchorRef = useRef<string | null>(null)
  /** Whether a dragged-over state exists at all (drives the portaled drop zone). */
  const [dropOver, setDropOver] = useState(false)
  /** The directory a drag is hovering right now (null = body, drop to root). */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** The row being dragged in an IN-TREE drag (ref; the value is read by the
   *  drop handlers and must never trigger renders mid-drag). */
  const dragSource = useRef<{ path: string; isDir: boolean } | null>(null)
  /** The dragged row's path, for the dimming visual (state so the class
   *  re-renders; cleared on dragend/drop). */
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  /**
   * Enter/leave depth under the tree body. dragenter/dragleave fire per
   * element along the drag path (and bubble), so a counter — DSH InputBar's
   * own pattern — is the flicker-free signal; relatedTarget is unreliable
   * across engines for drag events.
   */
  const dropDepth = useRef(0)
  /** Explorer body element; its viewport rect anchors the portaled drop zone. */
  const bodyRef = useRef<HTMLDivElement>(null)
  /** The body's viewport rect captured at drag entry (null = not measured). */
  const [dropRect, setDropRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  /** Context-menu "upload here" target directory. */
  const pendingUploadDir = useRef<string | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** Reset all drag state (drop landed, the drag left, or a new drag begins). */
  const resetDrop = useCallback((): void => {
    dropDepth.current = 0
    setDropOver(false)
    setDropTarget(null)
    setDropRect(null)
  }, [])

  /**
   * Drop handlers: always swallow the event (a dropped file must never open
   * in the browser), then report the target directory to the caller. A drop
   * ends the drag without further leave events, so the depth resets here.
   * The payload collection is async (dropped folders are traversed through
   * their entry handles — captured synchronously inside uploadItemsFromDrop
   * while the dataTransfer is still live), so the request rides a then.
   */
  const reportDrop = useCallback((dir: string, transfer: DataTransfer | undefined): void => {
    if (propsRef.current.busy) return
    void uploadItemsFromDrop(transfer).then((items) => {
      if (items.length > 0) propsRef.current.onUploadRequest(dir, items)
    })
  }, [])

  /** Forget the in-tree drag source (drop landed or the drag ended). */
  const clearDragSource = useCallback((): void => {
    dragSource.current = null
    setDraggingPath(null)
  }, [])

  /**
   * Drag-state hygiene for drags that never deliver their terminal event
   * (Electron: an in-tree drag released outside the window, an Escape
   * cancel that loses `dragend`, an OS drag that leaves the app and skips
   * `dragleave`). A window blur is the authoritative "the drag cannot land
   * here anymore" signal — everything the drag left behind (the dimmed
   * source row, the drop-target highlight, the upload drop overlay) is
   * cleared so a reload is never the only way back. The handlers only touch
   * refs and setters, so the first-render closures stay valid for the
   * component's whole life.
   */
  useEffect(() => {
    const clear = (): void => { clearDragSource(); resetDrop() }
    window.addEventListener('blur', clear)
    return () => { window.removeEventListener('blur', clear) }
  }, [clearDragSource, resetDrop])

  /**
   * Whether an in-tree drag may land on `dir`: not the row itself, not a
   * directory's own descendant (both are catastrophes), and — for MOVES —
   * not the row's current directory (a same-directory move is nothing; a
   * same-directory COPY is allowed, colliding on the server's
   * destination-exists 409). The server re-validates on real paths, so this
   * is a cheap pre-filter, not the authority.
   */
  const canDropInto = (source: { path: string; isDir: boolean }, dir: string, isCopy: boolean): boolean => {
    if (source.path === dir) return false
    if (source.isDir && isWithinWorkspace(source.path, dir)) return false
    if (!isCopy && parentOf(source.path) === dir) return false
    return true
  }

  /**
   * Settle both sides after a transfer landed: the old side is pruned like a
   * rename (cache, expanded, parent reload); the destination directory's
   * cached level reloads too when it differs from the old parent (a move
   * rewrites TWO levels — the old row goes missing from one listing, the new
   * row appears in another).
   */
  const settleTransfer = (oldPath: string, newPath: string): void => {
    pruneTree(oldPath)
    const destDir = parentOf(newPath)
    if (destDir !== parentOf(oldPath)) retryDir(destDir)
  }

  /** The drag-drop move/copy itself: validate, mutate on the host, settle
   *  the tree, retarget tabs (moves), and record the undo entry. */
  const performDrag = (source: { path: string; isDir: boolean }, dir: string, isCopy: boolean): void => {
    if (cwd === undefined || !canDropInto(source, dir, isCopy)) return
    const from = source.path
    if (isCopy) {
      api.fsCopy({ sessionId, cwd }, from, dir)
        .then((result) => {
          setActionError(null)
          pruneTree(result.path)
          pushTreeOp(sessionId, cwd, { kind: 'copy', from, to: result.path })
        })
        .catch((error: unknown) => {
          setActionError(error instanceof Error ? error.message : String(error))
        })
      return
    }
    api.fsMove({ sessionId, cwd }, from, dir)
      .then((result) => {
        setActionError(null)
        settleTransfer(from, result.path)
        onPathRenamed?.(from, result.path)
        pushTreeOp(sessionId, cwd, { kind: 'move', from, to: result.path, isDir: source.isDir })
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  const handleBodyDrop = (event: DragEvent): void => {
    if (isTreeDrag(event)) {
      event.preventDefault()
      event.stopPropagation()
      resetDrop()
      const source = dragSource.current
      clearDragSource()
      if (cwd !== undefined && source !== null) performDrag(source, cwd, event.altKey)
      return
    }
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    resetDrop()
    if (cwd !== undefined) reportDrop(cwd, event.dataTransfer)
  }
  const handleDirDrop = (event: DragEvent, dir: string): void => {
    if (isTreeDrag(event)) {
      event.preventDefault()
      event.stopPropagation()
      resetDrop()
      const source = dragSource.current
      clearDragSource()
      if (source !== null) performDrag(source, dir, event.altKey)
      return
    }
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    resetDrop()
    reportDrop(dir, event.dataTransfer)
  }
  const handleFileDrop = (event: DragEvent, path: string): void => {
    // VSCode semantics: dropping onto a file targets its parent directory
    // (uploads into it; in-tree drags move/copy into it).
    handleDirDrop(event, parentOf(path))
  }
  const handleBodyDragEnter = (event: DragEvent): void => {
    if (isTreeDrag(event)) {
      // No upload overlay for in-tree drags: the rows themselves are the
      // targets and the source row is already dimmed by draggingPath.
      event.preventDefault()
      return
    }
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    dropDepth.current += 1
    if (propsRef.current.busy) return
    // First entry: anchor the portaled drop zone to the body's rect.
    if (dropDepth.current === 1) {
      const rect = bodyRef.current?.getBoundingClientRect()
      setDropRect(rect === undefined ? null : { top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }
    setDropOver(true)
  }
  const handleBodyDragLeave = useCallback((): void => {
    dropDepth.current = Math.max(0, dropDepth.current - 1)
    if (dropDepth.current > 0) return
    setDropOver(false)
    setDropTarget(null)
    setDropRect(null)
  }, [])
  const handleBodyDragOver = (event: DragEvent): void => {
    if (isTreeDrag(event)) {
      event.preventDefault()
      event.stopPropagation()
      const source = dragSource.current
      const isCopy = event.altKey
      event.dataTransfer.dropEffect = cwd !== undefined && source !== null && canDropInto(source, cwd, isCopy)
        ? (isCopy ? 'copy' : 'move')
        : 'none'
      // Rows stop propagation: over the body the drag targets the workspace
      // root, so no row stays highlighted (see the file-drag branch below).
      setDropTarget(null)
      return
    }
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = propsRef.current.busy ? 'none' : 'copy'
    if (propsRef.current.busy) return
    // Rows stop propagation, so this only fires over non-row regions: the
    // drag targets the workspace root. dragover fires continuously, making
    // it the authoritative (flicker-free) place to clear the row target.
    setDropTarget(null)
  }
  const handleRowDragOver = (event: DragEvent, dir: string): void => {
    if (isTreeDrag(event)) {
      event.preventDefault()
      event.stopPropagation()
      const source = dragSource.current
      const isCopy = event.altKey
      if (source !== null && canDropInto(source, dir, isCopy)) {
        event.dataTransfer.dropEffect = isCopy ? 'copy' : 'move'
        setDropTarget(dir)
      } else {
        event.dataTransfer.dropEffect = 'none'
        setDropTarget(null)
      }
      return
    }
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = propsRef.current.busy ? 'none' : 'copy'
    if (propsRef.current.busy) return
    setDropTarget(dir)
  }


  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  /**
   * List a SET of directories into the cache with ONE `fs.trees` request.
   *
   * The visible set (the workspace root plus every expanded directory) is
   * always loaded this way, so mounting the tree, a refresh tick and expanding
   * a directory each cost exactly one POST — not one per level (the N+1 the
   * file list was reported for). Levels already loaded (including the empty
   * placeholder of an in-flight fetch) are left alone, so an expand only asks
   * for what is genuinely missing; a stale response — the cache was wiped by a
   * refresh tick — is dropped instead of overwriting fresher data.
   *
   * A level the host failed to read comes back with its own `error` and is
   * stored on that level alone (the other levels render normally). When the
   * WHOLE request fails, the levels that already had a listing keep it (plus a
   * hint) and only the levels with nothing to show carry the message.
   *
   * `force` re-lists levels even when they are cached — the refresh tick's
   * path — while leaving their current rows untouched until the answer lands.
   */
  const loadLevels = useCallback((paths: readonly string[], options?: { force?: boolean }) => {
    const force = options?.force === true
    const wanted = force
      ? [...new Set(paths)]
      : paths.filter(path => dataRef.current[path] === undefined)
    if (wanted.length === 0) return
    const generation = generationRef.current
    // A FORCED re-list (a refresh tick) keeps the listing on screen until the
    // fresh one arrives: no blank frame, and a failed refresh degrades to the
    // previous listing plus a hint instead of an empty tree.
    if (!force) for (const path of wanted) storeLevel(path, {})
    // The route takes no signal: the GENERATION counter is the staleness guard
    // (a refresh tick or an unmount bumps it, so a late answer is dropped).
    api.fsTrees({ sessionId, cwd }, wanted).then((result) => {
      if (generation !== generationRef.current) return
      setLoadError(null)
      for (const level of result.levels) {
        storeLevel(level.path, {
          entries: level.entries,
          truncated: level.truncated,
          ...(level.error !== undefined ? { error: level.error } : {}),
        })
      }
    }).catch((error: unknown) => {
      if (generation !== generationRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      let keptListing = false
      for (const path of wanted) {
        const level = dataRef.current[path]
        if (level?.entries !== undefined) {
          keptListing = true
          continue
        }
        storeLevel(path, { error: message })
      }
      // Levels that had a listing keep it; the hint explains why they are not
      // fresher. With nothing to keep, the per-level rows already say it.
      setLoadError(keptListing ? message : null)
    })
  }, [sessionId, cwd, storeLevel])

  /**
   * Re-list one directory in place (a watch notice, or the parent of a landed
   * mutation).
   *
   * The re-list is FORCED but not preceded by dropping the level: a watch
   * notice usually lands while the directory is on screen with its rows, and
   * deleting the cached level first replaced every row with a "Loading…"
   * placeholder — the whole folder blinked and rebuilt on each disk change
   * (a build, a formatter, the model's own `bash`). The fresh listing simply
   * overwrites the old one when it arrives; a failed re-list keeps the rows it
   * has and adds the hint line.
   */
  const retryDir = useCallback((dir: string) => {
    loadLevels([dir], { force: true })
  }, [loadLevels])

  /**
   * Settle the tree after one rename/delete landed at `prefix`: drop every
   * cached level at or under the old path, collapse the now-stale expanded
   * directories below it, and reload the immediate parent so the new shape
   * shows without a full refresh tick.
   */
  const pruneTree = useCallback((prefix: string): void => {
    const parent = parentOf(prefix)
    const under = (key: string): boolean => key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}\\`)
    for (const key of Object.keys(dataRef.current)) {
      if (under(key)) delete dataRef.current[key]
    }
    if (parent !== prefix) delete dataRef.current[parent]
    setData({ ...dataRef.current })
    for (const dir of propsRef.current.expanded) {
      if (under(dir)) propsRef.current.onToggle(dir)
    }
    if (parent !== prefix) retryDir(parent)
  }, [retryDir])

  /** Client-side twin of the server's name rule (the server re-validates). */
  const validName = (name: string): boolean =>
    name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')

  /** Commit the inline rename: trim, no-op guard, then fs.rename + settle. */
  const commitRename = (path: string, raw: string, isDir: boolean): void => {
    setRenaming(null)
    const name = raw.trim()
    if (cwd === undefined || name === baseName(path) || !validName(name)) {
      if (name !== baseName(path) && !validName(name)) setActionError(t('renameInvalid'))
      return
    }
    api.fsRename({ sessionId, cwd }, path, name)
      .then((result) => {
        setActionError(null)
        pruneTree(path)
        onPathRenamed?.(path, result.path)
        pushTreeOp(sessionId, cwd, { kind: 'rename', from: path, to: result.path, isDir })
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  /**
   * The undo/redo executor. `entry` is the mutation that was PERFORMED
   * (already moved to the opposite stack by undoTreeOp/redoTreeOp); undoing
   * runs the INVERSE (`reverse=true`), redoing replays it. On success the
   * tree settles exactly like the original mutation and tabs retarget; on a
   * wire failure the entry is returned to its source stack (the error strip
   * shows the host's reason) so the user can retry.
   */
  const runUndoRedo = (op: TreeMutationOp, reverse: boolean): void => {
    if (cwd === undefined) return
    const scope = { sessionId, cwd }
    const settle = (newPath: string): void => {
      if (op.kind === 'copy') {
        pruneTree(newPath)
        return
      }
      // Rename/move: the row moved from `from` to `to` (either direction).
      const from = reverse ? op.to : op.from
      settleTransfer(from, newPath)
      onPathRenamed?.(from, newPath)
    }
    const run = (): Promise<{ path: string }> => {
      if (op.kind === 'rename') {
        return reverse
          ? api.fsRename(scope, op.to, baseName(op.from))
          : api.fsRename(scope, op.from, baseName(op.to))
      }
      const destDir = reverse ? parentOf(op.from) : parentOf(op.to)
      if (op.kind === 'move') return api.fsMove(scope, reverse ? op.to : op.from, destDir)
      return reverse ? api.fsRemove(scope, op.to) : api.fsCopy(scope, op.from, destDir)
    }
    run()
      .then((result) => {
        setActionError(null)
        settle(result.path)
      })
      .catch((error: unknown) => {
        returnTreeOp(sessionId, cwd, op, reverse ? 'undo' : 'redo')
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  const runUndo = (): void => {
    if (cwd === undefined) return
    const op = undoTreeOp(sessionId, cwd)
    if (op !== undefined) runUndoRedo(op, true)
  }

  const runRedo = (): void => {
    if (cwd === undefined) return
    const op = redoTreeOp(sessionId, cwd)
    if (op !== undefined) runUndoRedo(op, false)
  }

  // The caller's refresh tick invalidates every in-flight response (a slow
  // answer for the old generation can never land on top of the fresh listing)
  // and flags the next load as FORCED: the visible levels are re-listed in one
  // batch, but their current rows stay on screen until the answer arrives.
  // Declared BEFORE the load effect so that effect sees the flag.
  const lastTick = useRef(refreshTick)
  const forceNextLoad = useRef(false)
  useEffect(() => {
    if (lastTick.current === refreshTick) return
    lastTick.current = refreshTick
    generationRef.current += 1
    forceNextLoad.current = true
  }, [refreshTick])

  useEffect(() => {
    // Load the visible set in ONE batch request; already-loaded levels (kept
    // in the cache) are not refetched, so this asks only for what is new — a
    // refresh tick re-lists root + every expanded directory in one POST.
    const root = cwd
    if (root === undefined) return
    const force = forceNextLoad.current
    forceNextLoad.current = false
    loadLevels([root, ...expanded], { force })
  }, [cwd, expanded, refreshTick, loadLevels])

  // A torn-down tree must not write the answer of an in-flight batch into a
  // dead component: bumping the generation makes every late response stale.
  useEffect(() => () => { generationRef.current += 1 }, [])

  // Live refresh: the host watches the folders this tree has expanded and
  // names the one that changed, so exactly that level is dropped and
  // re-listed instead of the whole tree. Without it a folder listed once when
  // it was opened stayed stale for the rest of the session.
  useDirectoryWatch({
    sessionId,
    root: cwd,
    dirs: expanded,
    onStale: retryDir,
  })

  // Bring a "Show in folder" reveal into view: the ancestors expand above
  // (revealPaths), but the row may not be scrolled into sight — a reveal on
  // a long tree should surface the highlighted file. Re-runs when the tree
  // data or reveal set changes (the row appears after its level loads).
  // Scrolls ONLY this tree's body: scrollIntoView would scroll every
  // scrollable ancestor, and the clipping panel host
  // ([data-dsh-panel-host]) is still programmatically scrollable — a deep
  // reveal shifted the whole panel, tab bar included, out of the viewport.
  useEffect(() => {
    if (revealed.length === 0 || propsRef.current.hidden === true) return
    const body = bodyRef.current
    if (body === null) return
    // The built-in rows carry the marker attribute; the framework rows
    // (v2 service path) carry the hashed reveal class instead — both
    // resolve to the revealed row element.
    const row = body.querySelector<HTMLElement>('[data-dsh-revealed]')
      ?? body.querySelector<HTMLElement>('[class*="explorerRowRevealed"]')
    if (row === null) return
    const bodyTop = body.getBoundingClientRect().top
    const rowRect = row.getBoundingClientRect()
    const target = body.scrollTop + (rowRect.top + rowRect.height / 2) - (bodyTop + body.clientHeight / 2)
    const max = Math.max(body.scrollHeight - body.clientHeight, 0)
    body.scrollTo({ top: Math.min(Math.max(target, 0), max), behavior: 'smooth' })
  }, [revealed, data])

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

  // ── Multi-selection ────────────────────────────────────────────────────
  /** The selection's mirror for the stable callbacks (state itself re-renders). */
  const selectedRef = useRef(selected)
  /** Path → whether the row is a directory (the delete callback needs it). */
  const kindRef = useRef(new Map<string, boolean>())
  /** The visible rows in depth-first order: the Shift range's coordinate space. */
  const visibleRowsRef = useRef<{ path: string; isDir: boolean }[]>([])
  /** The expanded set for the stable callbacks. */
  const expandedSetRef = useRef<Set<string>>(new Set())

  const setSelection = useCallback((next: Set<string>): void => {
    selectedRef.current = next
    setSelected(next)
  }, [])

  /** Ctrl/Cmd+click: toggle one row and move the Shift anchor onto it. */
  const toggleSelect = useCallback((path: string, isDir: boolean): void => {
    const next = new Set(selectedRef.current)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      kindRef.current.set(path, isDir)
    }
    anchorRef.current = path
    setSelection(next)
  }, [setSelection])

  /** Shift+click: select the visible range between the anchor and the row. */
  const selectRange = useCallback((path: string, isDir: boolean): void => {
    const rows = visibleRowsRef.current
    const anchor = anchorRef.current
    const from = anchor === null ? -1 : rows.findIndex(row => row.path === anchor)
    const to = rows.findIndex(row => row.path === path)
    // No usable anchor (or a row that scrolled out of the tree): behave like
    // a plain Ctrl click, which also re-seats the anchor.
    if (from === -1 || to === -1) {
      toggleSelect(path, isDir)
      return
    }
    const low = Math.min(from, to)
    const high = Math.max(from, to)
    const next = new Set(selectedRef.current)
    for (let index = low; index <= high; index += 1) {
      const row = rows[index]!
      next.add(row.path)
      kindRef.current.set(row.path, row.isDir)
    }
    // The anchor stays put: a second Shift+click re-ranges from the same start.
    setSelection(next)
  }, [setSelection, toggleSelect])

  const clearSelection = useCallback((): void => {
    if (selectedRef.current.size === 0) return
    anchorRef.current = null
    setSelection(new Set())
  }, [setSelection])

  const copySelectedPaths = useCallback((): void => {
    void writeClipboard([...selectedRef.current].join('\n'))
  }, [])

  /** Run the confirmed single-row delete: fs.remove + settle + close tabs. */
  const performDelete = (target: { path: string; isDir: boolean }): void => {
    if (cwd === undefined) return
    api.fsRemove({ sessionId, cwd }, target.path)
      .then(() => {
        setActionError(null)
        pruneTree(target.path)
        onPathDeleted?.(target.path, target.isDir)
        anchorRef.current = null
        setSelection(new Set())
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  // ── Stable row actions ─────────────────────────────────────────────────
  const handleActivate = useCallback((event: ActivateModifiers, path: string, isDir: boolean): void => {
    if (event.ctrlKey || event.metaKey) {
      toggleSelect(path, isDir)
      return
    }
    if (event.shiftKey) {
      selectRange(path, isDir)
      return
    }
    // Plain click: the original semantics, plus dropping any selection.
    clearSelection()
    if (isDir) propsRef.current.onToggle(path)
    else propsRef.current.onOpenFile(path)
  }, [clearSelection, selectRange, toggleSelect])

  const handleContextMenu = useCallback((event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, path: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    // VSCode semantics: right-clicking outside the selection collapses it
    // onto the row; right-clicking INSIDE it keeps the whole batch.
    if (!selectedRef.current.has(path)) {
      anchorRef.current = path
      kindRef.current.set(path, isDir)
      setSelection(new Set([path]))
    }
    // NOTE: the previous menu's app answer is deliberately KEPT — the render
    // only trusts it for the matching path, and dropping it here would cost an
    // extra render (and, on a reopen, a disabled "Loading…" frame).
    setRowMenu({ path, isDir, x: event.clientX, y: event.clientY })
  }, [setSelection])

  const handleReference = useCallback((path: string, isDir: boolean): void => {
    propsRef.current.onReferenceFile(path, isDir)
  }, [])

  const dragHandlers = useRef({ handleRowDragOver, handleDirDrop, clearDragSource, resetDrop })
  dragHandlers.current = { handleRowDragOver, handleDirDrop, clearDragSource, resetDrop }
  const actions = useMemo<RowActions>(() => ({
    dragStart(event, path, isDir) {
      event.dataTransfer.setData('application/x-dsh-tree-drag', path)
      event.dataTransfer.effectAllowed = 'copyMove'
      dragSource.current = { path, isDir }
      setDraggingPath(path)
    },
    dragEnd() { dragHandlers.current.clearDragSource(); dragHandlers.current.resetDrop() },
    activate: handleActivate,
    contextMenu: handleContextMenu,
    reference: handleReference,
    dragOver: (event, dir) => { dragHandlers.current.handleRowDragOver(event, dir) },
    drop: (event, path, isDir) => { dragHandlers.current.handleDirDrop(event, isDir ? path : parentOf(path)) },
  }), [handleActivate, handleContextMenu, handleReference])

  // ── New folder ─────────────────────────────────────────────────────────
  const newFolderRef = useRef(newFolder)
  newFolderRef.current = newFolder

  /** Open the inline editor at the TOP of `dir`'s level (expanding it first). */
  const startNewFolder = (dir: string): void => {
    const live = propsRef.current
    if (live.cwd !== undefined && dir !== live.cwd && !expandedSetRef.current.has(dir)) live.onToggle(dir)
    setNewFolder({ dir, value: '' })
  }

  /**
   * Commit the inline new-folder name: Enter, blur, or the editor's own
   * cancel path. The ref guard makes the commit idempotent — a blur that
   * lands after Enter must not fire a second mkdir.
   */
  const commitNewFolder = (dir: string, raw: string): void => {
    if (newFolderRef.current === null) return
    newFolderRef.current = null
    setNewFolder(null)
    const name = raw.trim()
    const live = propsRef.current
    if (live.cwd === undefined) return
    if (!validName(name)) {
      setActionError(t('newFolderInvalid'))
      return
    }
    api.fsMkdir({ sessionId: live.sessionId, cwd: live.cwd }, dir, name)
      .then(() => {
        setActionError(null)
        if (dir !== live.cwd && !expandedSetRef.current.has(dir)) live.onToggle(dir)
        retryDir(dir)
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  const cancelNewFolder = (): void => {
    newFolderRef.current = null
    setNewFolder(null)
  }

  // ── Batch delete ───────────────────────────────────────────────────────
  /**
   * Delete every selected row, ONE AT A TIME (the host refuses nothing here,
   * but a partial batch must be debuggable). The first failure stops the walk
   * and lands in the error strip; already-removed rows settle as they go.
   */
  const performBatchDelete = (): void => {
    const live = propsRef.current
    if (live.cwd === undefined || deletingSelected) return
    const paths = [...selectedRef.current]
    setConfirmDeleteSelected(false)
    if (paths.length === 0) return
    const scope = { sessionId: live.sessionId, cwd: live.cwd }
    setDeletingSelected(true)
    void (async () => {
      const removed: string[] = []
      for (const path of paths) {
        try {
          await api.fsRemove(scope, path)
        } catch (error: unknown) {
          setActionError(error instanceof Error ? error.message : String(error))
          // Keep the rows that were NOT removed selected, so a retry is one click.
          const next = new Set(selectedRef.current)
          for (const done of removed) next.delete(done)
          setSelection(next)
          setDeletingSelected(false)
          return
        }
        setActionError(null)
        pruneTree(path)
        live.onPathDeleted?.(path, kindRef.current.get(path) ?? false)
        removed.push(path)
      }
      setDeletingSelected(false)
      clearSelection()
    })()
  }

  // ── Open in app ────────────────────────────────────────────────────────
  /** Report one failed hand-off (open / reveal / app listing) in the strip. */
  const reportOpenFailure = useCallback((path: string): void => {
    setActionError(t('openInAppFailed', { path }))
  }, [])

  /**
   * Whether the host can hand paths to a native desktop — probed ONCE per
   * handle, on mount. The adapter starts in its `null` (unprobed) state, and
   * only the probe publishes the answer, so the menu reads this state instead
   * of the tri-state getter: reading `available()` alone left the whole
   * section permanently invisible (nothing ever probed).
   */
  const [appReady, setAppReady] = useState(() => openInApp?.available() === true)

  useEffect(() => {
    if (openInApp === undefined) {
      setAppReady(false)
      return
    }
    // An answer the handle already carries is authoritative; only the
    // unprobed (`null`) state needs the probe.
    const known = openInApp.available()
    if (known !== null) {
      setAppReady(known)
      return
    }
    let cancelled = false
    void openInApp.probe().then((ok) => {
      if (!cancelled) setAppReady(ok)
    }).catch(() => {
      if (!cancelled) setAppReady(false)
    })
    return () => { cancelled = true }
  }, [openInApp])

  /**
   * The host's application list, CACHED per path (the successful answers only;
   * a failed listing is retried on the next open). The list is a property of
   * the machine + the path, so reopening the same row's menu is instant: no
   * request, no disabled "Loading…" frame. A newly installed application shows
   * up on the next tree mount — the alternative (re-probing per open) is the
   * churn the menu was reported for.
   */
  const appsCacheRef = useRef(new Map<string, readonly OpenInAppEntry[]>())
  useEffect(() => {
    if (rowMenu === null || openInApp === undefined || !appReady) return
    const { path, isDir } = rowMenu
    const key = `${isDir ? 'd' : 'f'}\u0000${path}`
    const cached = appsCacheRef.current.get(key)
    if (cached !== undefined) {
      // Already answered for this path: publish it without a null frame (the
      // submenu never flashes its disabled "Loading…" row on a reopen).
      setApps({ path, entries: cached })
      return
    }
    let cancelled = false
    const listing = isDir ? openInApp.directoryApps() : openInApp.fileApps(path)
    void listing.then((entries) => {
      if (cancelled) return
      if (entries !== null) appsCacheRef.current.set(key, entries)
      setApps({ path, entries })
      if (entries === null) reportOpenFailure(path)
    }).catch(() => {
      if (cancelled) return
      setApps({ path, entries: null })
      reportOpenFailure(path)
    })
    return () => { cancelled = true }
  }, [rowMenu, openInApp, appReady, reportOpenFailure])

  const openWithApp = useCallback((path: string, application?: string): void => {
    const handle = propsRef.current.openInApp
    if (handle === undefined) return
    const call = application === undefined ? handle.open(path) : handle.open(path, application)
    void call.then((ok) => { if (!ok) reportOpenFailure(path) }).catch(() => { reportOpenFailure(path) })
  }, [reportOpenFailure])

  const revealPath = useCallback((path: string): void => {
    const handle = propsRef.current.openInApp
    if (handle === undefined) return
    void handle.reveal(path).then((ok) => { if (!ok) reportOpenFailure(path) }).catch(() => { reportOpenFailure(path) })
  }, [reportOpenFailure])

  /** The menu label of one plugin open target: a locale key for the built-ins,
   *  the user's own name for custom editors, plus the SSH hint in remote mode. */
  const openWithLabelOf = (target: OpenWithTarget): string => {
    const name = target.nameKey !== undefined ? t(target.nameKey) : target.name
    return openWithSsh === true && !target.localOnly ? `${name}${t('openWithSshSuffix')}` : name
  }

  /**
   * The plugin's own open-with targets as SUBMENU rows: one row per target with
   * its brand mark, the SSH hint in remote mode, and the pin hot zone (main's
   * interaction). The built-in `explorer` target is dropped while the host is
   * ready — the host's own reveal row replaces it, and two identical "File
   * Manager" rows would be noise; without the host the target stays, so reveal
   * is never lost.
   *
   * Visibility (the user's "有本机检测到的关联应用时就不显示固定的 openwith
   * 项目"): when the host reports applications for THIS path, the plugin rows
   * only appear if the caller turned `openWithShowPluginTargets` on (the
   * `openWithPluginTargets` setting). An unavailable host, or an empty/failed
   * listing, keeps them — that is what makes a remote (SSH) session usable.
   */
  const pluginTargetRows = (hostHasApps: boolean): MenuItem[] => {
    if (openWithTargets === undefined || onOpenWith === undefined) return []
    if (hostHasApps && openWithShowPluginTargets !== true) return []
    const targets = appReady ? openWithTargets.filter(target => target.id !== 'explorer') : openWithTargets
    const pinnedIds = openWithPinned ?? []
    /** Brand marks for the built-ins (monochrome silhouettes, currentColor);
     *  reveal gets the folder glyph, custom editors a generic code mark.
     *  The compact menu's icon slot is 14px, so every mark renders at 14. */
    const itemIcon = (target: OpenWithTarget): ReactNode => {
      if (target.kind === 'reveal') return <VscFolderOpened size={14} />
      if (target.id === 'vscode') return <IconVscode16 size={14} />
      if (target.id === 'cursor') return <SiCursor size={14} />
      if (target.id === 'zed') return <SiZedindustries size={14} />
      return <IconCodeOutlineRegular size={14} />
    }
    return targets.map<MenuItem>(target => {
      const pinnedNow = pinnedIds.includes(target.id)
      return {
        id: `open-with:${target.id}`,
        label: (
          <span className={css.openWithLabel}>
            <span className={css.openWithName}>{openWithLabelOf(target)}</span>
            {/* The pushpin: a PLAIN span, deliberately not a control. The
                Menu renders the row itself as `<button role="menuitem">`, so a
                nested button/imitation-button would be invalid markup — and
                anything with `tabIndex` inside it is unreachable by keyboard
                anyway (the row button swallows focus). It is therefore an
                honest MOUSE hot zone: hovering the row reveals it, clicking it
                pins/unpins without selecting the row (stopPropagation), and it
                keeps a `title` so the affordance is still nameable on hover.
                Keyboard/AT users have a real, reachable path to the same list:
                the plugin settings panel's pinned-targets editor
                (OpenWithSettings). Do not re-add role/tabIndex here without
                also making the row itself non-interactive. */}
            <span
              className={clsx(css.openWithPin, pinnedNow && css.openWithPinActive)}
              title={pinnedNow ? t('unpinOpenWith') : t('pinOpenWith')}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onToggleOpenWithPin?.(target.id)
              }}
            >
              {pinnedNow ? <VscPinned size={12} /> : <VscPin size={12} />}
            </span>
          </span>
        ),
        icon: itemIcon(target),
      }
    })
  }

  /** The host's application list for one path (undefined while it is unknown). */
  const hostEntries = (target: { path: string; isDir: boolean }): readonly OpenInAppEntry[] | null | undefined =>
    apps !== null && apps.path === target.path ? apps.entries : undefined

  /**
   * The submenu behind the "打开方式" row — this menu's ONE place for "open with
   * something else": the host's detected applications (the default handler is
   * hoisted to level 1 for files), then, per the visibility rule above, the
   * plugin's own fixed targets. A pending listing shows one disabled line; an
   * empty/failed listing the disabled `openInAppEmpty` line.
   *
   * Title: the frozen shape asked for a `t('openInApp')` label, but that key no
   * longer exists in the dictionaries (it was removed together with the
   * standalone section it used to head), and `openWithMenu` is the one
   * available synonym ("在应用中打开" / "Open with") — of the two near-duplicate
   * labels the task allowed keeping one, so this is it.
   */
  const openWithSubmenu = (target: { path: string; isDir: boolean }): MenuItem => {
    const entries = hostEntries(target)
    const hostHasApps = entries !== undefined && entries !== null && entries.length > 0
    const rows: MenuItem[] = []
    if (appReady) {
      if (entries === undefined) rows.push({ id: 'open-in-app-loading', label: t('loading'), disabled: true })
      else if (entries === null || entries.length === 0) {
        rows.push({ id: 'open-in-app-empty', label: t('openInAppEmpty'), disabled: true })
      } else {
        for (const entry of entries) {
          // The default handler is the level-1 row for files; directories have
          // no default concept, so every catalogue app stays here.
          if (!target.isDir && entry.isDefault) continue
          rows.push({ id: `open-in-app:${entry.id}`, label: entry.name, icon: <AppGlyph entry={entry} /> })
        }
      }
    }
    // The primitive submenu takes MenuItem rows only (no separators), so the
    // host and plugin groups are told apart by their icons.
    rows.push(...pluginTargetRows(hostHasApps))
    return {
      id: 'open-with-menu',
      // The primitives Menu renders no chevron for submenu parents — the
      // trailing arrow is supplied inside the label (full-width flex row,
      // right-aligned), matching how the submenu rows right-align the pin.
      label: (
        <span className={css.openWithLabel}>
          <span className={css.openWithName}>{t('openWithMenu')}</span>
          <IconChevronRightOutlineRegular size={14} className={css.openWithChevron} aria-hidden />
        </span>
      ),
      icon: <VscLinkExternal size={14} />,
      submenu: rows,
    }
  }

  /**
   * The level-1 "default open" row for a file: the host's default handler, one
   * click away without opening a submenu. Absent while the listing is unknown,
   * when the host has no default, or for directories (no default concept).
   */
  const defaultAppRow = (target: { path: string; isDir: boolean }): MenuEntry | null => {
    if (!appReady || target.isDir) return null
    const entries = hostEntries(target)
    const fallback = entries?.find(entry => entry.isDefault)
    if (fallback === undefined) return null
    return { id: 'open-in-app:default', label: t('openInAppDefault'), icon: <AppGlyph entry={fallback} /> }
  }

  /** The "打开方式" group of the ONE row menu: the host default, the submenu and
   *  (host permitting) reveal. Empty when neither half can offer anything. */
  const openWithSection = (target: { path: string; isDir: boolean }): MenuEntry[] => {
    const fallback = defaultAppRow(target)
    const entries = hostEntries(target)
    const hostHasApps = entries !== undefined && entries !== null && entries.length > 0
    const submenu = appReady || pluginTargetRows(hostHasApps).length > 0 ? openWithSubmenu(target) : null
    if (fallback === null && submenu === null) return []
    const rows: MenuEntry[] = []
    if (fallback !== null) rows.push(fallback)
    if (submenu !== null) rows.push(submenu)
    if (appReady) {
      rows.push(
        { id: 'open-in-app-sep', type: 'separator' },
        { id: 'reveal-in-file-manager', label: t('revealInFileManager'), icon: <IconFolderOpenRegular size={14} /> },
      )
    }
    return rows
  }

  /**
   * The selection's ZIP row: two or more selected rows archive together, and a
   * LONE directory archives its own subtree. A lone FILE is skipped — it would
   * only duplicate the plain download row.
   */
  const zipEntries = (target: { path: string; isDir: boolean }): MenuEntry[] => {
    const count = selected.size
    if (count >= 2) {
      return [{
        id: 'archive-selection',
        label: t('zipDownloadCount', { count }),
        icon: <IconArchiveOutlineRegular size={14} />,
      }]
    }
    if (count === 1 && target.isDir) {
      return [{ id: 'archive-selection', label: t('zipDownload'), icon: <IconArchiveOutlineRegular size={14} /> }]
    }
    return []
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

  /**
   * Zip the selection through the host's ASYNC archive route:
   *
   *   archiveBuild(scope, paths, name) → { id, entries }
   *   → poll archiveStatus(id) every 250ms (self-scheduling: one request in
   *     flight) while the job builds, driving the `zipProgress` line
   *   → state 'ready' → fetch(archiveDownloadUrl(scope, id)) → blob → hidden
   *     `<a download>` (the bytes are fetched explicitly because a bare anchor
   *     would save the route's JSON error envelope as a broken .zip)
   *   → any failure (build / status / download) → `zipFailed` in the strip.
   *
   * `archiveBusyRef` keeps a repeated pick from starting a second job (the
   * visible progress line is the feedback), and `archiveProgress` carries the
   * live `done/total` for the line and its percentage.
   */
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveProgress, setArchiveProgress] = useState<{ done: number; total: number } | null>(null)
  const archiveBusyRef = useRef(false)
  /** The job being polled (state so the poller starts/stops with it). */
  const [archiveJobId, setArchiveJobId] = useState<string | null>(null)
  const archiveJobRef = useRef<{ id: string; name: string } | null>(null)

  /** End the job: drop the progress line and release the guard. */
  const settleArchive = useCallback((): void => {
    archiveBusyRef.current = false
    archiveJobRef.current = null
    setArchiveJobId(null)
    setArchiveBusy(false)
    setArchiveProgress(null)
  }, [])

  const failArchive = useCallback((message: string): void => {
    setActionError(t('zipFailed', { message }))
    settleArchive()
  }, [settleArchive])

  /** Save the finished archive as `name` through a hidden anchor. */
  const saveArchive = useCallback((id: string, name: string): void => {
    void fetch(archiveDownloadUrl({ sessionId, cwd }, id))
      .then(async (response) => {
        if (!response.ok) {
          const envelope: { error?: { message?: string } } | null = await response.json().catch(() => null)
          throw new Error(envelope?.error?.message ?? `HTTP ${response.status}`)
        }
        return await response.blob()
      })
      .then((blob) => {
        setActionError(null)
        const objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = name
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        // Revoke on the next task, not synchronously: some engines have not
        // committed the download when click() returns, and revoking the URL
        // under them loses the file. One tick is enough and keeps the blob
        // from outliving the download.
        window.setTimeout(() => { URL.revokeObjectURL(objectUrl) }, 0)
        settleArchive()
      })
      .catch((error: unknown) => {
        failArchive(error instanceof Error ? error.message : String(error))
      })
  }, [cwd, failArchive, sessionId, settleArchive])

  /** The poller's callbacks, read through a ref so the polling TASK stays
   *  identity-stable (a churned task restarts the loop every render). */
  const archiveHandlersRef = useRef({ fail: failArchive, save: saveArchive })
  archiveHandlersRef.current = { fail: failArchive, save: saveArchive }

  usePolling(archiveJobId !== null, useCallback(async (signal: AbortSignal): Promise<void> => {
    const job = archiveJobRef.current
    if (job === null) return
    // The poller swallows a rejected task (it must keep the loop alive), so
    // every failure is caught HERE and turned into the strip's `zipFailed`.
    try {
      const status = await archiveStatus(job.id)
      // The transport may deliver a response after teardown; the signal is the
      // only reliable staleness guard (the route call takes no signal).
      if (signal.aborted) return
      setArchiveProgress({ done: status.done, total: status.total })
      if (status.state === 'error') {
        archiveHandlersRef.current.fail(status.error ?? `HTTP ${status.state}`)
        return
      }
      if (status.state === 'ready') archiveHandlersRef.current.save(job.id, job.name)
    } catch (error: unknown) {
      if (signal.aborted) return
      archiveHandlersRef.current.fail(error instanceof Error ? error.message : String(error))
    }
  }, []), { intervalMs: 250, mode: 'self-scheduling', immediate: true })

  const downloadArchive = (paths: readonly string[]): void => {
    if (archiveBusyRef.current) return
    const name = paths.length === 1 ? `${baseName(paths[0]!)}.zip` : 'archive.zip'
    archiveBusyRef.current = true
    setArchiveBusy(true)
    setArchiveProgress(null)
    void archiveBuild({ sessionId, cwd }, paths, name)
      .then(({ id, entries }) => {
        archiveJobRef.current = { id, name }
        setArchiveProgress({ done: 0, total: entries })
        setArchiveJobId(id)
      })
      .catch((error: unknown) => {
        failArchive(error instanceof Error ? error.message : String(error))
      })
  }

  const root = cwd

  // Membership is tested per rendered row (deep trees run this thousands of
  // times per render): includes() made every row O(expanded), the whole tree
  // O(rows × expanded). One Set per render keeps it O(1) per row.
  const expandedSet = useMemo(() => new Set(expanded), [expanded])
  const revealedSet = useMemo(() => new Set(revealed), [revealed])
  expandedSetRef.current = expandedSet

  /** The tree's shared git status (the changes page reads the same snapshot);
   *  a parked tab unsubscribes from the poll. */
  const gitStatus = useGitStatus({ sessionId, cwd }, { visible: visible !== false })

  // The Shift range walks the rows the user can actually see: depth-first,
  // expanded state decides. Recomputed with the level cache, never rendered.
  const visibleRows = useMemo(() => {
    const rows: { path: string; isDir: boolean }[] = []
    const walk = (dir: string): void => {
      const level = data[dir]
      if (level?.entries === undefined) return
      for (const entry of level.entries) {
        rows.push({ path: entry.path, isDir: entry.isDir })
        if (entry.isDir && expandedSet.has(entry.path)) walk(entry.path)
      }
    }
    if (root !== undefined) walk(root)
    return rows
  }, [data, expandedSet, root])
  visibleRowsRef.current = visibleRows

  /**
   * Focus + select an inline editor once, on mount. The callback identity
   * must stay STABLE (useCallback []): an inline arrow re-runs on every
   * render (detach null → attach el), and focus()/select() mid-keystroke
   * would reselect the whole buffer while typing. A plain <input>, not the
   * primitives Input — that one forwards no ref, and focus+select is the
   * entire point here.
   */
  const renameInputRef = useCallback((el: HTMLInputElement | null): void => {
    if (el !== null) {
      el.focus()
      el.select()
    }
  }, [])

  /** The inline rename editor replacing one row (dirs and files alike):
   *  same indent/icon/height for a seamless swap, Enter/blur commits,
   *  Escape cancels, IME composition keys never reach the handlers (the
   *  shared isImeComposition guard). */
  const renderRenameRow = (entry: FsEntry, depth: number): ReactNode => (
    <div
      key={entry.path}
      className={clsx(css.explorerRow, css.explorerRenaming)}
      style={{ paddingLeft: depth * 22 + 6 }}
    >
      {entry.isDir
        ? dirRowIcon(entry.path, expandedSet.has(entry.path))
        : service !== undefined ? service.fileIcon(entry.path, 14) : builtinFileIcon(entry.path, 14)}
      <input
        ref={renameInputRef}
        className={css.explorerRenameInput}
        value={renaming?.value ?? ''}
        aria-label={t('rename')}
        spellCheck={false}
        onChange={(event) => {
          setRenaming(prev => prev === null ? prev : { ...prev, value: event.target.value })
        }}
        onKeyDown={(event) => {
          if (isImeComposition(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commitRename(entry.path, renaming?.value ?? '', entry.isDir)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setRenaming(null)
          }
        }}
        onBlur={() => { commitRename(entry.path, renaming?.value ?? '', entry.isDir) }}
      />
    </div>
  )

  /** The inline new-folder editor at the top of one level: the same
   *  interaction contract as the rename editor (Enter commits, Escape
   *  cancels, blur commits, IME guarded). */
  const renderNewFolderRow = (dir: string, depth: number): ReactNode => (
    <div className={clsx(css.explorerRow, css.explorerRenaming)} style={{ paddingLeft: depth * 22 + 6 }}>
      {dirRowIcon(dir, true)}
      <input
        ref={renameInputRef}
        className={css.explorerRenameInput}
        value={newFolder?.value ?? ''}
        placeholder={t('newFolderPlaceholder')}
        aria-label={t('newFolder')}
        spellCheck={false}
        onChange={(event) => {
          setNewFolder(prev => prev === null ? prev : { ...prev, value: event.target.value })
        }}
        onKeyDown={(event) => {
          if (isImeComposition(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commitNewFolder(dir, newFolder?.value ?? '')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelNewFolder()
          }
        }}
        onBlur={() => { commitNewFolder(dir, newFolder?.value ?? '') }}
      />
    </div>
  )

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    const head = newFolder?.dir === dir ? renderNewFolderRow(dir, depth) : null
    if (level === undefined) {
      return (
        <>
          {head}
          <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
        </>
      )
    }
    if (level.error !== undefined) {
      // A level the host could not read: the raw message on the level that
      // failed, never on its siblings (the batch reports errors per level).
      return (
        <>
          {head}
          <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
            {level.error}
          </div>
        </>
      )
    }
    const entries = level.entries ?? []
    return (
      <>
        {head}
        {entries.map((entry) => {
          // The row being renamed renders as its editor (no button semantics:
          // an editor is not a click target — and a nested interactive inside
          // role="button" would be invalid anyway).
          if (renaming?.path === entry.path) return renderRenameRow(entry, depth)
          if (entry.isDir) {
            const isOpen = expandedSet.has(entry.path)
            return (
              <div key={entry.path}>
                <DirRow
                  entry={entry}
                  depth={depth}
                  expanded={isOpen}
                  iconsVersion={iconsVersion}
                  service={service}
                  selected={selected.has(entry.path)}
                  dragging={draggingPath === entry.path}
                  revealed={revealedSet.has(entry.path)}
                  dropTarget={dropTarget === entry.path}
                  gitChanged={gitStatus.dirHasChanges(entry.path)}
                  copied={copiedPath === entry.path}
                  actions={actions}
                />
                {isOpen && renderLevel(entry.path, depth + 1)}
              </div>
            )
          }
          const git = gitStatus.statusOf(entry.path)
          return (
            <FileRow
              key={entry.path}
              entry={entry}
              depth={depth}
              iconsVersion={iconsVersion}
              service={service}
              selected={selected.has(entry.path)}
                  dragging={draggingPath === entry.path}
              revealed={revealedSet.has(entry.path)}
              dropTarget={dropTarget === parentOf(entry.path)}
              gitTone={git?.tone}
              gitLetter={git?.letter}
              copied={copiedPath === entry.path}
              actions={actions}
            />
          )
        })}
        {/* The host capped this directory's listing: say so instead of
            silently showing a partial tree. */}
        {level.truncated === true && <Notice kind="hint">{t('filesTruncated')}</Notice>}
      </>
    )
  }

  // ── fileTreeUi v2 service path: whole-tree MODEL building ──────────────
  // When the optional fileTreeUi v2 service is present the tree chrome
  // (container/subtrees, indent guides + hover-highlight seat, chevron +
  // fold interaction and animations, row chrome slots, drop visuals) is
  // the provider's FileTree framework; this block builds the
  // FileTreeRowModel forest from the same `data` state the built-in path
  // renders above and wires the SAME per-row events, states and visuals as
  // models (role/tabIndex/draggable + the in-tree drag event family, click
  // to open/toggle, Enter/Space, the right-click row menu, expansion state
  // data via expanded + onToggle). The built-in fallback path above stays
  // byte-for-byte the pre-v2 shape.

  /** The guide-line grid: this tree's own fold geometry (6px base — the
   *  workspace-root row inset — and the 22px indent step, so the stroke
   *  columns sit where the built-in rows' padding steps are). */
  const treeGrid = { basePx: 6, stepPx: 22 }
  /** Fixed row metrics for framework rows (the provider's fold animation
   *  needs fixed row heights; the built-in rows are 34px, not the
   *  framework's 30px default). Inline so no stylesheet cascade can win. */
  const treeRowStyle: CSSProperties = { minHeight: 34, height: 34, paddingRight: 8 }

  /** The ancestor chain of a row path, root side first — the guide-column
   *  ids. Full paths are the branch-unique keys the provider's hover seat
   *  matches on (two branches at the same depth never share an id). */
  const treeAncestors = (path: string, treeRoot: string): string[] => {
    const chain: string[] = []
    let current = parentOf(path)
    while (current !== treeRoot && current !== parentOf(current)) {
      chain.unshift(current)
      current = parentOf(current)
    }
    chain.unshift(treeRoot)
    return chain
  }

  /** One entry's guide columns (one per ancestor): a band click toggles
   *  that ancestor's expansion (the provider stops propagation, so a band
   *  click never opens the row). The root column's toggle is a no-op — the
   *  workspace root is always shown expanded (it has no collapse affordance
   *  in the built-in path either). */
  const treeGuideColumns = (ancestors: string[]): GuideColumn[] =>
    ancestors.map((dir, index) => ({
      id: dir,
      onToggle: index === 0 ? () => {} : () => { onToggle(dir) },
    }))

  /** The @-reference affordance (or the transient copied label) for the
   *  actions slot — the framework gates the slot's visibility on row
   *  hover/focus itself (opacity), so the button needs no display rule of
   *  its own (see .explorerTreeRef vs the built-in path's .explorerRef). */
  const treeRowActions = (path: string, isDir: boolean): ReactNode => (
    copiedPath === path
      ? <span className={css.explorerCopied}>{t('copied')}</span>
      : (
        <button
          type="button"
          className={css.explorerTreeRef}
          aria-label={t('referenceFile')}
          title={t('referenceFile')}
          onClick={(event) => {
            event.stopPropagation()
            onReferenceFile(path, isDir)
          }}
        >
          {t('referenceFile')}
        </button>
      )
  )

  /**
   * One level's tree rows (the v2 twin of renderLevel). Level states map
   * to injected FileTreeNode entries exactly like the built-in path (the
   * loader row / FenceErrorNotice / error row keep their own padding);
   * entry rows carry their whole DOM semantics + expansion state data as
   * FileTreeRowModel fields — every interaction the built-in rows have.
   */
  const buildLevelRows = (baseDir: string, depth: number, treeRoot: string): FileTreeNode[] => {
    const level = data[baseDir]
    if (level === undefined) {
      return [(
        <div
          key={`loading:${baseDir}`}
          className={css.explorerRow}
          style={{ paddingLeft: depth * 22 + 6 }}
        >
          {t('loading')}
        </div>
      )]
    }
    if (level.error !== undefined) {
      return [(
        <div
          key={`error:${baseDir}`}
          className={clsx(css.explorerRow, css.explorerError)}
          style={{ paddingLeft: depth * 22 + 6 }}
        >
          {level.error}
        </div>
      )]
    }
    const entries = level.entries ?? []
    const rows: FileTreeNode[] = entries.map(entry => {
      // The row being renamed renders as its editor — a whole-row injected
      // node (an editor is not a click target, and nesting it inside the
      // framework's row chrome + role="button" would be invalid).
      if (renaming?.path === entry.path) return renderRenameRow(entry, depth)
      const git = gitStatus.statusOf(entry.path)
      const dirChanged = entry.isDir && gitStatus.dirHasChanges(entry.path)
      const isDir = entry.isDir
      const isOpen = isDir && expandedSet.has(entry.path)
      // VSCode drop routing: a drop on a directory row lands IN it; a drop
      // on a file row targets its parent directory (the framework's
      // dropState is visual only — the routing stays here).
      const dropDir = isDir ? entry.path : parentOf(entry.path)
      const row: FileTreeRowModel = {
        key: entry.path,
        role: 'button',
        tabIndex: 0,
        draggable: true,
        indentPx: depth * 22 + 6,
        guideColumns: treeGuideColumns(treeAncestors(entry.path, treeRoot)),
        junction: isOpen,
        style: treeRowStyle,
        className: clsx(
          selected.has(entry.path) && css.explorerRowSelected,
          entry.hidden && css.explorerHidden,
          draggingPath === entry.path && css.explorerRowDragging,
          revealedSet.has(entry.path) && css.explorerRowRevealed,
        ),
        // The name span carries the row tooltip and the broken-symlink ink
        // (the framework's DOM passthrough has no `title`, and the label
        // slot is where this row's own text lives).
        label: (
          <span
            className={clsx(css.explorerName, entry.broken && css.explorerBrokenName, !isDir && git !== undefined && css.explorerGitName, dirChanged && css.explorerDirChanged)}
            data-git-tone={isDir ? undefined : git?.tone}
            title={entry.broken ? `${entry.path} — ${t('brokenSymlink')}` : entry.path}
          >
            {entry.name}
          </span>
        ),
        leading: isDir ? dirRowIcon(entry.path, isOpen) : (service !== undefined ? service.fileIcon(entry.path, 14) : builtinFileIcon(entry.path, 14)),
        trailing: <>
          {entry.isSymlink && <IconLinkOutlineRegular size={12} className={css.explorerSymlink} />}
          {!isDir && git !== undefined && <StatusBadge tone={badgeToneOf(git.tone)} title={gitToneLabel(git.tone)}>{git.letter}</StatusBadge>}
        </>,
        actions: treeRowActions(entry.path, entry.isDir),
        // The transient copied label must stay visible without hover (the
        // framework otherwise keeps the actions slot at opacity 0).
        actionsVisible: copiedPath === entry.path,
        ...(dropTarget === dropDir ? { dropState: 'on' as const } : {}),
        onClick: (event) => { handleActivate(event, entry.path, isDir) },
        onKeyDown: (event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            // Keyboard-triggered menus anchor at 0,0 (the browser's own
            // contextmenu event reports the same for keyboard triggers).
            handleContextMenu(
              { clientX: 0, clientY: 0, preventDefault: () => { event.preventDefault() }, stopPropagation: () => { event.stopPropagation() } },
              entry.path,
              entry.isDir,
            )
            return
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            handleActivate(event, entry.path, isDir)
          }
        },
        // The right-click row menu: the model's DOM passthrough has no
        // onContextMenu, so the menu opens on right-button pointer-up over
        // the row (full-row coverage, chevron and guide bands included)
        // and the native context menu is suppressed at the explorer body
        // (the contextmenu event bubbles there — see the body handler).
        onPointerUp: (event) => {
          if (event.button === 2) handleContextMenu(event, entry.path, entry.isDir)
        },
        onDragStart: (event) => {
          event.dataTransfer.setData('application/x-dsh-tree-drag', entry.path)
          event.dataTransfer.effectAllowed = 'copyMove'
          dragSource.current = { path: entry.path, isDir }
          setDraggingPath(entry.path)
        },
        onDragEnd: () => { clearDragSource(); resetDrop() },
        onDragOver: (event) => { handleRowDragOver(event, dropDir) },
        onDrop: (event) => {
          if (isDir) handleDirDrop(event, entry.path)
          else handleFileDrop(event, entry.path)
        },
        // Expansion STATE data stays here (per-row expanded + onToggle;
        // the caller's expanded set is the single source of truth); the
        // chevron + fold interaction and the subtree gating/animations are
        // the framework's. children stay present even while collapsed so
        // the fold's enter/exit animations can play; an unloaded level
        // renders its loading node inside the fold like the built-in path.
        ...(isDir ? {
          expanded: isOpen,
          onToggle: () => { onToggle(entry.path) },
          children: buildLevelRows(entry.path, depth + 1, treeRoot),
        } : {}),
      }
      return row
    })
    if (newFolder?.dir === baseDir) rows.unshift(renderNewFolderRow(baseDir, depth))
    if (level.truncated === true) rows.push(<Notice kind="hint">{t('filesTruncated')}</Notice>)
    return rows
  }

  /** The v2 service path's root row model: the workspace root (icon + name
   *  + the same @-reference/copied affordance and drop/right-click
   *  surfaces the built-in root row carries). Its children are always
   *  shown (no expanded → the framework renders them unconditionally,
   *  exactly like the built-in `{data[root] !== undefined && renderLevel…}`
   *  gate — which also means the root level itself shows nothing while it
   *  loads). */
  const rootRowModel = (treeRoot: string): FileTreeRowModel => ({
    key: treeRoot,
    label: <span className={css.explorerName}>{baseName(treeRoot)}</span>,
    leading: dirRowIcon(treeRoot, true),
    indentPx: 6,
    style: treeRowStyle,
    actions: treeRowActions(treeRoot, true),
    actionsVisible: copiedPath === treeRoot,
    ...(dropTarget === treeRoot ? { dropState: 'on' as const } : {}),
    onDragOver: (event) => { handleRowDragOver(event, treeRoot) },
    onDrop: (event) => { handleDirDrop(event, treeRoot) },
    onPointerUp: (event) => {
      if (event.button === 2) handleContextMenu(event, treeRoot, true)
    },
    children: data[treeRoot] === undefined ? [] : buildLevelRows(treeRoot, 1, treeRoot),
  })

  return (
    <div
      ref={bodyRef}
      className={clsx(css.explorerBody, hidden === true && css.explorerHiddenPane)}
      hidden={hidden}
      tabIndex={-1}
      onDragEnter={handleBodyDragEnter}
      onDragOver={handleBodyDragOver}
      onDragLeave={handleBodyDragLeave}
      onDrop={handleBodyDrop}
      onContextMenu={fileTreeUi !== undefined && root !== undefined ? (event) => {
        // Service-path rows open the row menu on right-button pointer-up
        // (the model's DOM passthrough has no onContextMenu); the
        // contextmenu event itself bubbles here and only needs suppressing
        // so the browser's native menu never appears on top of ours. The
        // built-in rows stop propagation and handle the event themselves,
        // so nothing here changes for the fallback path.
        event.preventDefault()
      } : undefined}
      onClick={(event) => { if (event.target === event.currentTarget) clearSelection() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') clearSelection()
        // VS Code explorer keybindings: Cmd/Ctrl+Z undoes the last tree
        // mutation; Cmd/Ctrl+Shift+Z (and plain Ctrl+Y on Windows/Linux)
        // redoes it. Native text undo always wins inside editors — the
        // inline rename input and TreePanel's search box keep their own
        // key handling (their keydowns bubble here, hence the target gate).
        const target = event.target
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          || (target instanceof HTMLElement && target.isContentEditable)) {
          return
        }
        if (!(event.metaKey || event.ctrlKey) || event.altKey) return
        const key = event.key.toLowerCase()
        if (key === 'z') {
          event.preventDefault()
          if (event.shiftKey) runRedo()
          else runUndo()
        } else if (key === 'y' && !event.shiftKey && !event.metaKey) {
          // Plain Ctrl+Y only: macOS Cmd+Y is not redo there (Cmd+Shift+Z
          // is), so it must stay untouched.
          event.preventDefault()
          runRedo()
        }
      }}
    >
      {root === undefined ? (
        <div className={css.explorerEmpty}>{t('noSession')}</div>
      ) : (
        <>
          {/* The last mutation failure (rename/delete/mkdir/open-in-app):
              dismissable, raw server text — the same show-the-truth policy the
              fence notice uses. Any later action or a fresh attempt clears it. */}
          {actionError !== null && (
            <div className={css.explorerActionError} role="alert">
              <span className={css.explorerActionErrorText}>{actionError}</span>
              <IconButton
                size="sm"
                label={t('dismiss')}
                icon={<IconCloseFillRegular size={14} />}
                onClick={() => { setActionError(null) }}
              />
            </div>
          )}
          {/* The archive is built host-side, in one pass, while the STATUS
              poll drives `done/total`: the line sits right under the error
              strip (the two CAN coexist — a stale error stays readable while a
              new attempt is in flight). `role="status"` makes it a polite live
              region, so progress is announced without stealing focus. */}
          {/* A refresh whose batch request failed: the rows above are the
              PREVIOUS listing, so the hint explains why nothing changed. */}
          {loadError !== null && (
            <Notice kind="warn" tone="inline">{loadError}</Notice>
          )}
          {archiveBusy && (
            <Notice kind="loading" tone="inline" role="status">
              {archiveProgress === null
                ? t('loading')
                : `${t('zipProgress', { done: archiveProgress.done, total: archiveProgress.total })} · ${archivePercent(archiveProgress)}%`}
            </Notice>
          )}
          {fileTreeUi !== undefined ? (
            /*
             * The v2 service path: ONE renderFileTree call — the whole tree
             * (root row + levels) rides the row models built above; the
             * provider's FileTree framework owns the container/subtrees,
             * indent guides + hover seat, chevron + fold interaction and
             * animations, row chrome slots and drop visuals. The treeKey
             * isolates this tree's guide-hover seat (other trees on the
             * same page — e.g. a recents list — use their own keys).
             */
            fileTreeUi.renderFileTree({
              treeKey: 'workspace-explorer',
              rows: [rootRowModel(root)],
              grid: treeGrid,
              className: css.explorerTree,
              role: 'tree',
              ariaLabel: t('files'),
            })
          ) : (<>
          <RootRow
            path={root}
            iconsVersion={iconsVersion}
            service={service}
            dropTarget={dropTarget === root}
            gitChanged={gitStatus.dirHasChanges(root)}
            copied={copiedPath === root}
            actions={actions}
          />
          {renderLevel(root, 1)}
          </>)}
          {/* The selection bar closes the scroll container (sticky bottom): it
              sits BELOW every row, never over them, and its appearance never
              shifts the tree the way a top bar did. */}
          {selected.size > 0 && (
            <div className={css.explorerSelectionBar} role="toolbar" aria-label={t('filesSelected', { count: selected.size })}>
              <span className={css.explorerSelectionText}>{t('filesSelected', { count: selected.size })}</span>
              <span className={css.explorerSelectionActions}>
                <Chip onClick={copySelectedPaths}>{t('copyPaths')}</Chip>
                <Chip onClick={() => { setConfirmDeleteSelected(true) }}>{t('deleteSelected')}</Chip>
                <Chip onClick={clearSelection}>{t('clearSelection')}</Chip>
              </span>
            </div>
          )}

        </>
      )}
      {dropOver && dropRect !== null && createPortal(
        /*
         * The sidebar's drop surface, portaled to document.body at z-1001+ —
         * above DSH's own whole-page drop mask (z-1000, see InputBar's
         * document-level intake) so the two never compete. A LIGHT mask dims
         * the viewport: the dimmed conversation column still takes drops into
         * the chat natively (this layer is pointer-inert), while the dashed
         * frame marks the tree as the workspace-upload zone. Deliberate
         * exception to the "panel stays below the DSH float stack" rule:
         * transient, and the drop always lands on the element beneath. The
         * hint pill docks at the TOP edge of the zone — right under the
         * search row, the first thing the eye meets — keeping the rows
         * aimable.
         */
        <>
          <div className={css.uploadDropMask} />
          <div
            className={css.uploadDropZone}
            style={{
              top: dropRect.top + 2,
              left: dropRect.left + 2,
              width: dropRect.width - 4,
              height: dropRect.height - 4,
            }}
          >
            <div className={css.uploadDropHero}>
              <UploadDropIllustration />
              <div className={css.uploadDropZonePill}>
                <IconUploadOutline16 size={14} />
                <span className={css.uploadDropZoneText}>
                  {dropTarget !== null ? t('uploadTo', { dir: dropTarget }) : t('uploadDropHint')}
                </span>
              </div>
            </div>
          </div>
          {/* The left zone's invitation, centered in the space beside the
              tree; skipped when that space is too narrow to hold it. */}
          {dropRect.left >= 200 && (
            <div className={css.uploadDropChatHint} style={{ width: dropRect.left }}>
              <div className={css.uploadDropChatCard}>
                <ChatDropIllustration />
                <span>{t('uploadDropChat')}</span>
              </div>
            </div>
          )}
        </>,
        document.body,
      )}
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the tree's overflow clip cannot crop it).
      */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          const dir = pendingUploadDir.current ?? root
          pendingUploadDir.current = undefined
          if (dir !== undefined && !busy) onUploadRequest(dir, uploadItemsFromFiles(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // 1-3: the "打开方式" group heads the menu — the host's default
          // handler, the one submenu holding every application (host + the
          // plugin's own, per the visibility rule) and the host's reveal.
          ...(rowMenu === null ? [] : openWithSection(rowMenu)),
          // 4: the explicit open escapes (files only).
          ...(rowMenu?.isDir === false && onOpenFileNewTab !== undefined
            ? [{ id: 'open-new-tab', label: t('openFileNewTab'), icon: <IconCodeOutlineRegular size={14} /> }]
            : []),
          ...(rowMenu?.isDir === false && onOpenFileSide !== undefined
            ? [{ id: 'open-side', label: t('openFileSide'), icon: <IconFolderOpenRegular size={14} /> }]
            : []),
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutlineRegular size={14} /> }]
            : []),
          // Directory actions: upload into, and create inside (the workspace
          // root row included).
          ...(rowMenu?.isDir === true
            ? [{ id: 'upload-here', label: t('uploadHere'), icon: <IconUploadOutline16 size={14} /> }]
            : []),
          ...(rowMenu?.isDir === true
            ? [{ id: 'new-folder', label: t('newFolder'), icon: <IconPlusOutlineRegular size={14} /> }]
            : []),
          // 5: ZIP of the current selection (≥2 rows, or one lone directory).
          ...(rowMenu === null ? [] : zipEntries(rowMenu)),
          // 6: copy, then the mutations (never on the workspace root row).
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutlineRegular size={14} /> },
          ...(rowMenu !== null && rowMenu.path !== cwd
            ? [
                { id: 'mutate-sep', type: 'separator' } as MenuEntry,
                { id: 'rename', label: t('rename'), icon: <IconEditOutlineRegular size={14} /> },
                { id: 'delete', label: t('delete'), icon: <IconTrashOutlineRegular size={14} />, danger: true },
              ]
            : []),
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
          if (id === 'open-in-app:default') {
            openWithApp(target.path)
            return
          }
          if (id.startsWith('open-in-app:')) {
            openWithApp(target.path, id.slice('open-in-app:'.length))
            return
          }
          // The plugin's own targets share one id space (pinned rows and
          // submenu children alike), so the caller gets the target id + path.
          if (id.startsWith('open-with:')) {
            onOpenWith?.(id.slice('open-with:'.length), target.path)
            return
          }
          if (id === 'reveal-in-file-manager') {
            revealPath(target.path)
            return
          }
          if (id === 'archive-selection') {
            downloadArchive([...selected])
            return
          }
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          if (id === 'upload-here') {
            pendingUploadDir.current = target.path
            fileInputRef.current?.click()
            return
          }
          if (id === 'new-folder') {
            startNewFolder(target.path)
            return
          }          if (id === 'rename') {
            setRenaming({ path: target.path, value: baseName(target.path), isDir: target.isDir })
            return
          }
          if (id === 'delete') {
            setConfirmDelete({ path: target.path, isDir: target.isDir, name: baseName(target.path) })
            return
          }
          copyPath(
            id === 'relative' ? relativeTo(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        compact
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* The single-row delete confirmation: destructive and permanent (no host
          trash), so it always lands here first — the shared kit dialog, the
          same shape the git lens uses for discard/revert/cherry-pick. */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete === null ? '' : t('deleteTitle', { name: confirmDelete.name })}
        description={confirmDelete === null ? '' : t(confirmDelete.isDir ? 'deleteDescDir' : 'deleteDescFile')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        danger
        onConfirm={() => {
          const pending = confirmDelete
          if (pending === null) return
          setConfirmDelete(null)
          performDelete(pending)
        }}
        onClose={() => { setConfirmDelete(null) }}
      />

      {/* The batch delete: one confirmation for the whole selection, then one
          sequential fs.remove per row (the first failure stops the walk). */}
      <ConfirmDialog
        open={confirmDeleteSelected}
        title={t('deleteSelectedTitle', { count: selected.size })}
        description={t('deleteSelectedDesc')}
        confirmLabel={t('deleteSelected')}
        cancelLabel={t('cancel')}
        danger
        busy={deletingSelected}
        onConfirm={performBatchDelete}
        onClose={() => { setConfirmDeleteSelected(false) }}
      />
    </div>
  )
}
