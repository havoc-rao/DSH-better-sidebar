import { api, type WorkspaceTerminalInfo } from './api.ts'
import { allLeaves, openTabInBottomPane, patchTab, type SidebarState, type SidebarStore, type SidebarTab } from './state.ts'
import type { Context } from '../context-types.ts'
import type { BetterSidebarService } from './service.ts'
import type { WorkspaceTerminalBinding, WorkspaceTerminalSource } from './terminal-source.ts'

export function workspaceTerminalProviderOf(tab: SidebarTab): string | undefined {
  const id = (tab.meta as { workspaceTerminalProviderId?: unknown } | null)?.workspaceTerminalProviderId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export function terminalServiceOf(ctx?: Context): BetterSidebarService | undefined {
  return ctx?.betterSidebar ?? ctx?.get?.('betterSidebar')
}

/** A saved provider identity never re-resolves to another backend (or local).
 * A matched legacy provider must explicitly opt into managed lifetime. */
export function resolveWorkspaceTerminalBinding(
  service: BetterSidebarService | undefined, sessionId: string, cwd?: string,
  providerId?: string, localOnly = false,
): WorkspaceTerminalBinding {
  if (!localOnly) {
    const providers = service?.getTerminalProviders?.() ?? []
    const provider = providerId === undefined
      ? providers.find(provider => provider.match(sessionId, cwd, 'terminal:workspace-management'))
      : providers.find(provider => provider.id === providerId)
    if (provider !== undefined) {
      const source = provider.createWorkspaceSource?.(sessionId, cwd)
      if (source === undefined) throw new Error(`Workspace terminal management unavailable: ${provider.id}`)
      return { providerId: provider.id, source }
    }
    if (providerId !== undefined) throw new Error(`Workspace terminal provider unavailable: ${providerId}`)
  }
  const source: WorkspaceTerminalSource = {
    create: title => title === undefined ? api.workspaceTerminalCreate(sessionId) : api.workspaceTerminalCreate(sessionId, title),
    list: signal => api.workspaceTerminalList(sessionId, signal),
    terminate: terminalId => api.workspaceTerminalTerminate(sessionId, terminalId),
    // Local managed views use the native workspace WebSocket, not this method.
    createTransport: () => { throw new Error('Local workspace transport is built in') },
  }
  return { source }
}

export function workspaceTerminalIdOf(tab: SidebarTab): string | undefined {
  const id = (tab.meta as { workspaceTerminalId?: unknown } | null)?.workspaceTerminalId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Async callers must always commit to their captured request session. */
export function updateTerminalSession(store: SidebarStore, sessionId: string, reducer: (state: SidebarState) => SidebarState): void {
  if (store.getSnapshot().sessionId === sessionId) store.reduce(reducer)
  else store.reduceFor(sessionId, reducer)
}

export function workspaceTerminalViewId(terminalId: string, providerId?: string): string {
  return `workspace-view:${providerId ? `${encodeURIComponent(providerId)}:` : ''}${terminalId}`
}

export function openWorkspaceTerminal(store: SidebarStore, sessionId: string, info: WorkspaceTerminalInfo, providerId?: string): void {
  updateTerminalSession(store, sessionId, state => {
    const existing = allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)
      .find(tab => workspaceTerminalIdOf(tab) === info.terminalId && workspaceTerminalProviderOf(tab) === providerId)
    const tab: SidebarTab = existing ?? {
      id: workspaceTerminalViewId(info.terminalId, providerId), type: 'terminal', title: info.title,
      meta: { workspaceTerminalId: info.terminalId, ...(providerId === undefined ? {} : { workspaceTerminalProviderId: providerId }) },
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
  binding?: WorkspaceTerminalBinding,
): Promise<boolean> {
  const original = store.getSessionStates().get(sessionId)
  if (original === undefined || !store.tabOpen(sessionId, tabId)
    || !allLeaves(original.bottomSplits).flatMap(leaf => leaf.tabs)
      .some(tab => tab.id === tabId && workspaceTerminalIdOf(tab) === previousTerminalId)) return false
  const originalTab = allLeaves(original.bottomSplits).flatMap(leaf => leaf.tabs).find(tab => tab.id === tabId)!
  const providerId = workspaceTerminalProviderOf(originalTab)
  if (binding?.providerId !== providerId) throw new Error('Workspace terminal backend mismatch')
  const source = binding?.source ?? resolveWorkspaceTerminalBinding(undefined, sessionId, undefined, undefined, true).source
  const info = await source.create()
  let bound = false
  updateTerminalSession(store, sessionId, state => {
    const tab = allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)
      .find(tab => tab.id === tabId && workspaceTerminalIdOf(tab) === previousTerminalId && workspaceTerminalProviderOf(tab) === providerId)
    if (tab === undefined || !store.tabOpen(sessionId, tabId)) return state
    bound = true
    return { ...patchTab(state, tabId, { title: info.title, meta: {
      ...(tab.meta as Record<string, unknown>), workspaceTerminalId: info.terminalId,
      workspaceTerminalExited: info.exited, workspaceTerminalExitCode: info.exitCode,
    } }), workspaceTerminalError: undefined }
  })
  if (!bound) await source.terminate(info.terminalId)
  return bound
}

/** List refresh updates bound views only; it never drops legacy terminal tabs. */
export function refreshWorkspaceTerminalTabs(state: SidebarState, terminals: WorkspaceTerminalInfo[], providerId?: string): SidebarState {
  let next = state
  for (const tab of allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)) {
    if (workspaceTerminalProviderOf(tab) !== providerId) continue
    const info = terminals.find(info => info.terminalId === workspaceTerminalIdOf(tab))
    if (info === undefined) continue
    next = patchTab(next, tab.id, { title: info.title, meta: {
      ...(tab.meta as Record<string, unknown>), workspaceTerminalExited: info.exited,
      workspaceTerminalExitCode: info.exitCode,
    } })
  }
  return next
}
