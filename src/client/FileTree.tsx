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
 * rows, so the sibling structure reads at a glance. Each ancestor stroke is
 * also a CLICK TARGET (`guideHitBands`): hovering a row reveals a small
 * band over every ancestor column, the band under the pointer lights up
 * together with the ancestor's WHOLE vertical line across its visible
 * subtree, and clicking it collapses that ancestor directory — from any
 * descendant row, so a folder full of expanded subdirs folds one level (or
 * all the way up to the workspace root's children) without scrolling to
 * find the directory rows (the VSCode indent-guide affordance).
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu: file rows offer the caller's open escapes
 * (new tab / to the side, only when the callbacks exist) and a download
 * action (the host serves raw bytes, binary-safe); directory rows offer
 * "upload here"; every row can copy the relative or absolute path (with a
 * brief "copied" label replacing the button after a successful write).
 *
 * Uploads start here (drag-drop or the context menu picker) but run in the
 * caller: every request is reported through `onUploadRequest(dir, items)`
 * (VSCode semantics — a drop on a file row targets its parent directory),
 * and `busy` gates new drags while one upload is in flight.
 *
 * Data source slot (v0.17.0+): listings default to the local host fs.tree
 * route; a provider registered through `ctx.betterSidebar
 * .registerFileTreeProvider` whose `match` accepts this session replaces
 * the source for ALL listings (root + expansions), and its declared
 * `capabilities` decide which local-only abilities (upload / download /
 * openWith / git) stay available — undeclared ones degrade off (see
 * file-tree-source.ts). The diverge lives in ONE place: `loadDir` below;
 * refreshTick keeps its exact cache-wipe → reload semantics.
 *
 * Multi-root (v0.18.0+): when a matched provider declares `roots`, the
 * tree renders a root LIST at the top — the local cwd root (full local
 * semantics, listed through the local fs.tree route, never taken over by a
 * provider) plus one expandable row per provider-contributed remote root
 * (listings through that provider's `list`). Root rows carry their own
 * open state (the local root starts open), each root's levels cache under
 * its dir string, and each remote root's rows degrade their local-only
 * abilities by the ROOT's capability face — the local root keeps every
 * ability unconditionally. TreePanel resolves the roots once and passes
 * them down so its panel-level gates and the tree share one resolution;
 * without the prop the tree resolves on its own (direct consumers).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  IconChevronRightOutline14, IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16,
  IconFolderClose16, IconFolderOpen16, IconLoadingOutline16,
  IconLinkOutline16, Menu, type MenuEntry, type MenuItem, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SiCursor, SiZedindustries } from 'react-icons/si'
import { VscChevronRight, VscFile, VscFolder, VscFolderOpened, VscLinkExternal, VscPin, VscPinned } from 'react-icons/vsc'
import { api, downloadUrl, type FsEntry } from './api.ts'
import {
  fileTreeCapabilityOn, normalizeFileTreeEntries, useFileTreeRoots, useFileTreeSource,
  type FileTreeDataSource, type FileTreeProviderCapabilities, type ResolvedFileTreeRoot,
  type ResolvedFileTreeSource,
} from './file-tree-source.ts'
import { gitStatusAt, type GitRowStatus, type GitStatusKind } from './git-status.ts'
import { IconUploadOutline16, IconVscode16 } from './icons.tsx'
import type { OpenWithTarget } from './open-with.ts'
import { relativeTo } from './paths.ts'
import { t, type CopyKey } from './locales.ts'
import { useFileIconResolver } from './FileIcon.tsx'
import { commandMenuRows, type CommandMenuWhere } from './commands.ts'
import type { Context } from '../context-types.ts'
import { uploadItemsFromDrop, uploadItemsFromFiles, type UploadItem } from './upload.ts'
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

/** The guide stroke while its column is hovered: the ancestor's WHOLE
 *  vertical line lights up (every row in its visible subtree paints this
 *  stroke at the same column — see `highlightCol` below). A strong accent
 *  so the full "collapse target" line reads at a glance. The band's ::before
 *  stroke in sidebar.module.css mirrors this look — keep the two in sync. */
const GUIDE_STROKE_HOVER = 'color-mix(in srgb, var(--dsw-alias-interactive-bg-hover-accent) 80%, transparent)'

/** One row's indent-guide background layer set: a 1px vertical stroke under
 *  every expanded ancestor at that ancestor's icon column (the root is
 *  always expanded, so depth-1 rows draw one stroke at x=6), plus — on
 *  expanded DIRECTORY rows only — the horizontal corner segment joining the
 *  deepest ancestor stroke to the folder icon (the "├─" joint). Files and
 *  collapsed dirs keep just the verticals, so sibling structure reads at a
 *  glance exactly like the VSCode explorer.
 *
 *  Neighboring rows decide where strokes stop: a row at depth D draws only
 *  the D ancestor columns, so the first shallower sibling below a subtree
 *  simply has no stroke for it — each guide ends flush at its subtree's last
 *  row, never dangling into empty space.
 *
 *  `highlightCol`: when a guide band is hovered, the ancestor's whole line
 *  lights up — every row carrying that column's stroke paints it in the
 *  hover stroke instead (2px, centered on the 1px guide).
 *
 *  The style is applied inline as background longhands (never the `background`
 *  shorthand): the shorthand would claim `background-color`, which the
 *  stylesheet's row fill and hover fill own.
 */
export function treeGuideBackground(depth: number, isOpenDir: boolean, highlightCol?: number): CSSProperties {
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
    if (k === highlightCol) {
      // The hovered column: the full line, 2px and brighter.
      image.push(`linear-gradient(90deg, transparent ${x - 0.5}px, ${GUIDE_STROKE_HOVER} ${x - 0.5}px, ${GUIDE_STROKE_HOVER} ${x + 1.5}px, transparent ${x + 1.5}px)`)
    } else {
      image.push(`linear-gradient(90deg, transparent ${x}px, ${GUIDE_STROKE} ${x}px, ${GUIDE_STROKE} ${x + 1}px, transparent ${x + 1}px)`)
    }
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

/** One byte count → a short human size ('48 B', '1.2 KB', '3.4 MB'),
 *  the v0.20 stat-suffix formatter (1024-based, one decimal under 100). */
export function humanFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit++
  } while (value >= 1024 && unit < units.length - 1)
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** One epoch-millis timestamp → a short LOCAL time ('9-6 14:30'), the
 *  v0.20 stat-suffix formatter (compact M-D hh:mm — the day unpadded, the
 *  clock zero-padded 24h). */
export function fileMetaTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}-${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The dimmed stat suffix of one row ('1.2 KB 9-6 14:30'), or null when
 *  the entry carries no meta detail (absent meta / no size and no mtime) —
 *  local rows always land here, so their rendering stays byte-for-byte. */
function metaSuffix(meta: FsEntry['meta']): string | null {
  if (meta === undefined) return null
  if (meta.size === undefined && meta.mtime === undefined) return null
  const parts: string[] = []
  if (meta.size !== undefined) parts.push(humanFileSize(meta.size))
  if (meta.mtime !== undefined) parts.push(fileMetaTime(meta.mtime))
  return parts.join(' ')
}

/**
 * The v0.20.0 stat-suffix display priority: the icon + file name own the
 * row — the size/mtime suffix only renders while the name still fits. A
 * name that the flex row is squeezing (scrollWidth > clientWidth, i.e. the
 * ellipsis is active) means "no space left for icon + name", so the suffix
 * drops; a dropped suffix returns only when the row shows it would fit
 * again with breathing room (free space right of the name ≥ suffix width +
 * `META_FIT_MARGIN`) — the margin keeps a row sitting exactly on the
 * boundary from ping-ponging between hide and show on every pass.
 *
 * The two inputs are measured from the live row (see `measureMetaPriority`):
 * the name span's natural/rendered widths and the row's client width / the
 * name's left offset (all integers — px). Factored pure (no DOM) so the
 * decision is unit-testable.
 */
/** Re-show headroom: the suffix must fit with the 6px flex gap plus this
 *  much free space to spare (sub-pixel / reflow jitter guard). */
const META_FIT_MARGIN = 12

/** Whether the suffix fits again on its row: the name is no longer
 *  truncated AND the free space right of the name holds the suffix. */
export function metaSuffixFits(
  nameScroll: number,
  nameClient: number,
  rowClient: number,
  nameOffset: number,
  metaWidth: number,
): boolean {
  if (nameScroll > nameClient) return false
  return rowClient - (nameOffset + nameClient) >= metaWidth + META_FIT_MARGIN
}

/** Whether the row is too cramped for the suffix (the name is being
 *  truncated — "no space left for icon + name"). */
export function metaSuffixCramped(nameScroll: number, nameClient: number): boolean {
  return nameScroll > nameClient
}

/** The containing directory of an absolute row path (never the root edge here). */
function parentOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at <= 0 ? path : path.slice(0, at)
}

/** The ancestor directory at tree depth `k` of the row `path` (whose own
 *  depth is `rowDepth`): the directory that owns the guide stroke drawn at
 *  column k under this row. Column 0 is the workspace root; callers only
 *  ever pass k >= 1, so the result is a real (collapsible) directory path. */
function ancestorAtDepth(path: string, rowDepth: number, k: number): string {
  let p = path
  for (let i = rowDepth; i > k; i--) p = parentOf(p)
  return p
}

/** Half-width of the clickable band around each guide stroke, in px. The
 *  stroke itself is 1px; the band (2 × this) is the hover-highlighted,
 *  clickable "region" under it — wide enough to hit comfortably (16px per
 *  band), narrow enough to never touch the row content (the deepest band's
 *  outside edge stays 13.5px = INDENT_STEP − HALF − 0.5 short of the row's
 *  content start) and to keep a clean 6px gap between neighbor columns
 *  (INDENT_STEP − 2 × HALF, so hovering one band never brushes the next). */
const GUIDE_HIT_HALF = 8

/** The hovered guide band: the row owning it, its column, and the ancestor
 *  directory that owns the stroke — the whole vertical line of that
 *  directory lights up across its visible subtree while the band is hovered
 *  (see `treeGuideBackground`'s highlightCol). */
interface GuideHover {
  row: string
  col: number
  ancestor: string
}

/** The clickable indent-guide bands on one row: one per expanded-ancestor
 *  column k in [1, rowDepth), absolutely positioned exactly over that
 *  ancestor's stroke. Invisible until the row is hovered; the band under
 *  the pointer lights up (`.explorerGuideHit:hover`) and — while hovered —
 *  the ancestor's whole vertical line lights up across its subtree;
 *  clicking the band collapses that ancestor directory (the directory
 *  whose vertical line was clicked). Clicks stop propagation so the row's
 *  own open/toggle action never fires. Depth-1 rows (children of the
 *  workspace root) get no bands: their only stroke is the root's, and the
 *  root never collapses. */
function guideHitBands(
  path: string,
  rowDepth: number,
  onToggle: (path: string) => void,
  setHoverGuide: (setter: (prev: GuideHover | null) => GuideHover | null) => void,
): ReactNode[] {
  const bands: ReactNode[] = []
  for (let k = 1; k < rowDepth; k++) {
    bands.push(
      <span
        key={k}
        className={css.explorerGuideHit}
        style={{ left: k * INDENT_STEP + INDENT_BASE - (GUIDE_HIT_HALF - 0.5) }}
        onMouseEnter={() => {
          setHoverGuide(prev => prev !== null && prev.row === path && prev.col === k
            ? prev
            : { row: path, col: k, ancestor: ancestorAtDepth(path, rowDepth, k) })
        }}
        onMouseLeave={() => {
          setHoverGuide(prev => prev !== null && prev.row === path && prev.col === k ? null : prev)
        }}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(ancestorAtDepth(path, rowDepth, k))
        }}
      />,
    )
  }
  return bands
}

/** Only OS file drags belong to the upload surface; in-app drags (tab reorder,
 *  split zones) must pass through untouched to the pane's tab-drop handling
 *  (mirror of Sidebar.tsx's panel-host shield gate). */
function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false
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
  untracked: css.explorerGitSuccess,
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

/**
 * The drop overlay's hero art: an arrow rising out of a notched tray
 * (upload zone — the same glyph family as the toolbar's upload icon) and a
 * tilted pair of photo cards (chat zone). Hand-drawn, colored in the
 * palette of DSH's own native drop illustration (#3964FE / #9CE5ED) so the
 * two zones read as one family; the drop overlay is this flow's one brand
 * moment, so it gets color the rest of the UI never does.
 */
const UploadDropIllustration = () => (
  <svg width="64" height="56" viewBox="0 0 64 56" fill="none" aria-hidden="true">
    <path d="M32 28V11" stroke="#3964FE" strokeWidth="5" strokeLinecap="round" />
    <path d="M23 20l9-9 9 9" stroke="#3964FE" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    <path
      d="M10 40a4 4 0 0 1 4-4h7l3.2 4.6a5 5 0 0 0 4.1 2.2h7.4a5 5 0 0 0 4.1-2.2L43 36h7a4 4 0 0 1 4 4v2a10 10 0 0 1-10 10H20A10 10 0 0 1 10 42v-2z"
      fill="#9CE5ED"
    />
  </svg>
)

/** The chat zone's art: two tilted photo cards, each with its own
 *  sun-over-mountains motif (the back card carries detail too, so it never
 *  reads as a bare blob). */
const ChatDropIllustration = () => (
  <svg width="96" height="76" viewBox="0 0 96 76" fill="none" aria-hidden="true">
    <g transform="rotate(-12 24 34)">
      <rect x="6" y="16" width="36" height="36" rx="10" fill="#9CE5ED" />
      <circle cx="16" cy="27" r="3.5" fill="white" />
      <path d="M11 44l8-9 6 6 4-4 8 9" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </g>
    <g transform="rotate(8 61 35)">
      <rect x="40" y="12" width="42" height="46" rx="10" fill="#3964FE" />
      <circle cx="55" cy="27" r="5" fill="white" />
      <path d="M46 50l10-13 7 8 6-6 9 11" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  </svg>
)

export function FileTree(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
/** The client context (v0.16.0+): enables the ACTIVE icon theme's file
   *  icons on rows. Absent → the built-in outline icons (zero change). */
  ctx?: Context
  /**
   * The session's resolved remote roots (v0.18.0+, multi-root mode).
   * TreePanel resolves these via `useFileTreeRoots` so its panel-level
   * gates and the tree share ONE resolution (the provider's `roots` is
   * consulted once per change). Absent → the tree resolves roots itself
   * through `ctx` (direct consumers / tests). An EMPTY array is a settled
   * "no remote roots" — the plain single-root render, byte for byte.
   */
  roots?: readonly ResolvedFileTreeRoot[]
  /** Files highlighted by a "Show in folder" reveal (absolute paths). */
  revealed?: string[]
  /**
   * A data-source override (v0.20.0): when non-undefined this resolved
   * source REPLACES the internal `useFileTreeSource` resolution (the hook
   * still runs unconditionally — only its result is overridden). The
   * component's mode key (`single:<providerId>`) and the single-source
   * selection adapt automatically. This is the seam the SOURCE-form file
   * tree sections use: the host renders its own FileTree bound EXPLICITLY
   * to the plugin's source instance — no global provider registration, so
   * the local tree can never be taken over.
   */
  sourceOverride?: ResolvedFileTreeSource
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Context-menu "open in a new tab" (file rows; absent → no entry). */
  onOpenFileNewTab?: (path: string) => void
  /** Context-menu "open to the side" (file rows; absent → no entry). */
  onOpenFileSide?: (path: string) => void
  /**
   * The "open with" menu: resolved external targets (already SSH-filtered
   * and in menu order). Absent → the whole section is hidden.
   */
  openWithTargets?: OpenWithTarget[]
  /** Ids of targets pinned to the menu's top level (subset of the ids). */
  openWithPinned?: string[]
  /** Whether the workspace is remote (appends the SSH hint to target labels). */
  openWithSsh?: boolean
  /** Open one target externally (reveal or URL — the caller decides). */
  onOpenWith?: (targetId: string, path: string) => void
  /** Toggle one target's pinned state (the submenu row's pushpin). */
  onToggleOpenWithPin?: (targetId: string) => void
  /** Insert `@<relative path>` into the composer draft. */
  onReferenceFile: (path: string) => void
  /** Bump to wipe the level cache and reload the visible set. */
  refreshTick: number
/** VSCode-style git decorations: normalized absolute path → row status
   *  (files carry their own status, folders the descendant aggregate).
   *  Absent → the tree renders clean (no badges, no fetch). */
  gitStatus?: ReadonlyMap<string, GitRowStatus>
  /** Upload into `dir` (absolute, inside the workspace); runs in the caller. */
  onUploadRequest?: (dir: string, items: UploadItem[]) => void
  /** True while an upload is in flight (drops are ignored). */
  busy?: boolean
}) {
  const { sessionId, cwd, expanded, ctx, revealed, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin, onReferenceFile, refreshTick, gitStatus, onUploadRequest, busy, sourceOverride } = props
  // The active icon theme's row resolver (null when no theme is active —
  // the built-in outline icons below stay the default).
  const fileIcon = useFileIconResolver(ctx)
  // The session's file-tree data source: undefined = the default local host
  // fs.tree; a matching provider (see file-tree-source.ts) replaces it for
  // ALL listings. Re-resolves live on registry changes (plugin activation).
  // In multi-root mode this single-source resolution is NOT consulted for
  // listings — each root carries its own source (see `loadDir` below).
  const resolvedFileSource = useFileTreeSource(ctx, sessionId, cwd)
  // A sourceOverride (v0.20.0) wins over the resolution — the hook above
  // still runs unconditionally (hooks order stays stable), only its result
  // is replaced. Everything downstream (capability gates, the mode key
  // `single:<providerId>`, the single-source listing selection) reads the
  // EFFECTIVE source, so the override path adapts with zero further change.
  const fileSource: ResolvedFileTreeSource | undefined = sourceOverride !== undefined ? sourceOverride : resolvedFileSource
  // The session's resolved REMOTE roots (multi-root mode): the caller's
  // resolution wins (TreePanel passes it down so panel gates and the tree
  // resolve roots once); without the prop the tree resolves on its own.
  const selfRoots = useFileTreeRoots(ctx, sessionId, cwd)
  // While the FIRST roots resolution is still in flight, the tree renders
  // the single-root path through the LOCAL route: a provider that declares
  // roots is multi-root-bound (its roots settle non-empty in the common
  // case), so letting the v0.17 single-source takeover serve the cwd tree
  // in that window would flash a provider listing under the local starting
  // point. If the roots settle EMPTY, the v0.17 takeover resumes (mode-key
  // wipe + reload) — one extra local read, never a wrong provider read.
  const rootsPending = props.roots !== undefined ? false : selfRoots === undefined
  const resolvedRoots: readonly ResolvedFileTreeRoot[] = props.roots !== undefined ? props.roots : (selfRoots ?? [])
  const multiRoot = resolvedRoots.length > 0
  // Local-only abilities in provider mode: on for local sessions, on for
  // provider sessions ONLY when the provider declared them (absent = off).
  const uploadOn = fileTreeCapabilityOn(fileSource, 'upload')
  const gitOn = fileTreeCapabilityOn(fileSource, 'git')
  // Git decorations only render when meaningful: local sessions, provider
  // sessions whose provider declared git support, and multi-root sessions
  // (the LOCAL root always carries the local repo's status; remote rows
  // never match its local-path map, so the overlay cannot bleed into
  // them — the caller also stops fetching in single-provider mode, which
  // guards callers that still pass a stale map).
  const effectiveGitStatus = (!multiRoot && !gitOn) ? undefined : gitStatus

  /**
   * Multi-root (v0.18.0+): whether `path` lies under directory `dir`
   * (equal, or a '/'- or '\'-separated descendant — remote-absolute
   * semantics may use either separator).
   */
  const underDir = (path: string, dir: string): boolean =>
    path === dir || path.startsWith(dir + '/') || path.startsWith(dir + '\\')

  /** The remote root owning a path, or undefined for the LOCAL subtree
   *  (paths under cwd always resolve local — the local root is never
   *  taken over, even when a remote root's dir string would prefix-match). */
  const rootAt = (path: string): ResolvedFileTreeRoot | undefined => {
    if (cwd !== undefined && underDir(path, cwd)) return undefined
    return resolvedRoots.find(root => underDir(path, root.dir))
  }

  /** One row's capability face: null = the FULL local face. Single-root
   *  mode → the session's resolved provider face (or null); multi-root →
   *  the owning root's face, the local subtree always null. */
  const faceOf = (path: string): FileTreeProviderCapabilities | null => {
    if (!multiRoot) return fileSource === undefined ? null : fileSource.capabilities
    return rootAt(path)?.capabilities ?? null
  }

  /** Whether one local ability is on for a path's surface. */
  const capOn = (path: string, key: keyof FileTreeProviderCapabilities): boolean => {
    const face = faceOf(path)
    return face === null || face[key] === true
  }

  /**
   * Open one FILE row (v0.20.0): when the row's capability face declares
   * `open` AND the source owning the row provides `open(path)` — the
   * provider owns the open (single-source mode: the session's effective
   * `fileSource`; multi-root mode: the source of the root owning the
   * path). Otherwise the caller's original `onOpenFile(path)` runs
   * unchanged, byte for byte.
   */
  const openFileRow = (path: string): void => {
    if (capOn(path, 'open')) {
      const source = multiRoot ? rootAt(path)?.source : fileSource?.source
      if (source !== undefined && typeof source.open === 'function') {
        source.open(path)
        return
      }
    }
    onOpenFile(path)
  }

  /** The body-level upload gate: in multi-root mode the BODY belongs to
   *  the local root (full local face — uploads into cwd always work);
   *  single-root mode keeps the v0.17 session face. */
  const bodyUploadOn = !multiRoot ? uploadOn : true

  /** The directory a row's relative-path copy is relative to: the row's
   *  OWN root in multi-root mode (local rows → cwd, remote rows → their
   *  root dir — a remote path relative to the local cwd would be
   *  meaningless), the session cwd in single-root mode (unchanged). */
  const relativeBaseOf = (path: string): string => {
    if (!multiRoot || cwd === undefined) return cwd ?? ''
    const root = rootAt(path)
    return root === undefined ? cwd : root.dir
  }

  /**
   * Multi-root (v0.18.0+): the root rows' expand/collapse state, keyed by
   * root dir strings — each root opens and collapses independently.
   * Seeded with the LOCAL root open (the local subtree stays visible with
   * its full local semantics from the first frame; remote roots start
   * collapsed). Sub-directory expansion below any root keeps riding the
   * caller's `expanded` set, so reveals and persistence stay untouched.
   */
  const [openRoots, setOpenRoots] = useState<ReadonlySet<string>>(() => new Set())
  const toggleRoot = useCallback((dir: string): void => {
    setOpenRoots(prev => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }, [])
  // Mode / cwd transitions (re)seed: entering multi-root opens the local
  // root; a cwd change (session switch) starts the list over.
  useEffect(() => {
    setOpenRoots(multiRoot && cwd !== undefined ? new Set([cwd]) : new Set())
  }, [multiRoot, cwd])
  // Roots-list changes prune STALE entries; the user's open/close state
  // survives untouched (expanding a root never re-collapses others).
  useEffect(() => {
    if (!multiRoot) return
    setOpenRoots(prev => {
      const valid = new Set<string>(cwd !== undefined ? [cwd] : [])
      for (const root of resolvedRoots) valid.add(root.dir)
      let changed = false
      for (const dir of prev) {
        if (!valid.has(dir)) { changed = true; break }
      }
      return changed ? new Set([...prev].filter(dir => valid.has(dir))) : prev
    })
  }, [multiRoot, cwd, resolvedRoots])
  // A "Show in folder" reveal of LOCAL paths opens the local root row even
  // when the user collapsed it first (the reveal would otherwise be
  // invisible under a closed root).
  useEffect(() => {
    if (!multiRoot || cwd === undefined || openRoots.has(cwd)) return
    if ((revealed ?? []).some(path => underDir(path, cwd))) {
      setOpenRoots(prev => new Set(prev).add(cwd))
    }
  }, [multiRoot, cwd, revealed, openRoots])
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  /** Whether a file drag hovers the tree (drives the portaled drop zone). */
  const [dropOver, setDropOver] = useState(false)
  /** The directory a drag is hovering right now (null = body, drop to root). */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** The indent-guide band under the pointer (null = none): while set, the
   *  whole vertical line of the hovered ancestor lights up across its
   *  visible subtree — the "click collapses this whole directory" signal. */
  const [hoverGuide, setHoverGuide] = useState<GuideHover | null>(null)
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

  /** The v0.20.0 stat-suffix priority state: the row's name span and meta
   *  span refs (keyed by row path, populated by per-row ref callbacks), the
   *  set of rows whose suffix is currently dropped (read during render — a
   *  re-render is driven by bumping `metaTick`) and each dropped row's
   *  last-known suffix width (measured when it dropped; re-shows need it to
   *  prove the suffix fits again). */
  const nameEls = useRef(new Map<string, HTMLSpanElement>())
  const metaEls = useRef(new Map<string, HTMLSpanElement>())
  const hiddenMetaPaths = useRef<ReadonlySet<string>>(new Set())
  const hiddenMetaWidth = useRef(new Map<string, number>())
  const [, bumpMetaTick] = useState(0)

  /**
   * The suffix-priority measurement pass: re-checks every rendered row's
   * geometry (run after each commit and on body resizes). Rows carrying the
   * suffix drop it while their name is being truncated; rows that dropped
   * it re-show only once the row proves there is room again (see
   * `metaSuffixFits`) — both directions re-render through `bumpMetaTick`
   * when the hidden set actually changed, so a stable layout costs nothing
   * per pass beyond the width reads. Reads only refs, so it is stable and
   * can be shared by the layout effect and the ResizeObserver.
   */
  const measureMetaPriority = useCallback((): void => {
    if (metaEls.current.size === 0 && hiddenMetaPaths.current.size === 0) return
    const nextHidden = new Set<string>()
    // Rows rendering the suffix: drop it while the name is being squeezed
    // ("no space left for icon + name"); remember the suffix's natural
    // width for the re-show check below.
    for (const [path, metaEl] of metaEls.current) {
      const nameEl = nameEls.current.get(path)
      if (nameEl === undefined) continue
      if (metaSuffixCramped(nameEl.scrollWidth, nameEl.clientWidth)) {
        nextHidden.add(path)
        hiddenMetaWidth.current.set(path, metaEl.scrollWidth)
      }
    }
    // Rows that dropped the suffix: re-show only once the row proves there
    // is room again (the name at full width + free space right of it ≥
    // suffix width + margin) — a fresh fit never re-cramps, so this
    // direction cannot ping-pong with the hide above.
    for (const path of hiddenMetaPaths.current) {
      if (nextHidden.has(path)) continue
      const nameEl = nameEls.current.get(path)
      if (nameEl === undefined) continue
      // The name is a direct child of the row (position: relative), so the
      // row's client width and the name's left offset are read from here.
      const rowEl = nameEl.parentElement
      if (rowEl === null) continue
      const metaWidth = hiddenMetaWidth.current.get(path) ?? 0
      if (metaSuffixFits(nameEl.scrollWidth, nameEl.clientWidth, rowEl.clientWidth, nameEl.offsetLeft, metaWidth)) {
        hiddenMetaWidth.current.delete(path)
      } else {
        nextHidden.add(path)
      }
    }
    if (nextHidden.size !== hiddenMetaPaths.current.size
      || [...nextHidden].some(path => !hiddenMetaPaths.current.has(path))) {
      hiddenMetaPaths.current = nextHidden
      bumpMetaTick(tick => tick + 1)
    }
  }, [])

  // After every commit (listings, expansions, suffix toggles): keep the
  // suffix visibility in sync with the row geometry before the paint.
  useLayoutEffect(() => {
    measureMetaPriority()
  })

  // Panel resizes are the main reason a row's room changes without a
  // re-render — observe the tree body (rAF-throttled; the pass is O(rows
  // with a suffix) and gated by the same refs).
  useEffect(() => {
    const body = bodyRef.current
    if (body === null || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measureMetaPriority()
      })
    })
    observer.observe(body)
    return () => {
      observer.disconnect()
      if (frame !== 0) {
        cancelAnimationFrame(frame)
        frame = 0
      }
    }
  }, [measureMetaPriority])

  /** Reset all drag state (drop landed, the drag left, or a new drag begins). */
  const resetDrop = (): void => {
    dropDepth.current = 0
    setDropOver(false)
    setDropTarget(null)
    setDropRect(null)
  }

  /**
   * Drop handlers: always swallow the event (a dropped file must never open
   * in the browser), then report the target directory to the caller. A drop
   * ends the drag without further leave events, so the depth resets here.
   * The payload collection is async (dropped folders are traversed through
   * their entry handles — captured synchronously inside uploadItemsFromDrop
   * while the dataTransfer is still live), so the request rides a then.
   */
  const reportDrop = (dir: string, data: DataTransfer | undefined): void => {
    if (busy === true) return
    void uploadItemsFromDrop(data).then((items) => {
      if (items.length > 0) onUploadRequest?.(dir, items)
    })
  }
  const handleBodyDrop = (event: DragEvent): void => {
    if (!isFileDrag(event) || !bodyUploadOn) return
    event.preventDefault()
    event.stopPropagation()
    resetDrop()
    if (cwd !== undefined) reportDrop(cwd, event.dataTransfer)
  }
  const handleDirDrop = (event: DragEvent, dir: string): void => {
    if (!isFileDrag(event)) return
    if (!capOn(dir, 'upload')) {
      // A remote surface whose provider did not declare upload is INERT:
      // swallow the drop so it can never fall through to the local root
      // underneath (single-root mode keeps the v0.17 pass-through).
      if (multiRoot) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    resetDrop()
    reportDrop(dir, event.dataTransfer)
  }
  const handleFileDrop = (event: DragEvent, path: string): void => {
    // VSCode semantics: dropping onto a file uploads into its directory.
    handleDirDrop(event, parentOf(path))
  }
  const handleBodyDragEnter = (event: DragEvent): void => {
    if (!isFileDrag(event) || !bodyUploadOn) return
    event.preventDefault()
    event.stopPropagation()
    dropDepth.current += 1
    if (busy === true) return
    // First entry: anchor the portaled drop zone to the body's rect.
    if (dropDepth.current === 1) {
      const rect = bodyRef.current?.getBoundingClientRect()
      setDropRect(rect === undefined ? null : { top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }
    setDropOver(true)
  }
  const handleBodyDragLeave = (): void => {
    dropDepth.current = Math.max(0, dropDepth.current - 1)
    if (dropDepth.current > 0) return
    setDropOver(false)
    setDropTarget(null)
    setDropRect(null)
  }
  const handleBodyDragOver = (event: DragEvent): void => {
    if (!isFileDrag(event) || !bodyUploadOn) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
    if (busy === true) return
    // Rows stop propagation, so this only fires over non-row regions: the
    // drag targets the workspace root. dragover fires continuously, making
    // it the authoritative (flicker-free) place to clear the row target.
    setDropTarget(null)
  }
  const handleRowDragOver = (event: DragEvent, dir: string): void => {
    if (!isFileDrag(event)) return
    if (!capOn(dir, 'upload')) {
      // Inert remote surface: mark the row as no-drop so the browser never
      // offers the local-root fallback beneath it (multi-root only).
      if (multiRoot) {
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'none'
      }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy'
    if (busy === true) return
    setDropTarget(dir)
  }

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  /** One directory level's data source: 'local' forces the local host
   *  fs.tree route; a source carries the provider's live listing. */
  type DirSource = 'local' | FileTreeDataSource

  const loadDir = useCallback((dir: string, source: DirSource) => {
    if (dataRef.current[dir] !== undefined) return
    storeLevel(dir, {})
    // THE single data-source diverge point: a remote root's provider
    // `list` replaces the default local host fs.tree for listings under
    // that root; the LOCAL root (and every single-root path) always runs
    // through the local route. Everything downstream (the level cache,
    // rendering, the refreshTick wipe) is source-agnostic, so a refresh
    // bump reloads the visible set through whichever source is resolved —
    // exactly the local semantics, provider or not.
    const request: Promise<LevelData> = (async () => {
      if (source === 'local') {
        const listing = await api.fsTree({ sessionId, cwd }, dir)
        return { entries: listing.entries }
      }
      const result = await source.list(dir)
      if ('error' in result) return { error: result.error }
      return { entries: normalizeFileTreeEntries(result.entries) }
    })()
    request.then(level => { storeLevel(dir, level) }).catch((error: unknown) => {
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

  // The RESOLVED MODE switching — the single-source provider (v0.17) or
  // the multi-root composition (v0.18) — wipes the cache too, so the load
  // effect below (whose `loadDir` identities follow the sources) refetches
  // the visible set through the NEW sources with no refresh bump. Guarded
  // by a mode key: a registry notification that re-resolves to the same
  // mode only changes object identities — the cache survives and nothing
  // refetches, exactly the pre-slot behavior.
  const lastModeKey = useRef<string | null>(null)
  useEffect(() => {
    const key = multiRoot
      ? `multi:${resolvedRoots.map(root => `${root.providerId}/${root.id}@${root.dir}`).join(',')}`
      : rootsPending
        ? 'pending'
        : fileSource === undefined ? null : `single:${fileSource.providerId}`
    if (lastModeKey.current === key) return
    lastModeKey.current = key
    dataRef.current = {}
    setData({})
  }, [multiRoot, resolvedRoots, fileSource, rootsPending])

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only the refresh tick wipes the cache.
    if (!multiRoot) {
      const root = cwd
      if (root === undefined) return
      // While the roots resolution is in flight the local route serves the
      // cwd tree (see `rootsPending`); the v0.17 single-source takeover
      // applies only once the session settled with NO remote roots.
      const singleSource: DirSource = !rootsPending && fileSource !== undefined ? fileSource.source : 'local'
      loadDir(root, singleSource)
      for (const dir of expanded) {
        // Pending window: only dirs under the local root are legitimate
        // targets (the remote dirs are not mapped to any source yet —
        // loading them through the local route would be a wrong read).
        if (rootsPending && (cwd === undefined || !underDir(dir, cwd))) continue
        loadDir(dir, singleSource)
      }
      return
    }
    // Multi-root: each OPEN root row loads its own dir — the local root
    // ALWAYS from the local host (never taken over by a provider), each
    // remote root from its providing provider — plus every expanded dir
    // under it (level caches key by dir string, so the local and remote
    // path namespaces never collide).
    if (cwd !== undefined && openRoots.has(cwd)) {
      loadDir(cwd, 'local')
      for (const dir of expanded) {
        if (underDir(dir, cwd)) loadDir(dir, 'local')
      }
    }
    for (const root of resolvedRoots) {
      if (!openRoots.has(root.dir)) continue
      loadDir(root.dir, root.source)
      for (const dir of expanded) {
        if (underDir(dir, root.dir)) loadDir(dir, root.source)
      }
    }
  // The mode inputs are deps so a resolved-mode change (registry tick,
  // roots settlement) re-runs this effect right after the mode-key wipe —
  // the wipe clears the cache and the reload must follow through the NEW
  // sources. A same-mode re-resolution only changes `fileSource`'s object
  // identity → this effect re-runs against the intact cache (loadDir is
  // cache-guarded, so nothing refetches).
  }, [cwd, expanded, refreshTick, loadDir, multiRoot, openRoots, resolvedRoots, fileSource, rootsPending])

  // Bring a "Show in folder" reveal into view: the ancestors expand above
  // (revealPaths), but the row may not be scrolled into sight — a reveal on
  // a long tree should surface the highlighted file. Re-runs when the tree
  // data or reveal set changes (the row appears after its level loads).
  useEffect(() => {
    if ((revealed ?? []).length === 0) return
    const row = bodyRef.current?.querySelector('[data-dsh-revealed]')
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
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

  /** The menu label of one open target: a locale key for the built-ins, the
   *  user's own name for custom editors, plus the SSH hint in remote mode. */
  const openWithLabelOf = (target: OpenWithTarget): string => {
    const name = target.nameKey !== undefined ? t(target.nameKey) : target.name
    return openWithSsh === true && !target.localOnly ? `${name}${t('openWithSshSuffix')}` : name
  }

  /**
   * The "open with" menu entries: the pinned targets as DIRECT rows, then
   * the parent row with every target as a nested submenu. Both only render
   * when the caller wired the feature and at least one target is visible.
   */
  const openWithEntries = (on: boolean): MenuEntry[] => {
    if (openWithTargets === undefined || onOpenWith === undefined || openWithTargets.length === 0 || !on) return []
    const pinnedIds = openWithPinned ?? []
    /** Brand marks for the built-ins (monochrome silhouettes, currentColor);
     *  reveal gets the folder glyph, custom editors a generic code mark. */
    const itemIcon = (target: OpenWithTarget): ReactNode => {
      if (target.kind === 'reveal') return <VscFolderOpened size={16} />
      if (target.id === 'vscode') return <IconVscode16 size={16} />
      if (target.id === 'cursor') return <SiCursor size={16} />
      if (target.id === 'zed') return <SiZedindustries size={16} />
      return <IconCodeOutline16 size={16} />
    }
    const pinned = openWithTargets
      .filter(target => pinnedIds.includes(target.id))
      .map<MenuItem>(target => ({
        id: `open-with:${target.id}`,
        label: openWithLabelOf(target),
        icon: itemIcon(target),
      }))
    const submenu = openWithTargets.map<MenuItem>(target => {
      const pinnedNow = pinnedIds.includes(target.id)
      return {
        id: `open-with:${target.id}`,
        label: (
          <span className={css.openWithLabel}>
            <span className={css.openWithName}>{openWithLabelOf(target)}</span>
            {/* The pushpin: a span (never a button — the Menu row itself is
                a button, so a nested interactive element would be invalid).
                Clicking it pins/unpins the target at the menu's top level
                WITHOUT selecting the row: the pin stops propagation, so the
                menu stays open and the icon flips on the next render. */}
            <span
              role="button"
              tabIndex={-1}
              className={clsx(css.openWithPin, pinnedNow && css.openWithPinActive)}
              aria-label={pinnedNow ? t('unpinOpenWith') : t('pinOpenWith')}
              title={pinnedNow ? t('unpinOpenWith') : t('pinOpenWith')}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onToggleOpenWithPin?.(target.id)
              }}
            >
              {pinnedNow ? <VscPinned size={14} /> : <VscPin size={14} />}
            </span>
          </span>
        ),
        icon: itemIcon(target),
      }
    })
    return [
      ...pinned,
      ...(pinned.length > 0 ? [{ id: 'open-with-sep', type: 'separator' } as MenuEntry] : []),
      {
        id: 'open-with-menu',
        // The primitives Menu renders no chevron for submenu parents — the
        // trailing arrow is supplied inside the label (full-width flex row,
        // right-aligned), matching how the submenu rows right-align the pin.
        label: (
          <span className={css.openWithLabel}>
            <span className={css.openWithName}>{t('openWithMenu')}</span>
            <IconChevronRightOutline14 size={14} className={css.openWithChevron} aria-hidden />
          </span>
        ),
        icon: <VscLinkExternal size={16} />,
        submenu,
      },
    ]
  }

  const root = cwd

  // Plugin-command rows for the row context menu (v0.16.0+): appended
  // after the built-in rows, driven by the pure builder — zero logic here.
  // Multi-root: every root row (local + remote) is a root-row surface.
  const isRootRow = (path: string): boolean =>
    path === root || resolvedRoots.some(candidate => candidate.dir === path)
  const rowWhere: CommandMenuWhere = rowMenu === null
    ? 'file-row'
    : rowMenu.isDir
      ? (isRootRow(rowMenu.path) ? 'root-row' : 'dir-row')
      : 'file-row'
  const commandItems = ctx?.betterSidebar === undefined ? [] : commandMenuRows(
    ctx.betterSidebar.getCommands(),
    rowWhere,
    { path: rowMenu?.path, isDir: rowMenu?.isDir, isRoot: rowMenu !== null && isRootRow(rowMenu.path), sessionId },
  )

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    if (level !== undefined && level.error !== undefined) {
      return (
        <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * INDENT_STEP + INDENT_BASE }}>
          {level.error}
        </div>
      )
    }
    // In-flight level: the expand commit lands the `{}` placeholder (the
    // pre-effect window is `undefined`) — both render one dimmed loading row
    // so a slow subfolder listing reads as working instead of a frozen gap
    // (previously the whole fetch rendered nothing). A LOADED empty level
    // carries `entries: []` and renders nothing, exactly as before.
    if (level === undefined || level.entries === undefined) {
      return (
        <div
          role="status"
          className={css.explorerRow}
          style={{ paddingLeft: depth * INDENT_STEP + INDENT_BASE }}
        >
          <IconLoadingOutline16 size={12} className={css.explorerLoadingSpin} />
          <span className={css.explorerLoading}>{t('loading')}</span>
        </div>
      )
    }
    const entries = level.entries
    if (entries.length === 0) return null
    return entries.map(entry => {
      const status = gitStatusAt(effectiveGitStatus, entry.path)
      // The dimmed stat suffix (v0.20.0): provider-fed rows may carry
      // `meta`; local rows never do → null keeps their render exact.
      const meta = metaSuffix(entry.meta)
      // v0.20.0 display priority: the size/time suffix yields to the icon +
      // name — while the measurement pass has this row marked as cramped the
      // suffix is dropped (the name reclaims the row). Re-renders arrive via
      // `bumpMetaTick`, the refs below feed the pass.
      const metaShown = meta !== null && !hiddenMetaPaths.current.has(entry.path)
      // Per-row name/meta refs (the renderLevel map is the one place every
      // row of the tree is created): the pass reads these to decide.
      const nameRef = (el: HTMLSpanElement | null): void => {
        if (el === null) nameEls.current.delete(entry.path)
        else nameEls.current.set(entry.path, el)
      }
      const metaRef = (el: HTMLSpanElement | null): void => {
        if (el === null) metaEls.current.delete(entry.path)
        else metaEls.current.set(entry.path, el)
      }
      // While a guide band is hovered, the ancestor's whole line lights up:
      // every row whose stroke at the hovered column belongs to the same
      // ancestor renders that stroke highlighted — the hovered row included
      // (its band sits on that column), so the full line from the ancestor's
      // corner down through its visible subtree reads as the collapse target.
      const highlightCol = hoverGuide !== null && hoverGuide.col < depth
        && ancestorAtDepth(entry.path, depth, hoverGuide.col) === hoverGuide.ancestor
        ? hoverGuide.col
        : undefined
      if (entry.isDir) {
        const isOpen = expanded.includes(entry.path)
        return (
          <div key={entry.path}>
            <div
              role="button"
              tabIndex={0}
className={clsx(
                css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden,
                dropTarget === entry.path && css.explorerRowDropTarget,
                (revealed ?? []).includes(entry.path) && css.explorerRowRevealed,
              )}
              data-dsh-revealed={(revealed ?? []).includes(entry.path) ? 'true' : undefined}
              style={{
                paddingLeft: depth * INDENT_STEP + INDENT_BASE,
                ...treeGuideBackground(depth, isOpen, highlightCol),
              }}
              onClick={() => { onToggle(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggle(entry.path)
                }
              }}
              onDragOver={(event) => { handleRowDragOver(event, entry.path) }}
              onDrop={(event) => { handleDirDrop(event, entry.path) }}
              onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
            >
              {guideHitBands(entry.path, depth, onToggle, setHoverGuide)}
{fileIcon({ name: entry.name, isDir: true, expanded: isOpen }) ?? (isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />)}
              <span ref={nameRef} className={clsx(css.explorerName, status !== undefined && gitKindCss[status.kind])}>{entry.name}</span>
              {metaShown && <span ref={metaRef} className={css.explorerMeta}>{meta}</span>}
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
            dropTarget === parentOf(entry.path) && css.explorerRowDropTarget,
            (revealed ?? []).includes(entry.path) && css.explorerRowRevealed,
          )}
          data-dsh-revealed={(revealed ?? []).includes(entry.path) ? 'true' : undefined}
          style={{
            paddingLeft: depth * INDENT_STEP + INDENT_BASE,
            ...treeGuideBackground(depth, false, highlightCol),
          }}
          title={entry.broken ? `${entry.path} — ${t('brokenSymlink')}` : entry.path}
          onClick={() => { openFileRow(entry.path) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openFileRow(entry.path)
            }
          }}
          onDragOver={(event) => { handleRowDragOver(event, parentOf(entry.path)) }}
          onDrop={(event) => { handleFileDrop(event, entry.path) }}
          onContextMenu={(event) => { openRowMenu(event, entry.path, false) }}
        >
          {guideHitBands(entry.path, depth, onToggle, setHoverGuide)}
{fileIcon({ name: entry.name, isDir: false }) ?? <IconCodeOutline16 size={14} />}
          <span ref={nameRef} className={clsx(css.explorerName, status !== undefined && gitKindCss[status.kind])}>{entry.name}</span>
          {metaShown && <span ref={metaRef} className={css.explorerMeta}>{meta}</span>}
          {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
          {gitBadge(status)}
          {rowActions(entry)}
        </div>
      )
    })
  }

  /**
   * One root-list row (multi-root, v0.18.0+): a chevron + folder icon +
   * label line distinct from plain directory rows (filled tint, absolute
   * dir as title). Clicking toggles THIS root's open state (independent of
   * every other root and of the caller's `expanded` set); open roots
   * render their subtree below with the shared row rendering at depth 1.
   * Drop + context-menu surfaces behave like a directory row, gated by
   * the root's own capability face (the local root keeps the full face).
   */
  const renderRootRow = (rowDir: string, rowLabel: string): ReactNode => {
    const open = openRoots.has(rowDir)
    return (
      <div key={`root:${rowDir}`}>
        <div
          role="button"
          tabIndex={0}
          className={clsx(css.explorerRow, css.explorerRootRow, dropTarget === rowDir && css.explorerRowDropTarget)}
          title={rowDir}
          onClick={() => { toggleRoot(rowDir) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleRoot(rowDir)
            }
          }}
          onDragOver={(event) => { handleRowDragOver(event, rowDir) }}
          onDrop={(event) => { handleDirDrop(event, rowDir) }}
          onContextMenu={(event) => { openRowMenu(event, rowDir, true) }}
        >
          <VscChevronRight
            size={14}
            className={css.explorerRootChevron}
            style={{ transform: open ? 'rotate(90deg)' : undefined }}
          />
          {fileIcon({ name: baseName(rowDir), isDir: true, expanded: open, isRoot: true }) ?? (open ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />)}
          <span className={css.explorerName}>{rowLabel}</span>
          {copiedPath === rowDir
            ? <span className={css.explorerCopied}>{t('copied')}</span>
            : (
              <button
                type="button"
                className={css.explorerRef}
                aria-label={t('referenceFile')}
                title={t('referenceFile')}
                onClick={(event) => {
                  event.stopPropagation()
                  onReferenceFile(rowDir)
                }}
              >
                {t('referenceFile')}
              </button>
            )}
        </div>
        {open && data[rowDir] !== undefined && renderLevel(rowDir, 1)}
      </div>
    )
  }

  /** Multi-root (v0.18.0+): the root LIST body — the LOCAL starting point
   *  first (full local semantics, collapsible like any root row but open
   *  by default), then each provider-contributed remote root. Rows
   *  distinguish themselves from plain directory rows visually (root-row
   *  fill + chevron) and carry the root's absolute dir in their title. */
  const rootsBody = multiRoot ? (
    <>
      {cwd !== undefined && renderRootRow(cwd, baseName(cwd))}
      {/* A remote root whose dir equals the local cwd is unreachable
          (local paths always resolve local) — skip it so the root list
          never renders two rows for one dir. */}
      {resolvedRoots.filter(candidate => candidate.dir !== cwd).map(candidate => renderRootRow(candidate.dir, candidate.label))}
    </>
  ) : null

  return (
    <div
      ref={bodyRef}
      className={css.explorerBody}
      onDragEnter={handleBodyDragEnter}
      onDragOver={handleBodyDragOver}
      onDragLeave={handleBodyDragLeave}
      onDrop={handleBodyDrop}
    >
      {root === undefined ? (
        rootsBody ?? <div className={css.explorerEmpty}>{t('noSession')}</div>
      ) : (
        <>
          {rootsBody ?? (
            <>
              <div
className={clsx(css.explorerRow, dropTarget === root && css.explorerRowDropTarget)}
                style={{ paddingLeft: INDENT_BASE }}
                onDragOver={(event) => { handleRowDragOver(event, root) }}
                onDrop={(event) => { handleDirDrop(event, root) }}
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
        </>
      )}
      {dropOver && dropRect !== null && createPortal(
        /*
         * The sidebar's drop surface, portaled to document.body at z-1001 —
         * above DSH's own whole-page drop mask (z-1000, see InputBar's
         * document-level intake) so the two never compete. It dims the WHOLE
         * viewport (the giant box-shadow spread on the zone frame is the
         * mask; the zone rect itself stays clear), teaching the zone split:
         * the dimmed conversation column still takes drops into the chat
         * natively (this layer is pointer-inert), while the clear frame
         * marks the tree as the workspace-upload zone. Deliberate exception
         * to the "panel stays below the DSH float stack" rule: transient,
         * and the drop always lands on the element beneath. The hint pill
         * docks at the TOP edge of the zone — right under the search row,
         * the first thing the eye meets — keeping the rows aimable.
         */
        <>
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
          if (dir !== undefined && busy !== true) onUploadRequest?.(dir, uploadItemsFromFiles(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // The open escapes head the FILE menu (dirs only get copy).
          ...(rowMenu?.isDir === false && onOpenFileNewTab !== undefined
            ? [{ id: 'open-new-tab', label: t('openFileNewTab'), icon: <IconCodeOutline16 size={16} /> }]
            : []),
          ...(rowMenu?.isDir === false && onOpenFileSide !== undefined
            ? [{ id: 'open-side', label: t('openFileSide'), icon: <VscFolderOpened size={16} /> }]
            : []),
          // The open-with section gates on the TARGET row's capability
          // face: full local face for local roots/sessions, the row's
          // provider face inside a remote root (absent = off).
          ...openWithEntries(rowMenu !== null && capOn(rowMenu.path, 'openWith')),
          // Download applies to files only (the host route refuses
          // directories); hidden in provider mode unless the provider
          // declared download support (the local file route cannot serve
          // paths it does not own) — per-row face in multi-root mode.
          ...(rowMenu?.isDir === false && rowMenu !== null && capOn(rowMenu.path, 'download')
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={16} /> }]
            : []),
// Upload into a directory (incl. the workspace root row); hidden in
// provider mode unless the provider declared upload support — per-row
// face in multi-root mode (the local root keeps it unconditionally).
          ...(rowMenu?.isDir === true && rowMenu !== null && capOn(rowMenu.path, 'upload')
            ? [{ id: 'upload-here', label: t('uploadHere'), icon: <IconUploadOutline16 size={16} /> }]
            : []),
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={16} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={16} /> },
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
          if (id.startsWith('open-with:')) {
            onOpenWith?.(id.slice('open-with:'.length), target.path)
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
          if (id === 'relative') {
            copyPath(relativeTo(relativeBaseOf(target.path), target.path), target.path)
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
            sessionId,
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
