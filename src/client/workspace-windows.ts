/**
 * The workspace windows store: workspace-bound windows ("pinned" tabs
 * shared by every session of a workspace). One blob per workspace,
 * persisted in localStorage — the single source of truth for the bound
 * window definitions (type/title/path/diff/meta). Sessions never persist
 * bound windows: they hold only `ws:`-prefixed STUBS in their first leaf
 * (see state.ts `reconcileWorkspaceWindows` / `stripWorkspaceWindows`), and
 * the render layer resolves stub ids against this store's live definitions
 * — so a bind/unbind/update in one session re-renders in every session of
 * the workspace for free (no per-session copies, no back-propagation).
 *
 * The store resolves session → workspace through the client runtime's
 * workspaces list feed (`ctx.workspaces.list`, mirror of
 * `WorkspaceRuntime.list`): a session belongs to the workspace whose
 * `sessionIds` contains it; sessions outside any workspace have no bound
 * windows (the bind menu is disabled for them).
 *
 * Scope: ANY tab can be bound except agent-owned terminals (`agent:` ids —
 * the model creates/closes them, and the reconcile would fight the pin).
 * Content windows (editor file tabs / browser / diff) share their full
 * definition (path / diff) — the same content everywhere. Session-scoped
 * views (terminal / git / subagent / the path-less Files home) share the
 * WINDOW only: a bound TERMINAL is one workspace-shared PTY (host keys
 * `ws:` stubs by `shared:<tabId>`, so every session attaches to the same
 * process; bind/unbind re-parent the live handle instead of respawning),
 * git/subagent render per session from their own scope. Live editor
 * buffers (cursor/scroll/unsaved drafts) are NOT synced — only the window
 * definitions. Bound windows render in the BOTTOM box's first leaf (the
 * pin lives in the bottom panel); the right panel stays session-local.
 */
import type { Context, SidebarWorkspaceListState, SidebarWorkspaceView } from '../context-types.ts'
import { api } from './api.ts'
import {
  WS_TAB_PREFIX, activateTab, firstLeaf, isAgentTabId, isBoundTabId, mapLeaf, mintTabId,
  type SidebarDiffRef, type SidebarStore, type SidebarTab, type SplitNode, type WorkspaceWindow, type WorkspaceWindowsSource,
} from './state.ts'

const STORAGE_PREFIX = 'dsh-sidebar:v1'

/** The persisted per-workspace blob (validated on load, corrupt → reset). */
interface WorkspaceWindowsBlob {
  version: 1
  /** Monotonic stub-id counter (ids survive reloads: `ws:<wsId8>:<n>`). */
  nextId: number
  /** Bound windows in bind order. */
  tabs: WorkspaceWindow[]
}

/** The uSES snapshot the shell renders from (stable reference between
 *  changes; carries the ACTIVE session's workspace resolution). */
export interface WorkspaceWindowsSnapshot {
  sessionId: string | undefined
  /** The active session's workspace id (undefined: no session / ungrouped). */
  workspaceId: string | undefined
  /** The workspace display title (the bind menu label). */
  workspaceTitle: string | undefined
  /** The workspace's bound windows ([] without a workspace). */
  windows: readonly WorkspaceWindow[]
}

/** The client runtime's workspaces list feed (structural subset; the full
 *  service may be absent on older runtimes — degrade to no windows). */
type WorkspaceListFeed = {
  getSnapshot(): SidebarWorkspaceListState
  subscribe(fn: () => void): () => void
}

export class WorkspaceWindowsStore implements WorkspaceWindowsSource {
  private readonly blobs = new Map<string, WorkspaceWindowsBlob>()
  private readonly listeners = new Set<() => void>()
  /** Per-workspace persist debounce timers (one per workspace, mirroring
   *  SidebarStore's per-session pattern). */
  private readonly persistTimers = new Map<string, number>()
  private sidebarStore: SidebarStore | null = null
  private workspaceList: SidebarWorkspaceListState = { items: [] }
  private snapshot: WorkspaceWindowsSnapshot = {
    sessionId: undefined,
    workspaceId: undefined,
    workspaceTitle: undefined,
    windows: [],
  }
  private readonly dispose: Array<() => void> = []

  constructor(private readonly ctx: Context) {}

  /** Attach the sidebar store and start the feeds. Call once from apply,
   *  before any session loads. Wires BOTH directions: this store resolves
   *  the active session's workspace (sidebar → windows), and the sidebar
   *  store's reconcile pass re-merges bound windows into every cached
   *  session state on change (windows → sidebar). */
  attachSidebarStore(store: SidebarStore): void {
    this.sidebarStore = store
    store.attachWorkspaceWindows(this)
    this.dispose.push(store.subscribe(() => this.refreshSnapshot()))
    const feed = (this.ctx.workspaces as { list?: WorkspaceListFeed }).list
    if (feed !== undefined) {
      this.workspaceList = feed.getSnapshot()
      this.dispose.push(feed.subscribe(() => {
        this.workspaceList = feed.getSnapshot()
        this.refreshSnapshot()
      }))
    }
    this.refreshSnapshot()
  }

  /** Dispose the feed subscriptions (HMR re-activation safety). */
  disposeAll(): void {
    for (const disposer of this.dispose.splice(0)) disposer()
    this.sidebarStore = null
  }

  // ── uSES / source face ───────────────────────────────────────────────────

  getSnapshot(): WorkspaceWindowsSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** WorkspaceWindowsSource: the bound windows of the workspace owning a
   *  session ([] for ungrouped sessions or an unavailable feed). */
  windowsOfSession(sessionId: string): readonly WorkspaceWindow[] {
    const workspace = this.workspaceOfSession(sessionId)
    return workspace === undefined ? [] : this.blobOf(workspace.workspaceId).tabs
  }

  // ── Mutations (act on the ACTIVE session's workspace) ────────────────────

  /**
   * Bind a session-local tab to the active session's workspace. The
   * window's definition (type/title/path/diff/meta) moves into the store
   * under a fresh stable stub id; every session of the workspace re-renders
   * it (the store change reconciles all cached session states). The binding
   * session loses the local tab itself from BOTH trees — plus any content
   * duplicate (same type + path, e.g. the same file open twice) — and the
   * first leaf's active moves to the new stub when the bound tab was the
   * active one anywhere.
   *
   * Identity rules: content windows (with a path) dedupe against an
   * existing bound window of the same type+path (paranoia — the open
   * plumbing prevents local duplicates) and bind as THE window; path-less
   * windows (terminal/git/subagent/Files…) NEVER dedupe — binding two local
   * terminals creates two shared terminal windows.
   *
   * A bound TERMINAL keeps its process: the tab id changes (local →
   * stub), and without re-parenting the unmount close frame releases the
   * old key's pty while the stub's attach spawns a fresh shell under the
   * shared key — a running process would die on every bind. The live
   * handle is re-parented to the stub's shared key BEFORE the tree swap,
   * so the old view's close frame targets a key that no longer holds a
   * process (host no-op). Best-effort: a failed reparent (host down,
   * degraded node-pty, pty never opened) degrades to the old behavior.
   */
  async bind(tab: SidebarTab): Promise<void> {
    const sessionId = this.sidebarStore?.getSnapshot().sessionId
    if (sessionId === undefined) return
    const workspace = this.workspaceOfSession(sessionId)
    if (workspace === undefined) return
    const blob = this.blobOf(workspace.workspaceId)
    const hasPath = tab.path !== undefined && tab.path !== ''
    const existing = hasPath
      ? blob.tabs.find(window => window.type === tab.type && window.path === tab.path)
      : undefined
    if (existing !== undefined) {
      // Already bound (paranoia path — the open/dedupe plumbing prevents
      // local duplicates): drop any stray local duplicate and focus the
      // existing stub.
      this.stripLocalDuplicates(tab)
      this.focusStub(existing.id)
      return
    }
    const id = `${WS_TAB_PREFIX}${workspace.workspaceId.slice(0, 8)}:${blob.nextId}`
    blob.nextId += 1
    if (tab.type === 'terminal' && !isAgentTabId(tab.id)) {
      try {
        await api.ptyReparent({ sessionId }, tab.id, id)
      } catch {
        // Best-effort: a failed reparent leaves the old pty to be released
        // by the unmount close frame — the stub spawns fresh, status quo.
      }
    }
    // Never mutate the tabs array in place: the snapshot hands it to React
    // (uSES reference identity), so every mutation must mint a new array.
    blob.tabs = [...blob.tabs, {
      id,
      type: tab.type,
      title: tab.title,
      ...(tab.path !== undefined ? { path: tab.path } : {}),
      ...(tab.diff !== undefined ? { diff: tab.diff } : {}),
      ...(tab.meta !== undefined ? { meta: tab.meta } : {}),
    }]
    this.persist(workspace.workspaceId, blob)
    this.sidebarStore?.reduce(s => {
      // The bound tab itself always leaves the tree (the window moved into
      // the shared set); content duplicates (same type + path) leave too —
      // but NEVER same-type path-less tabs (other local terminals are not
      // duplicates). A dangling `active` (it pointed at a removed tab) is
      // nulled so no later sanitize pass sees a corrupt pointer.
      let wasActiveAnywhere = false
      const strip = (node: SplitNode): SplitNode => {
        if (node.kind === 'leaf') {
          const tabs = node.tabs.filter(candidate => {
            if (candidate.id === tab.id) return false
            if (hasPath && candidate.type === tab.type && candidate.path === tab.path) return false
            return true
          })
          if (tabs === node.tabs) return node
          if (node.active === tab.id) wasActiveAnywhere = true
          const active = node.active !== null && !tabs.some(candidate => candidate.id === node.active) ? null : node.active
          return { ...node, tabs, active }
        }
        return { ...node, children: node.children.map(strip) }
      }
      const target = firstLeaf(s.bottomSplits)
      const splits = strip(s.splits)
      const bottomSplits = strip(s.bottomSplits)
      return {
        ...s,
        // Pinned windows live in the BOTTOM box: binding opens the bottom
        // panel in this session so the result is in sight, and the bottom
        // first leaf's active moves to the stub when the bound tab was the
        // active one anywhere.
        bottomOpen: true,
        splits,
        bottomSplits: mapLeaf(bottomSplits, target.id, leaf => {
          if (wasActiveAnywhere) leaf.active = id
        }),
      }
    })
    this.refreshSnapshot()
  }

  /**
   * Unbind a bound window (stub id) from the active session's workspace.
   * `keepInSession` materializes the window as a plain local tab in the
   * binding session's first leaf (the "stop sharing, keep it here" path);
   * otherwise the window closes everywhere (the stub's ✕ close path).
   *
   * An UNBOUND TERMINAL keeps its process: the stub is replaced by a
   * freshly minted local tab id, and without re-parenting the stub's
   * unmount close frame kills the shared pty while the local tab's attach
   * spawns a fresh shell — a running process would die on every unbind.
   * The live handle is re-parented to the local id's session key BEFORE
   * the tree swap (the local id is minted here so the migration target is
   * known), so the stub view's close frame targets a key that no longer
   * holds a process (host no-op). Best-effort: a failed reparent degrades
   * to the old behavior. The ✕ close path (`keepInSession: false`) sends
   * no reparent — closing the shared window everywhere still kills the pty.
   */
  async unbind(tabId: string, keepInSession: boolean): Promise<void> {
    const sessionId = this.sidebarStore?.getSnapshot().sessionId
    if (sessionId === undefined) return
    const workspace = this.workspaceOfSession(sessionId)
    if (workspace === undefined) return
    const blob = this.blobOf(workspace.workspaceId)
    const boundWindow = blob.tabs.find(candidate => candidate.id === tabId)
    if (boundWindow === undefined) return
    const localId = keepInSession ? mintTabId() : undefined
    if (keepInSession && boundWindow.type === 'terminal' && localId !== undefined) {
      try {
        await api.ptyReparent({ sessionId }, tabId, localId)
      } catch {
        // Best-effort: a failed reparent leaves the shared pty to be
        // released by the stub's unmount close frame — the local tab
        // spawns fresh, status quo.
      }
    }
    blob.tabs = blob.tabs.filter(candidate => candidate.id !== tabId)
    this.persist(workspace.workspaceId, blob)
    if (keepInSession && localId !== undefined) {
      this.sidebarStore?.reduce(s => {
        // The stub lives in the BOTTOM box's first leaf: the detached local
        // tab materializes there (in place of the stub).
        const target = firstLeaf(s.bottomSplits)
        if (!target.tabs.some(candidate => candidate.id === tabId)) return s
        return {
          ...s,
          bottomSplits: mapLeaf(s.bottomSplits, target.id, leaf => {
            leaf.tabs = leaf.tabs.map(candidate => candidate.id === tabId
              ? {
                id: localId,
                type: boundWindow.type,
                title: boundWindow.title,
                ...(boundWindow.path !== undefined ? { path: boundWindow.path } : {}),
                ...(boundWindow.diff !== undefined ? { diff: boundWindow.diff } : {}),
                ...(boundWindow.meta !== undefined ? { meta: boundWindow.meta } : {}),
              }
              : candidate)
            if (leaf.active === tabId) leaf.active = localId
          }),
        }
      })
    }
    this.refreshSnapshot()
  }

  /** Update a bound window's definition (the `updateTab` route for stubs:
   *  e.g. the editorExplorer in-place switch rewrites path/title here, and
   *  every session's render of the stub follows). */
  update(tabId: string, patch: { title?: string; path?: string; meta?: unknown }): void {
    const sessionId = this.sidebarStore?.getSnapshot().sessionId
    const workspace = sessionId === undefined ? undefined : this.workspaceOfSession(sessionId)
    if (workspace === undefined) return
    const blob = this.blobOf(workspace.workspaceId)
    let changed = false
    blob.tabs = blob.tabs.map(window => {
      if (window.id !== tabId) return window
      changed = true
      return {
        ...window,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.path !== undefined ? { path: patch.path } : {}),
        ...(patch.meta !== undefined ? { meta: patch.meta } : {}),
      }
    })
    if (!changed) return
    this.persist(workspace.workspaceId, blob)
    this.refreshSnapshot()
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** The workspace owning a session (linear scan; ungrouped → undefined). */
  workspaceOfSession(sessionId: string): SidebarWorkspaceView | undefined {
    return this.workspaceList.items.find(workspace => workspace.sessionIds.includes(sessionId))
  }

  /** Focus a stub in the active session's BOTTOM tree (bind-dedupe path:
   *  stubs live in the bottom box's first leaf). */
  private focusStub(tabId: string): void {
    this.sidebarStore?.reduce(s => {
      const target = firstLeaf(s.bottomSplits)
      if (!target.tabs.some(candidate => candidate.id === tabId)) return s
      return activateTab(s, target.id, tabId)
    })
  }

  /** Drop local duplicates of a just-bound window (same type + path) from
   *  BOTH trees, nulling any dangling `active` (a pointer into a removed
   *  tab would fail the next sanitize pass). Stubs are never touched. */
  private stripLocalDuplicates(tab: SidebarTab): void {
    this.sidebarStore?.reduce(s => {
      const splits = stripLocalTabs(s.splits, tab)
      const bottomSplits = stripLocalTabs(s.bottomSplits, tab)
      if (splits === s.splits && bottomSplits === s.bottomSplits) return s
      return { ...s, splits, bottomSplits }
    })
  }

  /** Load (or mint) the per-workspace blob, sanitizing persisted data. */
  private blobOf(workspaceId: string): WorkspaceWindowsBlob {
    const cached = this.blobs.get(workspaceId)
    if (cached !== undefined) return cached
    let blob: WorkspaceWindowsBlob | undefined
    try {
      blob = sanitizeBlob(localStorage.getItem(`${STORAGE_PREFIX}:ws-windows:${workspaceId}`))
    } catch {
      blob = undefined
    }
    if (blob === undefined) blob = { version: 1, nextId: 1, tabs: [] }
    this.blobs.set(workspaceId, blob)
    return blob
  }

  private persist(workspaceId: string, blob: WorkspaceWindowsBlob): void {
    const existing = this.persistTimers.get(workspaceId)
    if (existing !== undefined) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      this.persistTimers.delete(workspaceId)
      try {
        localStorage.setItem(`${STORAGE_PREFIX}:ws-windows:${workspaceId}`, JSON.stringify(blob))
      } catch {
        // Storage full or unavailable: bound-window memory is best-effort.
      }
    }, 200)
    this.persistTimers.set(workspaceId, timer)
  }

  /** Recompute the snapshot from the active session + workspace list.
   *  The windows array is the blob's live array (stable between changes),
   *  so the snapshot reference only changes on real change. */
  private refreshSnapshot(): void {
    const sessionId = this.sidebarStore?.getSnapshot().sessionId
    const workspace = sessionId === undefined ? undefined : this.workspaceOfSession(sessionId)
    const windows = workspace === undefined ? [] : this.blobOf(workspace.workspaceId).tabs
    if (
      this.snapshot.sessionId === sessionId
      && this.snapshot.workspaceId === workspace?.workspaceId
      && this.snapshot.workspaceTitle === workspace?.title
      && this.snapshot.windows === windows
    ) {
      return
    }
    this.snapshot = {
      sessionId,
      workspaceId: workspace?.workspaceId,
      workspaceTitle: workspace?.title,
      windows,
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** Structural validation of one persisted blob (corrupt → undefined → the
 *  caller resets to an empty blob). `nextId` is also raised past the
 *  largest counter seen in tab ids, so hand-edited blobs cannot mint
 *  colliding stub ids. */function sanitizeBlob(raw: string | null): WorkspaceWindowsBlob | undefined {
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return undefined
    const record = parsed as Record<string, unknown>
    if (record.version !== 1) return undefined
    if (typeof record.nextId !== 'number' || !Number.isInteger(record.nextId) || record.nextId < 1) return undefined
    if (!Array.isArray(record.tabs)) return undefined
    const tabs: WorkspaceWindow[] = []
    let maxId = 0
    for (const item of record.tabs) {
      if (item === null || typeof item !== 'object') return undefined
      const candidate = item as Record<string, unknown>
      if (typeof candidate.id !== 'string' || typeof candidate.type !== 'string' || typeof candidate.title !== 'string') {
        return undefined
      }
      const match = /^ws:[^:]+:(\d+)$/.exec(candidate.id)
      if (match !== null) maxId = Math.max(maxId, Number(match[1]))
      tabs.push({
        id: candidate.id,
        type: candidate.type,
        title: candidate.title,
        ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
        ...(isDiffRef(candidate.diff) ? { diff: candidate.diff } : {}),
        ...(candidate.meta !== undefined ? { meta: candidate.meta } : {}),
      })
    }
    return { version: 1, nextId: Math.max(record.nextId, maxId + 1), tabs }
  } catch {
    return undefined
  }
}

/** Loose shape check for a persisted diff ref (both kinds are plain data). */
function isDiffRef(value: unknown): value is SidebarDiffRef {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.kind === 'worktree' || record.kind === 'commit'
}

/** Drop local tabs matching a just-bound window (same type + path) from one
 *  tree, nulling a dangling `active` (a pointer into a removed tab would
 *  fail the next sanitize pass). Stubs are never touched. */
function stripLocalTabs(node: SplitNode, tab: SidebarTab): SplitNode {
  if (node.kind === 'leaf') {
    const tabs = node.tabs.filter(candidate => isBoundTabId(candidate.id) || !(candidate.type === tab.type && candidate.path === tab.path))
    if (tabs === node.tabs) return node
    const active = node.active !== null && !tabs.some(candidate => candidate.id === node.active) ? null : node.active
    return { ...node, tabs, active }
  }
  return { ...node, children: node.children.map(child => stripLocalTabs(child, tab)) }
}

/** Create one workspace windows store (the factory rule: no module-level
 *  singleton — the instance belongs to the plugin activation). */
export function createWorkspaceWindowsStore(ctx: Context): WorkspaceWindowsStore {
  return new WorkspaceWindowsStore(ctx)
}
