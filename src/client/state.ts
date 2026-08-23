/**
 * Per-session sidebar state: the panel geometry, the split-pane workbench
 * tree, open tabs, and the explorer expansion set. One state instance per
 * conversation id, persisted to localStorage under `dsh-sidebar:v1:<id>` so
 * a reload restores the exact layout of the session it belongs to — switching
 * conversations swaps the whole state (memory + isolation).
 *
 * The split tree is a recursive structure: a leaf holds a tab group, a split
 * divides the space row- or column-wise with fractional sizes. All tree
 * operations are pure functions over the node, unit-tested in tests/state.spec.ts.
 */
import { SIDEBAR_BAR_WIDTH_DEFAULT, SIDEBAR_PREFS_DEFAULTS, clampSidebarBarWidth, type SidebarPrefs } from '../prefs-shared.ts'
import { isNarrowWidth } from './breakpoints.ts'

/**
 * Tab type identifier. Builtins register their ids (editor / git / terminal
 * / subagent / browser / diff) through the sidebar service; external
 * plugins register their own (e.g. `'my-plugin:db'`). Kept as `string` so
 * the registry stays open.
 */
export type TabType = string

/** What a diff tab shows: a worktree/index change of one path, or one commit's full patch. */
export type SidebarDiffRef =
  | { kind: 'worktree'; path: string; staged: boolean; untracked?: boolean }
  | { kind: 'commit'; hash: string; hashFull: string; subject: string }

/** One open tab. `path` carries the file (editor) or is absent (git/terminal);
 *  `diff` carries the change a diff tab shows; `meta` (v0.12.0+) carries
 *  plugin-owned JSON-serializable state, preserved across reloads. */
export interface SidebarTab {
  id: string
  type: TabType
  title: string
  path?: string
  diff?: SidebarDiffRef
  /** Plugin-owned state (v0.12.0+): MUST be JSON-serializable — it is
   *  persisted with the layout and restored verbatim on reload. */
  meta?: unknown
}

/**
 * Reserved tab-id prefix for workspace-bound windows (the "stub" tabs).
 * Stub ids are minted by the workspace windows store (`ws:<wsId8>:<n>`)
 * and never by tab descriptors — like `agent:`, the prefix is a namespace
 * contract: external code must not mint ids under it.
 */
export const WS_TAB_PREFIX = 'ws:'

/**
 * Reserved tab-id prefix for GLOBAL-bound window stubs (the instance-level
 * "all projects" shared tabs). Minted by the workspace windows store as
 * `gb:<uuid>` and never by tab descriptors. A `gb:` stub hosts a
 * GLOBAL-SHARED pty: every session of the instance (workspace or not)
 * attaches to the same process.
 */
export const GB_TAB_PREFIX = 'gb:'

/**
 * The reserved session id of the GLOBAL WORKSPACE — a special, virtual
 * session that owns its own sidebar state (incl. a bottom workbench) even
 * though it is not a real DSH conversation. The full-page Global Workspace
 * (GlobalPage) renders it in the conversation slot; a globally shared
 * window attaches into ITS bottom workbench (attachGlobal) instead of any
 * real session's tab bar. Its state persists under its own localStorage key
 * (`dsh-sidebar:v1:global-workspace`), so attached terminals survive
 * reloads. Real session ids are uuids, so the reserved string never
 * collides.
 */
export const GLOBAL_WORKSPACE_SESSION_ID = 'global-workspace'

/** Whether a tab id refers to a global-bound window stub (`gb:`). */
export function isGlobalTabId(tabId: string): boolean {
  return tabId.startsWith(GB_TAB_PREFIX)
}

/** Whether a tab id refers to a shared window stub (workspace `ws:` OR
 *  global `gb:`). Global stubs ride the same reconcile/persist/render
 *  machinery as workspace stubs, differing in that a session ATTACHES one
 *  on demand (they never auto-merge into every session). */
export function isBoundTabId(tabId: string): boolean {
  return tabId.startsWith(WS_TAB_PREFIX) || isGlobalTabId(tabId)
}

/**
 * One workspace-bound window: the workspace-scoped definition of a pinned
 * tab, shared by every session of a workspace. Sessions hold only a stub
 * reference (id + type) in their first leaf; the live definition
 * (title/path/diff/meta) always comes from the workspace windows store, so
 * a change in one session re-renders in all of them. The stub id is stable
 * across reloads (per-workspace persisted counter). Content windows carry
 * their full definition (path/diff); session-scoped views (terminal/git/
 * subagent/Files home) carry type+title only — each session renders its own
 * live instance of the shared window.
 */
/** Which panel a workspace-bound window's stub lives in (the area the
 *  window occupied at bind time). 'right' = the right panel's first leaf
 *  (`splits`), 'bottom' = the bottom box's first leaf (`bottomSplits`).
 *  Per-window, so every session renders the shared window in the same
 *  area. Legacy persisted blobs (pre-area) default to 'bottom' — the
 *  original always-bottom behavior. */
export type WorkspaceArea = 'right' | 'bottom'

/** One workspace-bound window ("pinned" tab shared by every session of a
 *  workspace). The single source of truth for the window's definition: a
 *  change in one session re-renders in all of them. The stub id is stable
 *  across reloads (per-workspace persisted counter). Content windows carry
 *  their full definition (path/diff); session-scoped views (terminal/git/
 *  subagent/Files home) carry type+title only — each session renders its own
 *  live instance of the shared window. */
export interface WorkspaceWindow {
  /** The stable stub id (`ws:<wsId8>:<n>`). */
  id: string
  type: TabType
  title: string
  path?: string
  diff?: SidebarDiffRef
  meta?: unknown
  /** The panel whose first leaf hosts this window's stub (the area the
   *  window was bound from). */
  area: WorkspaceArea
}

/** The face the SidebarStore consumes from the workspace windows store:
 *  session→windows resolution and change subscription. Defined here (not in
 *  workspace-windows.ts) so state.ts stays free of a runtime dependency on
 *  the store module. */
export interface WorkspaceWindowsSource {
  /** The bound windows of the workspace owning `sessionId` ([] when the
   *  session belongs to no workspace, or the feed is unavailable). */
  windowsOfSession(sessionId: string): readonly WorkspaceWindow[]
  /** The instance-level GLOBAL windows (the "all projects" shared stubs).
   *  Sessions never AUTO-merge them (they park in the Global Workspace and
   *  attach to a session on demand); the list only VALIDATES a session's
   *  attached `gb:` stubs (a stub whose window is gone is stale). */
  globalWindows(): readonly WorkspaceWindow[]
  /** Fires on ANY workspace-windows change (bind/unbind/update, workspace
   *  membership changes). Returns the disposer. */
  subscribe(listener: () => void): () => void
}

/** A tab group. */
export interface SidebarLeaf {
  kind: 'leaf'
  id: string
  tabs: SidebarTab[]
  active: string | null
}

/** A recursive split between child panes (fractional sizes summing to 1). */
export interface SidebarSplit {
  kind: 'split'
  id: string
  dir: 'row' | 'col'
  sizes: number[]
  children: SplitNode[]
}

export type SplitNode = SidebarLeaf | SidebarSplit

/** The full per-session state. */
export interface SidebarState {
  panelOpen: boolean
  width: number
  /** The pane receiving newly opened tabs (last pane the user touched).
   *  Pane ids are globally unique across BOTH trees (shared uid counter), so
   *  one field resolves into either tree — see {@link treeOf}. */
  activePane: string | null
  /** Monotonic terminal tab counter (ids survive reloads). */
  nextTerminal: number
  /** Monotonic browser tab counter (ids survive reloads; mirrors nextTerminal). */
  nextBrowser: number
  /** Explorer expansion set (absolute directory paths). */
  expanded: string[]
  /** The right sidebar's split tree (the original workbench). */
  splits: SplitNode
  /** Whether the bottom panel (a second, independent workbench) is open. */
  bottomOpen: boolean
  /** The bottom panel's height (clamped to the contract range). */
  bottomHeight: number
  /**
   * Whether the bottom panel has been expanded at least once in this
   * session — the FIRST expansion tries to auto-open a terminal tab (gated
   * on the bottomPanelAutoTerminal pref); later expansions never do.
   */
  bottomOpenedOnce: boolean
  /**
   * Whether the bottom panel is MAXIMIZED (⌘⇧J): it covers the whole center
   * column (full viewport height) instead of its drag height, and the
   * layout push is released so the conversation sits BEHIND the panel
   * instead of being squeezed. Closing the panel forgets the flag; the
   * previous `bottomHeight` survives, so un-maximizing restores it.
   */
  bottomMaximized: boolean
  /**
   * Whether the RIGHT panel is in IDE FULLSCREEN (⌘⌥⇧B): the panel covers
   * the whole viewport like a standalone VSCode window (width 100vw,
   * z-index above the app chrome), the layout push is released, and the
   * bottom panel is covered behind it. Entering opens the panel; closing
   * the panel forgets the flag. The previous `width` survives, so exiting
   * restores the docked size.
   */
  rightMaximized: boolean
  /** The bottom panel's own split tree (panes/tabs live only in ONE tree;
   *  tabs never cross panels — the two panels only share panel-size drags). */
  bottomSplits: SplitNode
  /**
   * The vscode Side Bar's active view id (the independent file-tree column
   * shown in `sidebarLayout: 'vscode'`). Currently only `'explorer'` is
   * rendered (the file tree + search); the field is reserved for future
   * view switching. Defaults to `'explorer'`; ignored in docked mode.
   */
  sideBarView: string
  /** The vscode Side Bar's width in px (clamped to the contract range).
   *  Ignored in docked mode. */
  sideBarWidth: number
  /**
   * Whether the vscode EXPLORER drawer (the independent file-tree column) is
   * expanded. Toggled by the Activity Bar's explorer icon; when collapsed the
   * editor group takes the full panel width. Defaults to expanded (true) so
   * an upgrade never hides the file tree silently. Ignored in docked mode.
   */
  sideBarOpen: boolean
}

export const PANEL_MIN = 280
export const PANEL_MAX = 640
export const PANEL_DEFAULT = 400
export const TAB_MAX_WIDTH = 160
/** Bottom panel geometry contract (mirrors the width contract; the upper
 * bound is the viewport, enforced by {@link setBottomHeight}). */
export const BOTTOM_MIN = 120
export const BOTTOM_DEFAULT = 220

/** The vscode Side Bar width contract (mirrors the docked tree's bounds;
 *  the constants live in prefs-shared so both halves share them, but the
 *  defaults are repeated here for the state seed). */
const SIDEBAR_BAR_VIEW_DEFAULT = 'explorer'

let nextIdCounter = 0
/** Unique pane/tab id within one state instance. */
function uid(prefix: string): string {
  nextIdCounter += 1
  return `${prefix}:${nextIdCounter}`
}

/** Mint a fresh uid-based tab id. The `'editor:' + path` convention only
 *  covers openSidebarFile opens (per-path dedupe); opens that must not
 *  dedupe (the tree's "open to the side") mint through here. */
export function mintTabId(): string {
  return uid('tab')
}

/**
 * The largest numeric suffix across a raw persisted state's counter ids
 * (`pane:N` / `tab:N` / `split:N`). The uid counter is module-global and
 * resets on every reload, so a split minted AFTER a reload would collide
 * with the persisted ids (a fresh "pane:1" beside the persisted "pane:1");
 * mapLeaf would then visit BOTH leaves and every open would land in both
 * panes of the split. Seeding the counter past the persisted ids keeps
 * fresh ids disjoint.
 */
function maxCounterId(parsed: unknown): number {
  let max = 0
  const consider = (id: unknown): void => {
    if (typeof id !== 'string') return
    const match = /^(?:pane|tab|split):(\d+)$/.exec(id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    consider(record.id)
    if (Array.isArray(record.tabs)) {
      for (const tab of record.tabs) {
        if (tab !== null && typeof tab === 'object') consider((tab as Record<string, unknown>).id)
      }
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) walk(child)
    }
  }
  walk((parsed as Record<string, unknown> | null)?.splits)
  walk((parsed as Record<string, unknown> | null)?.bottomSplits)
  return max
}

/** The default tab a fresh session seeds. */
export type DefaultSeed = 'editor-home' | 'none'

/** A fresh default state: one seeded tab in one pane, open per the caller's
 * preference. `width` is the caller's preferred panel width (default
 * PANEL_DEFAULT) and `panelOpen` whether the panel starts expanded (default
 * true); the store seeds new sessions from the user's side card prefs.
 * `seed` picks the seeded tab: 'editor-home' places the EMPTY files window
 * (an editor tab with no path whose tree panel starts open,
 * `meta.treeOpen: true`) — in BOTH editorExplorer modes that window is the
 * file explorer page — and 'none' starts with an empty pane (the store
 * passes it when the user disabled the editor tab type in settings). */
export function makeDefaultState(width = PANEL_DEFAULT, panelOpen = true, seed: DefaultSeed = 'editor-home'): SidebarState {
  const leaf: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [], active: null }
  if (seed === 'editor-home') {
    // No path: the editor host renders its empty-state hint and the docked
    // tree panel (treeOpen defaults open for path-less tabs; meta pins it).
    leaf.tabs = [{ id: uid('tab'), type: 'editor', title: 'Files', meta: { treeOpen: true } }]
    leaf.active = leaf.tabs[0]!.id
  }
  // The bottom panel starts closed with an empty pane (its welcome cards
  // offer the openable types on first use).
  const bottomLeaf: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [], active: null }
  return {
    panelOpen,
    width,
    activePane: leaf.id,
    nextTerminal: 1,
    nextBrowser: 1,
    expanded: [],
    splits: leaf,
    bottomOpen: false,
    bottomHeight: BOTTOM_DEFAULT,
    bottomOpenedOnce: false,
    bottomMaximized: false,
    rightMaximized: false,
    bottomSplits: bottomLeaf,
    sideBarView: SIDEBAR_BAR_VIEW_DEFAULT,
    sideBarWidth: SIDEBAR_BAR_WIDTH_DEFAULT,
    sideBarOpen: true,
  }
}

/** Whether a tree node (or any descendant) carries the given pane/split id. */
function treeHasId(node: SplitNode, id: string): boolean {
  if (node.id === id) return true
  if (node.kind === 'split') return node.children.some(child => treeHasId(child, id))
  return false
}

/** Which tree owns a pane/split id: 'bottomSplits' when the id lives in the
 *  bottom panel's tree, else 'splits' (the right panel's tree). Ids are
 *  globally unique (the shared uid counter), so an id in neither tree falls
 *  back to the right tree, where tree operations no-op on a missing node —
 *  the pre-bottom-panel behavior. */
export function treeOf(state: SidebarState, id: string): 'splits' | 'bottomSplits' {
  return treeHasId(state.bottomSplits, id) ? 'bottomSplits' : 'splits'
}

/** The panel area a tab id lives in ('right' | 'bottom'); defaults to the
 *  right workbench when the id is in neither tree (the pre-bottom fallback).
 *  Tree-originated file opens use it to pin their landing: "click in the
 *  right → open in the right". */
export function areaOfTab(state: SidebarState, tabId: string): WorkspaceArea {
  return treeOf(state, tabId) === 'bottomSplits' ? 'bottom' : 'right'
}

/** The pane of an area that receives newly opened tabs: the global
 *  `activePane` when it lives in that area's tree (the last pane the user
 *  touched there), otherwise the area's first leaf. A tree-originated open
 *  pins its landing by dispatching `activePane` to this pane before the
 *  open — the same focus the docked tree's own pointerdown applies — so a
 *  prior interaction on the other panel can never swallow the open. */
export function paneInArea(state: SidebarState, area: WorkspaceArea): string {
  const key = area === 'bottom' ? 'bottomSplits' : 'splits'
  const active = state.activePane
  if (active !== null && allLeaves(state[key]).some(leaf => leaf.id === active)) return active
  return firstLeaf(state[key]).id
}

/** Walk the tree and apply `visit` to the leaf with the given id. */
export function mapLeaf(node: SplitNode, paneId: string, visit: (leaf: SidebarLeaf) => void): SplitNode {
  if (node.kind === 'leaf') {
    if (node.id === paneId) {
      const copy: SidebarLeaf = { ...node, tabs: [...node.tabs] }
      visit(copy)
      return copy
    }
    return node
  }
  const split = node
  return {
    ...split,
    sizes: [...split.sizes],
    children: split.children.map(child => mapLeaf(child, paneId, visit)),
  }
}

/** The first leaf of the tree (fallback pane when activePane is gone). */
export function firstLeaf(node: SplitNode): SidebarLeaf {
  if (node.kind === 'leaf') return node
  return firstLeaf(node.children[0]!)
}

/** Empty every leaf of a tree (the bottom tree after its tabs migrate out). */
function clearAllTabs(node: SplitNode): SplitNode {
  if (node.kind === 'leaf') return { ...node, tabs: [], active: null }
  return { ...node, children: node.children.map(clearAllTabs) }
}

/**
 * Narrow-viewport migration: the bottom panel's tabs are thrown INTO the
 * right sidebar — the "merged display" on mobile is the right panel alone,
 * whose tab strips now carry the bottom tree's tabs (depth-first order,
 * appended to the right tree's FIRST leaf). The bottom tree is emptied (its
 * structure stays — the desktop bottom panel re-renders its welcome cards)
 * and the panel closes. The active pane moves to the right tree's first
 * leaf so every new tab lands in the visible panel.
 *
 * Idempotent: a bottom tree with no tabs and a closed panel returns the
 * same reference. Runs when the viewport enters narrow (see the Sidebar
 * shell); migrating is permanent for the session — the tabs now live in the
 * right tree, exactly like the user "threw them in".
 */
export function migrateBottomTabs(state: SidebarState): SidebarState {
  const bottomTabs = allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)
  const activeInBottom = state.activePane !== null && treeHasId(state.bottomSplits, state.activePane)
  if (bottomTabs.length === 0 && !state.bottomOpen && !activeInBottom) return state
  const target = firstLeaf(state.splits)
  return {
    ...state,
    activePane: target.id,
    // The bottom panel ceases to exist on narrow: closing it also forgets
    // the maximized flag, so re-widening never pops a stale fullscreen.
    bottomOpen: false,
    bottomMaximized: false,
    splits: bottomTabs.length > 0
      ? mapLeaf(state.splits, target.id, leaf => {
        leaf.tabs = [...leaf.tabs, ...bottomTabs]
      })
      : state.splits,
    bottomSplits: bottomTabs.length > 0 ? clearAllTabs(state.bottomSplits) : state.bottomSplits,
  }
}

/** Find the leaf containing a tab id, if any. */
export function leafWithTab(node: SplitNode, tabId: string): SidebarLeaf | undefined {
  if (node.kind === 'leaf') {
    return node.tabs.some(tab => tab.id === tabId) ? node : undefined
  }
  for (const child of node.children) {
    const found = leafWithTab(child, tabId)
    if (found !== undefined) return found
  }
  return undefined
}

/** All leaves of the tree, depth-first. */
export function allLeaves(node: SplitNode): SidebarLeaf[] {
  if (node.kind === 'leaf') return [node]
  return node.children.flatMap(allLeaves)
}

/** Whether a tab exists anywhere in a state (either tree, any pane). */
export function tabOpenIn(state: SidebarState, tabId: string): boolean {
  return allLeaves(state.splits).some(leaf => leaf.tabs.some(tab => tab.id === tabId))
    || allLeaves(state.bottomSplits).some(leaf => leaf.tabs.some(tab => tab.id === tabId))
}

/** The leaf owning `paneId` (the active pane), wherever it lives. */
export function leafById(state: SidebarState, paneId: string): SidebarLeaf | undefined {
  return allLeaves(state[treeOf(state, paneId)]).find(leaf => leaf.id === paneId)
}

/** The active pane's leaf (the pane receiving newly opened tabs). */
export function activeLeafOf(state: SidebarState): SidebarLeaf | undefined {
  const paneId = state.activePane ?? firstLeaf(state.splits).id
  return leafById(state, paneId)
}

/** The active tab of the active pane (its `active` pointer, else the last
 *  tab — the fallback the workbench render uses). */
export function activeTabOf(state: SidebarState): SidebarTab | undefined {
  const leaf = activeLeafOf(state)
  if (leaf === undefined) return undefined
  return leaf.tabs.find(tab => tab.id === leaf.active) ?? leaf.tabs[leaf.tabs.length - 1]
}

/** All tabs of the active pane, in strip order (keyboard tab cycling). */
export function activePaneTabsOf(state: SidebarState): SidebarTab[] {
  return activeLeafOf(state)?.tabs ?? []
}

/** Replace a leaf with a split of it plus a fresh empty leaf. */
export function splitLeafAt(node: SplitNode, paneId: string, dir: 'row' | 'col'): SplitNode {
  const fresh: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [], active: null }
  return mapLeaf(node, paneId, (leaf) => {
    const target: SidebarLeaf = { ...leaf }
    const split: SidebarSplit = {
      kind: 'split',
      id: uid('split'),
      dir,
      sizes: [0.5, 0.5],
      children: [target, fresh],
    }
    Object.assign(leaf, split)
  })
}

/**
 * Split a leaf by inserting a fresh leaf holding `tab` beside it — the
 * VSCode drag-to-edge gesture. `dir` is the split direction ('row' for
 * left/right, 'col' for up/down); `front` places the new leaf first (left/
 * up) or second (right/down).
 * @returns the new tree plus the fresh leaf's id (the drop's active pane).
 */
export function insertLeafAt(
  node: SplitNode,
  paneId: string,
  dir: 'row' | 'col',
  tab: SidebarTab,
  front: boolean,
): { node: SplitNode; leafId: string } {
  const fresh: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [tab], active: tab.id }
  const leafId = fresh.id
  const next = mapLeaf(node, paneId, (leaf) => {
    const target: SidebarLeaf = { ...leaf }
    const split: SidebarSplit = {
      kind: 'split',
      id: uid('split'),
      dir,
      sizes: [0.5, 0.5],
      children: front ? [fresh, target] : [target, fresh],
    }
    Object.assign(leaf, split)
  })
  return { node: next, leafId }
}

/** Where a tab drop lands on a pane: an edge creates a split, center merges. */
export type DropZone = 'left' | 'right' | 'up' | 'down' | 'center'

/**
 * The VSCode drag gesture: move a tab out of its pane and either merge it
 * into the target pane (center) or split the target pane with the tab in a
 * fresh leaf (edge). The source pane collapses when it empties.
 *
 * The panes may live in DIFFERENT trees (dragging a tab between the two
 * panels): the tab then leaves its own tree and lands in the other one.
 */
export function moveTabToEdge(
  state: SidebarState,
  fromPane: string,
  tabId: string,
  toPane: string,
  zone: DropZone,
): SidebarState {
  if (fromPane === toPane && zone === 'center') {
    // Dropped back onto its own pane's center: reorder to the end.
    return moveTab(state, fromPane, tabId, toPane, -1)
  }
  const key = treeOf(state, fromPane)
  const toKey = treeOf(state, toPane)
  if (key !== toKey) {
    // Cross-panel drop: remove the tab from its own tree, then merge (center)
    // or split (edge) a pane of the OTHER tree with the tab.
    const source = leafWithTab(state[key], tabId)
    if (source === undefined) return state
    const tab = source.tabs.find(candidate => candidate.id === tabId)!
    let emptied = false
    let sourceNode = mapLeaf(state[key], source.id, (leaf) => {
      leaf.tabs = leaf.tabs.filter(candidate => candidate.id !== tabId)
      if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
      if (leaf.tabs.length === 0) emptied = true
    })
    if (emptied) sourceNode = removeLeafAt(sourceNode, source.id)
    let targetNode = state[toKey]
    let activePane: string
    if (zone === 'center') {
      targetNode = mapLeaf(targetNode, toPane, (leaf) => {
        leaf.tabs = [...leaf.tabs, tab]
        leaf.active = tab.id
      })
      activePane = toPane
    } else {
      const dir = zone === 'left' || zone === 'right' ? 'row' : 'col'
      const result = insertLeafAt(targetNode, toPane, dir, tab, zone === 'left' || zone === 'up')
      targetNode = result.node
      activePane = result.leafId
    }
    return { ...state, [key]: sourceNode, [toKey]: targetNode, activePane }
  }
  const node = state[key]
  const source = leafWithTab(node, tabId)
  if (source === undefined) return state
  const tab = source.tabs.find(candidate => candidate.id === tabId)!
  let emptied = false
  let splits = mapLeaf(node, source.id, (leaf) => {
    leaf.tabs = leaf.tabs.filter(candidate => candidate.id !== tabId)
    if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
    if (leaf.tabs.length === 0) emptied = true
  })
  if (emptied) splits = removeLeafAt(splits, source.id)
  if (zone === 'center') {
    splits = mapLeaf(splits, toPane, (leaf) => {
      leaf.tabs = [...leaf.tabs, tab]
      leaf.active = tab.id
    })
    return { ...state, [key]: splits, activePane: toPane }
  }
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col'
  const result = insertLeafAt(splits, toPane, dir, tab, zone === 'left' || zone === 'up')
  return { ...state, [key]: result.node, activePane: result.leafId }
}

/**
 * Remove a leaf from the tree. A split left with one child promotes that
 * child; removing the last leaf yields an empty leaf.
 */
export function removeLeafAt(node: SplitNode, paneId: string): SplitNode {
  if (node.kind === 'leaf') return node.id === paneId ? { ...node, tabs: [], active: null } : node
  const children = node.children.filter(child => !(child.kind === 'leaf' && child.id === paneId))
  if (children.length === node.children.length) {
    return {
      ...node,
      sizes: [...node.sizes],
      children: node.children.map(child => removeLeafAt(child, paneId)),
    }
  }
  if (children.length === 1) return children[0]!
  return { ...node, sizes: [...node.sizes], children }
}

/** Close a tab; an emptied leaf is removed (unless it is the only pane). */
export function closeTab(state: SidebarState, paneId: string, tabId: string): SidebarState {
  const key = treeOf(state, paneId)
  let emptied = false
  const splits = mapLeaf(state[key], paneId, (leaf) => {
    leaf.tabs = leaf.tabs.filter(tab => tab.id !== tabId)
    if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
    if (leaf.tabs.length === 0) emptied = true
  })
  return { ...state, [key]: emptied ? removeLeafAt(splits, paneId) : splits }
}

/** Activate a tab in its pane (the pane's own tree). */
export function activateTab(state: SidebarState, paneId: string, tabId: string): SidebarState {
  const key = treeOf(state, paneId)
  return {
    ...state,
    activePane: paneId,
    [key]: mapLeaf(state[key], paneId, (leaf) => {
      if (leaf.tabs.some(tab => tab.id === tabId)) leaf.active = tabId
    }),
  }
}

/** Update the display fields of one open tab (title / path / meta) without
 *  re-opening it. The browser tab persists its current URL and hostname
 *  title through this reducer so a reload restores the visited page. A
 *  missing tab id is a no-op. The tab may live in either tree. */
export function patchTab(
  state: SidebarState,
  tabId: string,
  patch: { title?: string; path?: string; meta?: unknown },
): SidebarState {
  let changed = false
  const walk = (node: SplitNode): SplitNode => {
    if (node.kind === 'leaf') {
      const tabs = node.tabs.map(tab => {
        if (tab.id !== tabId) return tab
        changed = true
        return {
          ...tab,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.path !== undefined ? { path: patch.path } : {}),
          ...(patch.meta !== undefined ? { meta: patch.meta } : {}),
        }
      })
      return tabs === node.tabs ? node : { ...node, tabs }
    }
    const children = node.children.map(walk)
    return children === node.children ? node : { ...node, children }
  }
  const splits = walk(state.splits)
  const bottomSplits = walk(state.bottomSplits)
  return changed ? { ...state, splits, bottomSplits } : state
}

/**
 * Land a tab in the active pane (or focus its existing instance by id).
 * Dedup strategies (single-instance, per-path, per-change) are owned by the
 * tab descriptor through {@link BetterSidebarService.openTab} / `dedupeKey`;
 * this reducer only handles the id-based safety net (reconcile and
 * openDiffTab already check existence before calling) and the landing
 * itself — the service's dedupe path delegates here after its dedupeKey
 * check misses.
 *
 * The active pane may live in EITHER tree (pane ids are globally unique):
 * a stale id that survives in neither tree falls back to the right tree's
 * first pane instead of swallowing the open.
 */
export function openTabInActivePane(state: SidebarState, tab: SidebarTab): SidebarState {
  let targetId = state.activePane ?? firstLeaf(state.splits).id
  // A stale activePane (its pane was closed since) must not swallow the
  // open: fall back to the first pane of the right tree instead of dropping
  // the tab.
  if (!allLeaves(state[treeOf(state, targetId)]).some(leaf => leaf.id === targetId)) {
    targetId = firstLeaf(state.splits).id
  }
  const targetKey = treeOf(state, targetId)
  // Id-based safety net: if a tab with the same id exists, focus it.
  for (const leaf of allLeaves(state.splits).concat(allLeaves(state.bottomSplits))) {
    const existing = leaf.tabs.find(candidate => candidate.id === tab.id)
    if (existing !== undefined) return activateTab(state, leaf.id, existing.id)
  }
  return {
    ...state,
    activePane: targetId,
    [targetKey]: mapLeaf(state[targetKey], targetId, (leaf) => {
      leaf.tabs = [...leaf.tabs, tab]
      leaf.active = tab.id
    }),
  }
}

/** Move a tab from one pane to another (insert at index; -1 appends).
 *  The panes may live in DIFFERENT trees — dragging a tab between the two
 *  panels removes it from its own tree and lands it in the other one. */
export function moveTab(state: SidebarState, fromPane: string, tabId: string, toPane: string, index = -1): SidebarState {
  const fromKey = treeOf(state, fromPane)
  const toKey = treeOf(state, toPane)
  if (fromKey !== toKey) {
    let moved: SidebarTab | undefined
    let emptied = false
    const source = mapLeaf(state[fromKey], fromPane, (leaf) => {
      const found = leaf.tabs.find(tab => tab.id === tabId)
      if (found === undefined) return
      moved = found
      leaf.tabs = leaf.tabs.filter(tab => tab.id !== tabId)
      if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
      if (leaf.tabs.length === 0) emptied = true
    })
    if (moved === undefined) return state
    const target = mapLeaf(state[toKey], toPane, (leaf) => {
      const insertAt = index >= 0 && index <= leaf.tabs.length ? index : leaf.tabs.length
      leaf.tabs = [...leaf.tabs.slice(0, insertAt), moved!, ...leaf.tabs.slice(insertAt)]
      leaf.active = moved!.id
    })
    return {
      ...state,
      [fromKey]: emptied ? removeLeafAt(source, fromPane) : source,
      [toKey]: target,
      activePane: toPane,
    }
  }
  let moved: SidebarTab | undefined
  let emptied = false
  let splits = mapLeaf(state[fromKey], fromPane, (leaf) => {
    const found = leaf.tabs.find(tab => tab.id === tabId)
    if (found === undefined) return
    moved = found
    leaf.tabs = leaf.tabs.filter(tab => tab.id !== tabId)
    if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
    if (leaf.tabs.length === 0) emptied = true
  })
  if (moved === undefined) return state
  if (emptied) splits = removeLeafAt(splits, fromPane)
  splits = mapLeaf(splits, toPane, (leaf) => {
    const insertAt = index >= 0 && index <= leaf.tabs.length ? index : leaf.tabs.length
    leaf.tabs = [...leaf.tabs.slice(0, insertAt), moved!, ...leaf.tabs.slice(insertAt)]
    leaf.active = moved!.id
  })
  return { ...state, [fromKey]: splits, activePane: toPane }
}

/** Split the active pane (or the pane containing the active tab). */
export function splitPane(state: SidebarState, dir: 'row' | 'col'): SidebarState {
  const paneId = state.activePane ?? firstLeaf(state.splits).id
  const key = treeOf(state, paneId)
  return { ...state, [key]: splitLeafAt(state[key], paneId, dir) }
}

/**
 * Open a diff tab the VSCode way: an existing instance of the same change is
 * focused wherever it lives; otherwise the tab joins the first pane that
 * already holds diff tabs (diff panes are sticky — repeated clicks stack
 * there); on the FIRST diff of a layout the source pane splits vertically so
 * the diff lands in a fresh pane below it ("默认在下半栏新增一个").
 *
 * This is split-tree placement surgery, not registry dispatch: the diff tab
 * descriptor's `dedupeKey` is `(tab) => tab.id`, and the existing-instance
 * check below is exactly that rule — the two agree by construction (asserted
 * in tests). Diff tabs minted by the Git view carry change-derived ids, so
 * the id check is the per-change dedupe.
 * @returns the new state, with the diff pane active.
 */
export function openDiffTab(state: SidebarState, sourcePaneId: string, tab: SidebarTab): SidebarState {
  const existingLeaf = leafWithTab(state.splits, tab.id)
  if (existingLeaf !== undefined) return activateTab(state, existingLeaf.id, tab.id)
  const diffLeaf = allLeaves(state.splits).find(leaf => leaf.tabs.some(candidate => candidate.type === 'diff'))
  if (diffLeaf !== undefined) {
    return {
      ...state,
      activePane: diffLeaf.id,
      splits: mapLeaf(state.splits, diffLeaf.id, (leaf) => {
        leaf.tabs = [...leaf.tabs, tab]
        leaf.active = tab.id
      }),
    }
  }
  // First diff: split the source pane, the diff tab in the new LOWER leaf.
  // (A stale sourcePaneId — its pane closed meanwhile — degrades to the
  // regular open path instead of dropping the tab into an orphaned leaf.)
  if (!allLeaves(state.splits).some(leaf => leaf.id === sourcePaneId)) {
    return openTabInActivePane(state, tab)
  }
  const result = insertLeafAt(state.splits, sourcePaneId, 'col', tab, false)
  return { ...state, splits: result.node, activePane: result.leafId }
}

/** Toggle the panel open/closed (opening restores the previous layout).
 *  Closing also forgets the IDE-fullscreen flag — a closed panel must never
 *  re-open fullscreen on its own. */
export function togglePanel(state: SidebarState): SidebarState {
  const panelOpen = !state.panelOpen
  return { ...state, panelOpen, rightMaximized: panelOpen ? state.rightMaximized : false }
}

/** Toggle the IDE FULLSCREEN mode (⌘⌥⇧B): the right panel covers the whole
 *  viewport as a standalone VSCode window — the resource manager pins to the
 *  panel's LEFT edge and the bottom workbench docks BELOW the editor tabs.
 *  Entering opens the panel and defaults the explorer drawer EXPANDED (a
 *  collapsed drawer would leave the left column empty); exiting restores the
 *  docked width (the panel stays open). The flag is orthogonal to
 *  `bottomMaximized` — the IDE panel covers the bottom panel behind it. */
export function toggleRightMaximized(state: SidebarState): SidebarState {
  const maximized = !state.rightMaximized
  return {
    ...state,
    panelOpen: maximized ? true : state.panelOpen,
    // Inert in the docked layout (sideBarOpen only drives the vscode Side
    // Bar), so the default-expand never disturbs a docked user's layout.
    sideBarOpen: maximized ? true : state.sideBarOpen,
    rightMaximized: maximized,
  }
}

/** Toggle the bottom panel open/closed (independent of the right panel).
 *  Closing forgets the maximized state: the next open restores the normal
 *  drag height, never a stale fullscreen. */
export function toggleBottomPanel(state: SidebarState): SidebarState {
  const bottomOpen = !state.bottomOpen
  return { ...state, bottomOpen, bottomMaximized: bottomOpen && state.bottomMaximized }
}

/** Toggle the bottom panel's MAXIMIZED state (⌘⇧J): it covers the whole
 *  center column (full viewport height) with the layout push released. A
 *  closed panel opens maximized; an open maximized panel restores its drag
 *  height (the panel stays open — `bottomHeight` is never overwritten). */
export function toggleBottomMaximized(state: SidebarState): SidebarState {
  const maximized = !state.bottomMaximized
  return { ...state, bottomOpen: maximized ? true : state.bottomOpen, bottomMaximized: maximized }
}

/** Set the panel width (clamped to the contract range; the upper bound is
 * the viewport so the fullscreen expansion can fill the window). */
export function setWidth(state: SidebarState, width: number): SidebarState {
  const max = typeof window !== 'undefined' ? Math.max(PANEL_MIN, window.innerWidth) : PANEL_MAX
  return { ...state, width: Math.min(max, Math.max(PANEL_MIN, Math.round(width))) }
}

/** Set the bottom panel height (clamped to the contract range). The upper
 * bound leaves the center column (the agent output area) at least PANEL_MIN
 * tall — without the cap the bottom panel could swallow the whole viewport
 * and squeeze the conversation to zero height. */
export function setBottomHeight(state: SidebarState, height: number): SidebarState {
  const viewport = typeof window !== 'undefined' ? window.innerHeight : Infinity
  const max = Math.max(BOTTOM_MIN, viewport - PANEL_MIN)
  return { ...state, bottomHeight: Math.min(max, Math.max(BOTTOM_MIN, Math.round(height))) }
}

/** Set the vscode Side Bar's active view id (the independent file-tree
 *  column). Inert in docked mode — the caller only dispatches this while
 *  `sidebarLayout === 'vscode'`. */
export function setSideBarView(state: SidebarState, view: string): SidebarState {
  if (view === state.sideBarView) return state
  return { ...state, sideBarView: view }
}

/** Set the vscode Side Bar's width (clamped to the contract range). */
export function setSideBarWidth(state: SidebarState, width: number): SidebarState {
  return { ...state, sideBarWidth: clampSidebarBarWidth(width) }
}

/** Set whether the vscode EXPLORER drawer is expanded (a no-op for the same
 *  value — the Activity Bar icon toggles it). */
export function setSideBarOpen(state: SidebarState, open: boolean): SidebarState {
  return state.sideBarOpen === open ? state : { ...state, sideBarOpen: open }
}

/** Toggle a directory in the explorer expansion set. */
export function toggleExpanded(state: SidebarState, path: string): SidebarState {
  const expanded = state.expanded.includes(path)
    ? state.expanded.filter(item => item !== path)
    : [...state.expanded, path]
  return { ...state, expanded }
}

/** Adjust one split divider: `i` is the left/top child index, delta in fractions. */
export function resizeSplit(node: SplitNode, splitId: string, index: number, delta: number): SplitNode {
  if (node.kind === 'leaf') return node
  if (node.id === splitId) {
    const sizes = [...node.sizes]
    const left = Math.min(0.92, Math.max(0.08, sizes[index]! + delta))
    const right = Math.min(0.92, Math.max(0.08, sizes[index + 1]! - delta))
    sizes[index] = left
    sizes[index + 1] = right
    return { ...node, sizes }
  }
  return {
    ...node,
    sizes: [...node.sizes],
    children: node.children.map(child => resizeSplit(child, splitId, index, delta)),
  }
}

/** State-level {@link resizeSplit} route: the divider may live in either
 *  tree (split ids are globally unique). */
export function resizeSplitIn(state: SidebarState, splitId: string, index: number, delta: number): SidebarState {
  const key = treeOf(state, splitId)
  return { ...state, [key]: resizeSplit(state[key], splitId, index, delta) }
}

/** Prefix marking a tab id as an agent-owned terminal (suffix is the uuid). */
export const AGENT_TAB_PREFIX = 'agent:'

/** Whether a tab id refers to an agent-owned terminal. */
export function isAgentTabId(tabId: string): boolean {
  return tabId.startsWith(AGENT_TAB_PREFIX)
}

/** Extract the agent terminal uuid from an `agent:<uuid>` tab id. */
export function agentUuidOf(tabId: string): string {
  return tabId.slice(AGENT_TAB_PREFIX.length)
}

/** Build the sidebar tab id for one agent terminal uuid. */
export function agentTabId(uuid: string): string {
  return `${AGENT_TAB_PREFIX}${uuid}`
}

/**
 * Reconcile the sidebar's agent-terminal tabs with the host's live list.
 * The host pushes the current list of agent terminals (created by the model
 * through the `terminal_create` tool) over a dedicated WebSocket; this
 * reducer mirrors that list into tabs: new uuids get a tab, vanished uuids
 * lose theirs. The agent owns the lifetime — the user closing a tab sends a
 * WS close frame that kills the pty, which fires a change, which converges
 * the view. Idempotent: a no-op when the lists already match.
 * @param state - the current per-session sidebar state.
 * @param agentTerminals - the live agent terminal snapshots from the host.
 * @returns the next state (or the same reference if no change was needed).
 */
export function reconcileAgentTerminals(
  state: SidebarState,
  agentTerminals: ReadonlyArray<{ uuid: string; title: string }>,
): SidebarState {
  const existingTabs = allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap(leaf => leaf.tabs)
  const existingAgentTabs = existingTabs.filter(tab => isAgentTabId(tab.id))
  const existingUuids = new Set(existingAgentTabs.map(tab => agentUuidOf(tab.id)))
  const serverUuids = new Set(agentTerminals.map(t => t.uuid))
  const toAdd = agentTerminals.filter(t => !existingUuids.has(t.uuid))
  const toRemove = existingAgentTabs.filter(tab => !serverUuids.has(agentUuidOf(tab.id)))
  if (toAdd.length === 0 && toRemove.length === 0) return state
  // Remove tabs whose uuids vanished from the server list (the agent closed
  // them, or the pty exited and was reaped). Reuse closeTab's leaf cleanup.
  let splits = state.splits
  for (const tab of toRemove) {
    const leaf = leafWithTab(splits, tab.id)
    if (leaf !== undefined) {
      splits = closeTab({ ...state, splits }, leaf.id, tab.id).splits
    }
  }
  // Add tabs for new uuids (the agent created a terminal). They land in the
  // active pane via openTabInActivePane; the next reconcile is a no-op for them.
  let next: SidebarState = { ...state, splits }
  for (const terminal of toAdd) {
    const tab: SidebarTab = {
      id: agentTabId(terminal.uuid),
      type: 'terminal',
      title: terminal.title,
    }
    next = openTabInActivePane(next, tab)
  }
  return next
}

// ── Workspace-bound windows ────────────────────────────────────────────────

/**
 * Reconcile a session state against its bound windows: stale stubs (unbound
 * meanwhile, or a foreign id under the reserved prefix) are dropped from
 * BOTH trees — a dangling `active` pointing at one is nulled (a dangling
 * active corrupts the next sanitize pass) — and a WORKSPACE window whose
 * stub is missing EVERYWHERE re-merges into the FIRST leaf of the panel it
 * was bound from (`area: 'right'` → `splits`, `area: 'bottom'` →
 * `bottomSplits`). GLOBAL windows (`gb:`) NEVER auto-merge here: they park
 * in the Global Workspace and a session attaches one on demand
 * (`attachGlobal`); `globalWindows` only validates the `gb:` stubs a
 * session already holds (an attached stub whose window was unbound is
 * stale and stripped). Pinned stubs are DRAGGABLE like any tab: a stub the
 * user moved to another leaf or panel is left exactly where it is (the
 * per-session placement wins; only reloads fall back to the area's first
 * leaf, because stub positions never persist). Idempotent: an
 * already-synced state returns the same reference.
 */
export function reconcileWorkspaceWindows(state: SidebarState, windows: readonly WorkspaceWindow[], globalWindows: readonly WorkspaceWindow[]): SidebarState {
  const validIds = new Set([...windows, ...globalWindows].map(w => w.id))
  const stripStale = (node: SplitNode): SplitNode => {
    if (node.kind === 'leaf') {
      // filter() always allocates: track real change with a flag, or the
      // identity check below fails on every leaf and reconcile never
      // converges (store ↔ windows notify cycle → stack overflow).
      let changed = false
      const tabs = node.tabs.filter(tab => {
        if (isBoundTabId(tab.id) && !validIds.has(tab.id)) {
          changed = true
          return false
        }
        return true
      })
      const active = node.active !== null && isBoundTabId(node.active) && !validIds.has(node.active) ? null : node.active
      if (!changed && active === node.active) return node
      return { ...node, tabs, active }
    }
    const children = node.children.map(stripStale)
    return children === node.children ? node : { ...node, children }
  }
  const splits = stripStale(state.splits)
  const bottomSplits = stripStale(state.bottomSplits)
  // A stub present anywhere — including a leaf or panel it was dragged
  // to — counts as merged; only truly missing windows re-merge.
  const present = new Set(
    [...allLeaves(splits), ...allLeaves(bottomSplits)]
      .flatMap(leaf => leaf.tabs)
      .filter(tab => isBoundTabId(tab.id))
      .map(tab => tab.id),
  )
  const rightMissing = windows.filter(w => w.area === 'right' && !present.has(w.id))
  const bottomMissing = windows.filter(w => w.area === 'bottom' && !present.has(w.id))
  if (
    splits === state.splits
    && bottomSplits === state.bottomSplits
    && rightMissing.length === 0
    && bottomMissing.length === 0
  ) {
    return state
  }
  return {
    ...state,
    splits: appendStubs(splits, rightMissing),
    bottomSplits: appendStubs(bottomSplits, bottomMissing),
  }
}

/** Append one stub per missing window to the tree's FIRST leaf (store order). */
function appendStubs(tree: SplitNode, windows: readonly WorkspaceWindow[]): SplitNode {
  if (windows.length === 0) return tree
  const target = firstLeaf(tree)
  return mapLeaf(tree, target.id, (leaf) => {
    leaf.tabs = [...leaf.tabs, ...windows.map(window => ({ id: window.id, type: window.type, title: window.title }))]
  })
}

/**
 * Strip every WORKSPACE stub from a state (the persistence filter): `ws:`
 * windows never persist inside session layouts — the workspace windows
 * store is the single source of truth and reload re-merges them. A
 * session-ATTACHED GLOBAL stub (`gb:`) is a deliberate per-session view of
 * a window parked in the Global Workspace and PERSISTS; reload validates
 * it against the global blob (reconcileWorkspaceWindows strips one whose
 * window was unbound meanwhile). An `active` pointer into a stripped stub
 * is nulled for the same reason.
 */
export function stripWorkspaceWindows(state: SidebarState): SidebarState {
  let changed = false
  const walk = (node: SplitNode): SplitNode => {
    if (node.kind === 'leaf') {
      const tabs = node.tabs.filter(tab => {
        if (!tab.id.startsWith(WS_TAB_PREFIX)) return true
        changed = true
        return false
      })
      const active = node.active !== null && !tabs.some(candidate => candidate.id === node.active) ? null : node.active
      if (active !== node.active) changed = true
      return tabs === node.tabs && active === node.active ? node : { ...node, tabs, active }
    }
    const children = node.children.map(walk)
    return children === node.children ? node : { ...node, children }
  }
  const splits = walk(state.splits)
  const bottomSplits = walk(state.bottomSplits)
  return changed ? { ...state, splits, bottomSplits } : state
}

// ── The per-session store ──────────────────────────────────────────────────

const STORAGE_PREFIX = 'dsh-sidebar:v1'

/** Immutable snapshot handed to React (replaced only on real changes). */
export interface SidebarSnapshot {
  sessionId: string | undefined
  state: SidebarState | undefined
  /**
   * The current side card prefs. Carried IN the snapshot (not a separate
   * subscription) so prefs changes re-render the consumers that gate on
   * them — the + menu hides a tab type the moment its switch flips.
   */
  prefs: SidebarPrefs
}

/** Default panel width for one viewport: the prefs percent of the window,
 * clamped to the panel floor (a tiny percent must stay usable) and to the
 * viewport (a large one must never cover the whole window). */
export function defaultWidthFor(viewport: number, percent: number): number {
  return Math.min(viewport, Math.max(PANEL_MIN, Math.round(viewport * percent / 100)))
}

function loadState(sessionId: string, prefs: SidebarPrefs, source?: WorkspaceWindowsSource): SidebarState {
  let state: SidebarState | undefined
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}:${sessionId}`)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown
      // Seed the uid counter past the persisted ids (it resets on reload);
      // sanitize re-ids any duplicates the pre-seeding counter left behind.
      nextIdCounter = maxCounterId(parsed)
      state = sanitizeState(parsed)
    }
  } catch {
    // Corrupt or unavailable storage: fall through to the default.
  }
  if (state === undefined) {
    state = defaultState(prefs)
  }
  // Workspace-bound windows merge into the first leaf at load: the store is
  // the single source of truth (session layouts never persist ws: stubs), so
  // every load re-materializes them. GLOBAL windows never merge — a
  // persisted `gb:` stub (a session-attached view) is only validated against
  // the global blob. A failing resolution degrades to the unmerged state
  // rather than blocking the session.
  try {
    if (source !== undefined) {
      const windows = source.windowsOfSession(sessionId)
      const globals = source.globalWindows()
      if (windows.length > 0 || globals.length > 0) state = reconcileWorkspaceWindows(state, windows, globals)
    }
  } catch (error) {
    console.error('[dsh-better-sidebar] workspace windows merge failed:', error)
  }
  return state
}

/** The fresh default state (extracted from loadState's fallback path). */
function defaultState(prefs: SidebarPrefs): SidebarState {
  // New sessions seed from the user's side card prefs: the width is the
  // chosen percent of the window (clamped to the panel floor and the
  // viewport so a huge percent can never crush the app shell), the panel
  // starts open only when the preference says so, and the seed tab is the
  // empty files window (tree panel open) in BOTH editorExplorer modes — a
  // disabled editor type seeds nothing. On a NARROW viewport a brand-new
  // session starts collapsed instead — the panel is a full-screen drawer
  // there, and auto-opening it on first paint would cover the conversation
  // before the user asked. Only the first seeding is affected: once the
  // user expands the drawer, `panelOpen: true` persists like any other
  // state.
  const viewport = typeof window !== 'undefined' ? window.innerWidth : undefined
  const width = viewport === undefined
    ? PANEL_DEFAULT
    : defaultWidthFor(viewport, prefs.defaultWidthPercent)
  const openByDefault = prefs.openByDefault && (viewport === undefined || !isNarrowWidth(viewport))
  const seed: DefaultSeed = prefs.tabsEnabled['editor'] === false ? 'none' : 'editor-home'
  return makeDefaultState(width, openByDefault, seed)
}

/**
 * Structural validation of one persisted state. A malformed or stale shape
 * (older layouts, hand-edited storage) must fall back to the default instead
 * of crashing the panel on every reload; the restored width is also clamped
 * to the current viewport so a stale fullscreen width can never crush the
 * app shell (margin-right larger than the window) or cover the whole screen.
 * @returns a clean state, or undefined to fall back to the default.
 */
export function sanitizeState(parsed: unknown): SidebarState | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.panelOpen !== 'boolean') return undefined
  if (typeof record.width !== 'number' || !Number.isFinite(record.width)) return undefined
  if (typeof record.nextTerminal !== 'number' || !Number.isInteger(record.nextTerminal) || record.nextTerminal < 1) {
    return undefined
  }
  // nextBrowser arrived in a later build; a missing or malformed value on an
  // OLDER persisted state defaults to 1 so existing layouts keep loading
  // (unlike nextTerminal, which is strict — it predates the v1 shape).
  const nextBrowser = typeof record.nextBrowser === 'number' && Number.isInteger(record.nextBrowser) && record.nextBrowser >= 1
    ? record.nextBrowser
    : 1
  if (typeof record.activePane !== 'string' && record.activePane !== null) return undefined
  if (!Array.isArray(record.expanded) || record.expanded.some(item => typeof item !== 'string')) return undefined
  // The seen/reid maps are SHARED across both trees: pane/split ids must be
  // globally unique (the runtime uid counter is shared too), so a duplicate
  // seen first in the right tree gets a fresh id when it reappears in the
  // bottom tree.
  const seen = new Set<string>()
  const reid = new Map<string, string>()
  const splits = sanitizeNode(record.splits, seen, reid)
  if (splits === undefined) return undefined
  // Bottom-panel fields arrived in a later build: a missing or malformed
  // value on an OLDER persisted state defaults (closed / default height /
  // empty pane) so existing layouts keep loading, like nextBrowser.
  const bottomOpen = record.bottomOpen === true
  // Cap the persisted height so the center column (the agent output area)
  // keeps at least PANEL_MIN tall (a stale full-height bottom panel from an
  // older build must never squeeze the conversation to zero).
  const maxHeight = typeof window !== 'undefined' ? window.innerHeight : Infinity
  const bottomCap = Math.max(BOTTOM_MIN, maxHeight - PANEL_MIN)
  const rawHeight = typeof record.bottomHeight === 'number' && Number.isFinite(record.bottomHeight)
    ? record.bottomHeight
    : BOTTOM_DEFAULT
  const bottomHeight = Math.min(bottomCap, Math.max(BOTTOM_MIN, Math.round(rawHeight)))
  const bottomSplits = sanitizeNode(record.bottomSplits, seen, reid)
    ?? { kind: 'leaf' as const, id: uid('pane'), tabs: [], active: null }
  const maxWidth = typeof window !== 'undefined' ? window.innerWidth : Infinity
  return {
    panelOpen: record.panelOpen,
    width: Math.max(PANEL_MIN, Math.min(record.width, maxWidth)),
    // A stale duplicate pane id may have been re-ided; follow the rename so
    // new tabs still land in the pane the user was using.
    activePane: typeof record.activePane === 'string' ? (reid.get(record.activePane) ?? record.activePane) : null,
    nextTerminal: record.nextTerminal,
    nextBrowser,
    expanded: record.expanded as string[],
    splits,
    bottomOpen,
    bottomHeight,
    // An older persisted state never expanded the bottom panel (the field
    // arrived later): defaulting to false gives it the first-expansion
    // auto-terminal exactly once after the upgrade.
    bottomOpenedOnce: record.bottomOpenedOnce === true,
    // The maximized flag arrived later still: older states restore normal.
    bottomMaximized: record.bottomMaximized === true,
    // The IDE-fullscreen flag arrived later: older states restore normal.
    rightMaximized: record.rightMaximized === true,
    bottomSplits,
    // The vscode Side Bar fields arrived later: older states restore the
    // explorer view at the default width (the fields are inert in docked
    // mode anyway, so the default is harmless for pre-vscode layouts).
    sideBarView: typeof record.sideBarView === 'string' && record.sideBarView !== ''
      ? record.sideBarView
      : 'explorer',
    sideBarWidth: typeof record.sideBarWidth === 'number' && Number.isFinite(record.sideBarWidth)
      ? clampSidebarBarWidth(record.sideBarWidth)
      : SIDEBAR_BAR_WIDTH_DEFAULT,
    // The explorer-drawer flag arrived later: older states restore expanded
    // (true) so the file tree never disappears on upgrade.
    sideBarOpen: record.sideBarOpen !== false,
  }
}

/**
 * One tree node id, deduplicated against the ids already seen in this
 * state. Duplicates are exactly the pre-seeding counter-reset corruption
 * (a "pane:1"/"split:1" minted after a reload beside the persisted ones):
 * keeping both would make mapLeaf visit two leaves at once and every open
 * would land in both panes, so the repeat gets a fresh id.
 * @returns the id to use (the original, or a fresh uid for repeats).
 */
function uniqueNodeId(id: string, seen: Set<string>, reid: Map<string, string>): string {
  if (!seen.has(id)) {
    seen.add(id)
    return id
  }
  const prefix = /^split:\d+$/.test(id) ? 'split' : 'pane'
  const fresh = uid(prefix)
  seen.add(fresh)
  reid.set(id, fresh)
  return fresh
}

/** Validate one split-tree node (leaf or split) and rebuild it cleanly. */
function sanitizeNode(node: unknown, seen: Set<string>, reid: Map<string, string>): SplitNode | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const record = node as Record<string, unknown>
  if (record.kind === 'leaf') {
    if (typeof record.id !== 'string' || !Array.isArray(record.tabs)) return undefined
    const tabs: SidebarTab[] = []
    let droppedDiff = false
    for (const tab of record.tabs) {
      if (tab === null || typeof tab !== 'object') return undefined
      const candidate = tab as Record<string, unknown>
      if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') return undefined
      // Diff tabs are ephemeral by nature (like VSCode's diff editors):
      // they never survive a reload, so a stale ref (e.g. a wrong staged
      // side persisted by an older build) cannot resurface as a dead tab
      // showing "no text changes" after every refresh.
      if (candidate.type === 'diff') {
        droppedDiff = true
        continue
      }
      // Tab types are an open set (external plugins register their own);
      // accept any string type here — an unregistered type renders an
      // <OrphanedTab/> at view time and recovers if its plugin loads later.
      if (typeof candidate.type !== 'string') return undefined
      // The standalone explorer tab type merged INTO the editor (the single
      // files window): a persisted explorer tab reopens as an editor home
      // tab — no path, tree panel open (an existing meta object survives).
      if (candidate.type === 'explorer') {
        const meta = candidate.meta !== null && typeof candidate.meta === 'object' && !Array.isArray(candidate.meta)
          ? candidate.meta as Record<string, unknown>
          : undefined
        tabs.push({
          id: candidate.id,
          type: 'editor',
          title: 'Files',
          meta: { treeOpen: true, ...meta },
        })
        continue
      }
      // `meta` is plugin-owned JSON-serializable state (v0.12.0+): the
      // persisted value already went through JSON.parse, so it is inherently
      // serializable — carry it through verbatim (absent on older states).
      tabs.push({
        id: candidate.id,
        type: candidate.type,
        title: candidate.title,
        ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
        ...(candidate.meta !== undefined ? { meta: candidate.meta } : {}),
      })
    }
    const active = typeof record.active === 'string' ? record.active : null
    // An active pointer into a dropped diff tab is expected after the drop;
    // any other missing active is structural corruption → reset the state.
    if (active !== null && !tabs.some(tab => tab.id === active) && !droppedDiff) return undefined
    return { kind: 'leaf', id: uniqueNodeId(record.id, seen, reid), tabs, active: active !== null && tabs.some(tab => tab.id === active) ? active : null }
  }
  if (record.kind === 'split') {
    if (typeof record.id !== 'string' || (record.dir !== 'row' && record.dir !== 'col')) return undefined
    if (!Array.isArray(record.children) || !Array.isArray(record.sizes)) return undefined
    const children: SplitNode[] = []
    for (const child of record.children) {
      const clean = sanitizeNode(child, seen, reid)
      if (clean === undefined) return undefined
      children.push(clean)
    }
    if (children.length < 2) return undefined
    if (
      record.sizes.length !== children.length
      || record.sizes.some(size => typeof size !== 'number' || !Number.isFinite(size) || size <= 0)
    ) {
      return undefined
    }
    return { kind: 'split', id: uniqueNodeId(record.id, seen, reid), dir: record.dir, sizes: record.sizes as number[], children }
  }
  return undefined
}

/** The session-scoped store: one state per conversation, localStorage-backed. */
export class SidebarStore {
  private readonly bySession = new Map<string, SidebarState>()
  private snapshot: SidebarSnapshot = {
    sessionId: undefined,
    state: undefined,
    prefs: { ...SIDEBAR_PREFS_DEFAULTS },
  }
  private readonly listeners = new Set<() => void>()
  /** Per-session listeners (the Global Workspace page subscribes to the
   *  virtual `global-workspace` session's state this way). Fired on
   *  reduce/reduceFor/update of THAT session — a targeted change (reduceFor)
   *  must re-render its viewers without notifying the global UI. */
  private readonly sessionListeners = new Map<string, Set<() => void>>()
  /** Per-session persist debounce timers (v0.12.0+: one per session, so a
   *  targeted open never cancels another session's pending write). */
  private readonly persistTimers = new Map<string, number>()
  /** User-facing side card prefs seeding brand-new session states (defaults until the settings RPC resolves). */
  private prefs: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS }
  /** The workspace windows source (attached in apply): bound windows merge
   *  into every session's first leaf and strip out of persistence. */
  private workspaceWindows: WorkspaceWindowsSource | null = null

  /**
   * Attach the workspace windows source (bound-window resolution + change
   * feed). Every workspace-windows change re-reconciles ALL cached session
   * states (and the active snapshot): a bind/unbind/update must appear,
   * update, or disappear in every session of the workspace — including the
   * ones the user is not looking at right now — and a global window's
   * unbind must strip the `gb:` stubs attached in every session. Attach
   * exactly once, before any session loads.
   */
  attachWorkspaceWindows(source: WorkspaceWindowsSource): void {
    this.workspaceWindows = source
    source.subscribe(() => {
      for (const [sessionId, state] of this.bySession) {
        const next = reconcileWorkspaceWindows(state, source.windowsOfSession(sessionId), source.globalWindows())
        if (next !== state) {
          this.bySession.set(sessionId, next)
          // Persist the cleaned layout: a session-ATTACHED `gb:` stub strips
          // durably here (the virtual global-workspace session's layout must
          // not resurface a window that was unbound meanwhile on reload).
          this.schedulePersist(sessionId, next)
          this.notifySession(sessionId)
        }
      }
      const activeSessionId = this.snapshot.sessionId
      if (activeSessionId !== undefined && this.snapshot.state !== undefined) {
        const next = reconcileWorkspaceWindows(this.snapshot.state, source.windowsOfSession(activeSessionId), source.globalWindows())
        if (next !== this.snapshot.state) {
          this.snapshot = { ...this.snapshot, state: next }
          this.notify()
        }
      }
    })
  }

  /**
   * External disable (the dsh-web-ui family's aionui-panel provider choice):
   * while true the sidebar must not mount at all. Not part of the snapshot —
   * nothing renders on it; the mount gate and the intercept predicates read
   * it directly.
   */
  private suspended = false

  /**
   * Set the external-disable flag (from the settings route) and remember it
   * for the mount gate and the intercept predicates.
   */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended
  }

  /** Whether the sidebar is externally disabled (aionui-panel chosen). */
  getSuspended(): boolean {
    return this.suspended
  }

  /**
   * Replace the side card prefs (the settings RPC result / settings page
   * write). Notifies like any store change: the snapshot carries the prefs,
   * so consumers that gate on enable switches (the + menu, derived flows)
   * re-render with the new values immediately.
   */
  setPrefs(prefs: SidebarPrefs): void {
    this.prefs = { ...prefs }
    this.snapshot = { ...this.snapshot, prefs: this.prefs }
    this.notify()
  }

  /** The current side card prefs (seeds new sessions; persisted states win). */
  getPrefs(): SidebarPrefs {
    return { ...this.prefs }
  }

  /** Select a session (or none); loads its persisted state. */
  setSession(sessionId: string | undefined): void {
    if (this.snapshot.sessionId === sessionId) return
    if (sessionId === undefined) {
      this.snapshot = { sessionId: undefined, state: undefined, prefs: this.prefs }
    } else {
      let state = this.bySession.get(sessionId)
      if (state === undefined) {
        state = loadState(sessionId, this.prefs, this.workspaceWindows ?? undefined)
        this.bySession.set(sessionId, state)
      } else {
        // Cache hit: another session's load/ops may have left the uid
        // counter below THIS session's persisted ids — re-seed so fresh
        // pane/split ids can never collide with its tree.
        nextIdCounter = maxCounterId(state)
      }
      this.snapshot = { sessionId, state, prefs: this.prefs }
    }
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read ONE session's state (loading + reconciling it on demand like
   * setSession, WITHOUT switching the active snapshot). Used by the full-page
   * Global Workspace to render the virtual `global-workspace` session. The
   * returned reference is stable until that session next changes.
   */
  getStateOf(sessionId: string): SidebarState | undefined {
    let state = this.bySession.get(sessionId)
    if (state === undefined) {
      state = loadState(sessionId, this.prefs, this.workspaceWindows ?? undefined)
      this.bySession.set(sessionId, state)
    } else {
      // Cache hit: another session's load/ops may have left the uid counter
      // below THIS session's persisted ids — re-seed so fresh pane/split ids
      // can never collide with its tree (mirror of setSession).
      nextIdCounter = maxCounterId(state)
    }
    return state
  }

  /** Subscribe to changes of ONE session's state (fires on that session's
   *  reduce/reduceFor/update/reconcile, including targeted changes that do
   *  NOT notify the global UI). Returns the disposer. */
  subscribeOf(sessionId: string, listener: () => void): () => void {
    let set = this.sessionListeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.sessionListeners.set(sessionId, set)
    }
    set.add(listener)
    return () => { set.delete(listener) }
  }

  getSnapshot(): SidebarSnapshot {
    return this.snapshot
  }

  /** Mutate the current session's state (no-op without a session). */
  update(mutator: (draft: SidebarState) => void): void {
    const sessionId = this.snapshot.sessionId
    const state = this.snapshot.state
    if (sessionId === undefined || state === undefined) return
    const draft = structuredClone(state)
    mutator(draft)
    this.bySession.set(sessionId, draft)
    this.snapshot = { sessionId, state: draft, prefs: this.prefs }
    this.schedulePersist(sessionId, draft)
    this.notify()
    this.notifySession(sessionId)
  }

  /**
   * Whether a tab still exists in its session's state. Views use this on
   * unmount to tell "the tab was closed" (release the terminal now) from
   * "the tree re-rendered / the conversation switched" (the tab is still
   * open — keep the terminal alive through the host's reconnect grace).
   * Checks the session's own map entry (the current snapshot may already
   * point at another session when a conversation switch unmounts the old
   * one's tabs).
   *
   * A shared-window stub (`ws:` / `gb:`) whose window is STILL DEFINED in
   * the windows store counts as open even when the session no longer holds
   * it: the ✕ on an attached `gb:` stub DETACHES the local view only (the
   * window parks on in the Global Workspace), and the unmount must not send
   * the close frame that would kill the shared pty — only unbinding the
   * window EVERYWHERE (which removes it from the store before the reconcile
   * strips the stubs) lets the close frame through. Workspace stubs resolve
   * through windowsOfSession the same way.
   */
  tabOpen(sessionId: string, tabId: string): boolean {
    const state = this.bySession.get(sessionId)
      ?? (this.snapshot.sessionId === sessionId ? this.snapshot.state : undefined)
    if (state !== undefined && tabOpenIn(state, tabId)) return true
    if (isBoundTabId(tabId) && this.workspaceWindows !== null) {
      const source = this.workspaceWindows
      const live = source.windowsOfSession(sessionId).some(window => window.id === tabId)
        || source.globalWindows().some(window => window.id === tabId)
      if (live) return true
    }
    return false
  }

  /** Apply a pure reducer (returns the next state). */
  reduce(reducer: (state: SidebarState) => SidebarState): void {
    const sessionId = this.snapshot.sessionId
    const state = this.snapshot.state
    if (sessionId === undefined || state === undefined) return
    const next = reducer(state)
    // A reducer returning the SAME reference means "no change": skip the
    // persist + notify entirely — strict no-op paths (unknown tab ids,
    // patchTab on a missing tab) must not churn the state or rewrite
    // localStorage.
    if (next === state) return
    this.bySession.set(sessionId, next)
    this.snapshot = { sessionId, state: next, prefs: this.prefs }
    this.schedulePersist(sessionId, next)
    this.notify()
    this.notifySession(sessionId)
  }

  /**
   * Apply a pure reducer to a TARGET session's state (not the active one),
   * loading it on demand and persisting the result — WITHOUT switching the
   * active snapshot or notifying the global UI (the UI must not follow
   * along). Used by the service's targeted `openTab(seed, scope)` (the open
   * lands in the target session's layout and is visible whenever the user
   * switches to it) and by `attachGlobal` (the Global Workspace's virtual
   * session receives the attached stub here). The target session's OWN
   * subscribers (the Global Workspace page) ARE notified.
   */
  reduceFor(sessionId: string, reducer: (state: SidebarState) => SidebarState): void {
    // The uid counter is SHARED across sessions, and the ACTIVE session's
    // safety requires it to never drop below the ids IT minted. Seeding it
    // from the target's max may LOWER it (a cached target older than the
    // active session): restoring the pre-call level afterwards keeps the
    // active session's next mint collision-free — ids minted for the target
    // only need to exceed the target's own max, which the seed guaranteed.
    const counterBefore = nextIdCounter
    let state = this.bySession.get(sessionId)
    if (state === undefined) {
      state = loadState(sessionId, this.prefs, this.workspaceWindows ?? undefined)
      this.bySession.set(sessionId, state)
    } else {
      // Re-seed the uid counter past THIS session's persisted ids, exactly
      // like setSession's cache-hit path.
      nextIdCounter = maxCounterId(state)
    }
    const next = reducer(state)
    // Same-reference result = no change: keep the counter restore (it may
    // have been seeded down) but skip the write.
    nextIdCounter = Math.max(nextIdCounter, counterBefore)
    if (next === state) return
    this.bySession.set(sessionId, next)
    this.schedulePersist(sessionId, next)
    this.notifySession(sessionId)
  }

  private schedulePersist(sessionId: string, state: SidebarState): void {
    // Per-session debounce timers: one session's pending write must never
    // cancel another's (targeted opens schedule writes for INACTIVE
    // sessions while the active session may already have one pending —
    // a shared timer would drop the earlier write and the reload would
    // lose that session's layout).
    const existing = this.persistTimers.get(sessionId)
    if (existing !== undefined) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      this.persistTimers.delete(sessionId)
      try {
        // Workspace stubs never persist: the workspace windows store is the
        // single source of truth and every load re-merges (stripping also
        // nulls an active that pointed at a stripped stub — a dangling
        // active would fail sanitize on the next load and reset the layout).
        const clean = stripWorkspaceWindows(state)
        localStorage.setItem(`${STORAGE_PREFIX}:${sessionId}`, JSON.stringify(clean))
      } catch {
        // Storage full or unavailable: layout memory is best-effort.
      }
    }, 200)
    this.persistTimers.set(sessionId, timer)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** Fire one session's own subscribers (targeted changes, the Global
   *  Workspace page's virtual-session subscription). */
  private notifySession(sessionId: string): void {
    const set = this.sessionListeners.get(sessionId)
    if (set === undefined) return
    for (const listener of [...set]) listener()
  }
}

/**
 * Create one sidebar store instance. Production code calls this only from
 * the client plugin's `apply` (the instance is handed to components as a
 * prop); tests call it directly. No module-level singleton: the store's
 * lifetime belongs to the plugin activation, exactly like the official
 * `createXXXStore()` factory rule.
 */
export function createSidebarStore(): SidebarStore {
  return new SidebarStore()
}
