/** Workspace tool membership projected into session-owned native tabs.
 * No private host stores, polling, resource-address copying, or layout replay.
 * Host opens are foreground-only; restore the selected page/column synchronously.
 */
import type { Context } from '../context-types.ts'
import { hostRouteUrl } from './host-route-url.ts'
import { hostTransportBase } from './desktop-env.ts'
import { createWorkspaceToolTabsStore, type WorkspaceToolKind } from './workspace-tool-tabs-store.ts'

interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface Occurrence { sessionId: string; tabId: string; kind: string; contentId: string }
export interface WorkspaceTabsController {
  mounted: Source<string | undefined>
  openTabs: Source<readonly Occurrence[]>
  tabsIn(sessionId: string): readonly { id: string; kind: string }[]
  commandTarget(element: null): unknown
  openTab(kind: string): void
  close(tabId: string): void
  active(): { id: string; kind: string } | undefined
  focus(tabId: string): void
  isExpanded(): boolean
  toggleExpanded(): void
}
export interface WorkspaceMembership {
  phase: string
  state: string
  items: readonly { workspaceId?: string; path: string; sessionIds: readonly string[] }[]
}

/** Live leases only: removed when their Git body unmounts. Never persisted/shared. */
const closeBlocks = new Map<object, { sessionId: string; blocked: boolean }>()
const closeListeners = new Set<() => void>()
export function retainGitToolCloseGuard(sessionId: string, blocked: boolean): () => void {
  const token = {}
  closeBlocks.set(token, { sessionId, blocked })
  for (const listener of closeListeners) listener()
  return () => {
    closeBlocks.delete(token)
    for (const listener of closeListeners) listener()
  }
}
const isTool = (kind: string): kind is WorkspaceToolKind => kind === 'files' || kind === 'git'

/** Exported seam for deterministic inventory/late-adoption/cross-window tests. */
export function syncWorkspaceToolTabs(options: {
  controller: WorkspaceTabsController
  workspaces: Source<WorkspaceMembership>
  store: ReturnType<typeof createWorkspaceToolTabsStore>
  enabled(kind: WorkspaceToolKind): boolean
  subscribeEnabled?(listener: () => void): () => void
}): () => void {
  const { controller, workspaces, store } = options
  let previous = controller.openTabs.getSnapshot()
  let lastSession: string | undefined
  let lastWorkspace: string | undefined
  let disposed = false
  let queued = false
  let writing = false
  let readinessFrames = 0
  let retrySession: string | undefined
  let frame: number | undefined
  const retryAfterRender = (): void => {
    if (frame !== undefined || readinessFrames >= 60 || typeof requestAnimationFrame !== 'function') return
    readinessFrames++
    frame = requestAnimationFrame(() => { frame = undefined; schedule() })
  }
  const schedule = (): void => {
    if (disposed || queued || writing) return
    queued = true
    queueMicrotask(() => { queued = false; if (!disposed) sync() })
  }
  const sync = (): void => {
    const rows = controller.openTabs.getSnapshot()
    const sid = controller.mounted.getSnapshot()
    const membership = workspaces.getSnapshot()
    const workspace = membership.phase === 'ready' && membership.state === 'idle'
      ? membership.items.find(item => item.sessionIds.includes(sid ?? '')) : undefined
    // Unknown membership is NOT a shared bucket. Mounted precedes React's
    // adoption effect, which may not change inventory (saved-identical tabs).
    if (!sid || !workspace) {
      previous = rows
      lastSession = undefined
      lastWorkspace = undefined
      return
    }
    if (sid !== retrySession) { readinessFrames = 0; retrySession = sid }
    if (!controller.commandTarget(null)) {
      retryAfterRender()
      return
    }
    const key = workspace.workspaceId ?? workspace.path
    writing = true
    try {
      if (store.read(key) === undefined) {
        store.seed(key, rows.filter(row => workspace.sessionIds.includes(row.sessionId) && isTool(row.kind))
          .map(row => row.kind as WorkspaceToolKind))
      }
      lastSession = sid
      lastWorkspace = key
      const wanted = store.read(key) ?? []
      const active = controller.active()
      const expanded = controller.isExpanded()
      const focused = typeof document === 'undefined' ? null : document.activeElement
      let opened = false
      for (const kind of ['files', 'git'] as const) {
        if (!options.enabled(kind)) continue
        const occurrences = controller.openTabs.getSnapshot().filter(row => row.sessionId === sid && row.kind === kind)
        if (wanted.includes(kind)) {
          if (occurrences.length === 0) {
            try { controller.openTab(kind); opened = true }
            catch (error) {
              // The mounted feed precedes adoption. Keep desired membership;
              // a bounded after-render retry bridges saved-identical adoption.
              if (error instanceof Error && error.message.includes('no session surface is mounted')) retryAfterRender()
              else console.warn('[dsh-better-sidebar] workspace tool restore failed:', error)
            }
          }
        } else {
          // A remote close cannot interrupt a Git operation or confirmation.
          if (kind === 'git' && [...closeBlocks.values()].some(lease => lease.sessionId === sid && lease.blocked)) continue
          for (const row of occurrences) controller.close(row.tabId)
        }
      }
      if (opened) {
        // Keep real content selected, but allow a fresh guide to become a tool.
        if (active && active.kind !== 'guide' && controller.tabsIn(sid).some(tab => tab.id === active.id)) controller.focus(active.id)
        if (!expanded && controller.isExpanded()) controller.toggleExpanded()
        // Host collapse can focus its pane synchronously. Restore the live
        // input now, never in a delayed task that could steal a later user click.
        if (typeof HTMLElement !== 'undefined' && focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
      }
    } finally {
      previous = controller.openTabs.getSnapshot()
      writing = false
    }
  }
  // Attribute inventory deltas immediately, before a same-task session switch
  // can replace the mounted seat. Reconcile itself remains coalesced/deferred.
  const onInventory = (): void => {
    const rows = controller.openTabs.getSnapshot()
    const sid = controller.mounted.getSnapshot()
    // Inventory publishes BEFORE the host TabDomain updates occurrences; never
    // call commandTarget here (it can throw for a just-created active tab).
    if (!writing && sid && sid === lastSession && lastWorkspace) {
      for (const kind of ['files', 'git'] as const) {
        if (!options.enabled(kind)) continue
        const had = previous.some(row => row.sessionId === sid && row.kind === kind)
        const has = rows.some(row => row.sessionId === sid && row.kind === kind)
        if (had !== has) store.set(lastWorkspace, kind, has)
      }
    }
    previous = rows
    schedule()
  }
  const off = [controller.openTabs.subscribe(onInventory), controller.mounted.subscribe(schedule),
    workspaces.subscribe(schedule), store.subscribe(schedule)]
  if (options.subscribeEnabled) off.push(options.subscribeEnabled(schedule))
  closeListeners.add(schedule)
  schedule()
  return () => {
    disposed = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    for (const dispose of off) dispose()
    closeListeners.delete(schedule)
  }
}

/** One controller/observer per plugin activation, not one per retained tab body. */
export function installWorkspaceToolTabs(ctx: Context, service: {
  isTabEnabled(kind: string): boolean
  subscribe(listener: () => void): () => void
  subscribeState(listener: () => void): () => void
}): void {
  ctx.inject(['sidebarRight', 'workspaces'], scope => {
    const controller = scope.get('sidebarRight') as unknown as WorkspaceTabsController | undefined
    const workspaces = scope.get('workspaces') as unknown as { list: Source<WorkspaceMembership> } | undefined
    if (!controller?.openTabs || !workspaces?.list?.subscribe) return
    scope.effect(() => {
      let storage: Storage | undefined
      try { storage = globalThis.localStorage } catch { /* private mode */ }
      const store = createWorkspaceToolTabsStore({
        storage,
        namespace: hostRouteUrl('.', hostTransportBase()).href,
        subscribeStorage: listener => {
          const onStorage = (event: StorageEvent): void => {
            if ((event.storageArea === storage || event.storageArea === null)
              && (event.key === null || event.key.startsWith('better-sidebar:workspace-tool-tabs:v1:'))) listener()
          }
          window.addEventListener('storage', onStorage)
          return () => window.removeEventListener('storage', onStorage)
        },
      })
      const dispose = syncWorkspaceToolTabs({ controller, workspaces: workspaces.list, store,
        enabled: kind => service.isTabEnabled(kind === 'files' ? 'editor' : kind),
        subscribeEnabled: listener => {
          const offRegistry = service.subscribe(listener)
          const offState = service.subscribeState(listener)
          return () => { offRegistry(); offState() }
        } })
      return () => { dispose(); store.dispose() }
    }, 'dsh-better-sidebar: workspace tool tabs')
  })
}
