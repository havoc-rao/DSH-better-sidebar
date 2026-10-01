import { api, type WorkspaceTerminalInfo } from './api.ts'
import { allLeaves, openTabInBottomPane, patchTab, type SidebarState, type SidebarStore, type SidebarTab } from './state.ts'

export function workspaceTerminalIdOf(tab: SidebarTab): string | undefined {
  const id = (tab.meta as { workspaceTerminalId?: unknown } | null)?.workspaceTerminalId
  return typeof id === 'string' && id.startsWith('terminal:') ? id : undefined
}

/** Async callers must always commit to their captured request session. */
export function updateTerminalSession(store: SidebarStore, sessionId: string, reducer: (state: SidebarState) => SidebarState): void {
  if (store.getSnapshot().sessionId === sessionId) store.reduce(reducer)
  else store.reduceFor(sessionId, reducer)
}

export function openWorkspaceTerminal(store: SidebarStore, sessionId: string, info: WorkspaceTerminalInfo): void {
  updateTerminalSession(store, sessionId, state => {
    const existing = allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)
      .find(tab => workspaceTerminalIdOf(tab) === info.terminalId)
    const tab: SidebarTab = existing ?? {
      id: `workspace-view:${info.terminalId}`, type: 'terminal', title: info.title,
      meta: { workspaceTerminalId: info.terminalId },
    }
    return { ...openTabInBottomPane(state, tab), bottomOpen: true }
  })
}

/** Replace exactly this view's binding, never reopen a closed tab or migrate peers.
 * Creation uses the captured session's authoritative workspace cwd, not shell cwd.
 * If the view disappeared (or was rebound) while creating, release the new pty.
 * Cleanup failures intentionally reject so callers can surface them. */
export async function restartWorkspaceTerminal(
  store: SidebarStore, sessionId: string, tabId: string, previousTerminalId: string,
): Promise<boolean> {
  const original = store.getSessionStates().get(sessionId)
  if (original === undefined || !store.tabOpen(sessionId, tabId)
    || !allLeaves(original.bottomSplits).flatMap(leaf => leaf.tabs)
      .some(tab => tab.id === tabId && workspaceTerminalIdOf(tab) === previousTerminalId)) return false
  const info = await api.workspaceTerminalCreate(sessionId)
  let bound = false
  updateTerminalSession(store, sessionId, state => {
    const tab = allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)
      .find(tab => tab.id === tabId && workspaceTerminalIdOf(tab) === previousTerminalId)
    if (tab === undefined || !store.tabOpen(sessionId, tabId)) return state
    bound = true
    return { ...patchTab(state, tabId, { title: info.title, meta: {
      ...(tab.meta as Record<string, unknown>), workspaceTerminalId: info.terminalId,
      workspaceTerminalExited: info.exited, workspaceTerminalExitCode: info.exitCode,
    } }), workspaceTerminalError: undefined }
  })
  if (!bound) await api.workspaceTerminalTerminate(sessionId, info.terminalId)
  return bound
}

/** List refresh updates bound views only; it never drops legacy terminal tabs. */
export function refreshWorkspaceTerminalTabs(state: SidebarState, terminals: WorkspaceTerminalInfo[]): SidebarState {
  let next = state
  for (const tab of allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)) {
    const info = terminals.find(info => info.terminalId === workspaceTerminalIdOf(tab))
    if (info === undefined) continue
    next = patchTab(next, tab.id, { title: info.title, meta: {
      ...(tab.meta as Record<string, unknown>), workspaceTerminalExited: info.exited,
      workspaceTerminalExitCode: info.exitCode,
    } })
  }
  return next
}
