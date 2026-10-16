// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type WorkspaceTerminalInfo } from '../src/client/api.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore, allLeaves } from '../src/client/state.ts'
import { ensureBottomTerminal } from '../src/client/workspace-terminals.ts'

const info: WorkspaceTerminalInfo = { terminalId: 'shell', title: 'shell', cwd: '/work', createdBySessionId: 'A', createdAt: 1, exited: false }
afterEach(() => { vi.restoreAllMocks() })
function fixture() {
  const store = createSidebarStore(); store.setSession(`A-${Math.random()}`)
  const sessionId = store.getSnapshot().sessionId!
  const service = createBetterSidebarService(store)
  return { store, service, sessionId }
}
describe('default terminal acquisition', () => {
  it('uses backend atomic ensure instead of a local list/create race', async () => {
    const { store, service, sessionId } = fixture()
    const ensure = vi.spyOn(api, 'workspaceTerminalEnsure').mockResolvedValue(info)
    const create = vi.spyOn(api, 'workspaceTerminalCreate')
    const list = vi.spyOn(api, 'workspaceTerminalList').mockResolvedValue({ terminals: [] })
    await Promise.all([ensureBottomTerminal(store, service, sessionId), ensureBottomTerminal(store, service, sessionId)])
    expect(ensure).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(create).not.toHaveBeenCalled(); expect(list).toHaveBeenCalledExactlyOnceWith(sessionId, undefined)
    expect(allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)).toHaveLength(1)
  })
  it('bypasses an old backend ensure when a live shell already exists', async () => {
    const { store, service, sessionId } = fixture()
    vi.spyOn(api, 'workspaceTerminalList').mockResolvedValue({ terminals: [{ ...info, activity: 'busy' }] })
    const ensure = vi.spyOn(api, 'workspaceTerminalEnsure').mockRejectedValue(new Error('old backend would create'))
    const create = vi.spyOn(api, 'workspaceTerminalCreate')
    await ensureBottomTerminal(store, service, sessionId)
    expect(ensure).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)[0]!.meta)
      .toMatchObject({ workspaceTerminalId: info.terminalId })
  })
  it.each(['busy', 'unknown', 'idle'] as const)('reattaches another session %s terminal from older providers without creating one', async activity => {
    const { store, service, sessionId } = fixture()
    const create = vi.fn(async () => ({ ...info, terminalId: 'new', createdBySessionId: sessionId }))
    service.registerTerminalProvider({ id: 'old', match: () => true, createTransport: () => undefined,
      createWorkspaceSource: () => ({ create, list: async () => ({ terminals: [
        { ...info, activity, attachedViews: 2, pinned: true },
      ] }), terminate: async () => {}, createTransport: () => { throw new Error('unused') } }),
    })
    await ensureBottomTerminal(store, service, sessionId)
    expect(create).not.toHaveBeenCalled()
    expect(allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)[0]!.meta)
      .toMatchObject({ workspaceTerminalId: info.terminalId, workspaceTerminalProviderId: 'old' })
  })
  it('creates through an older provider only when no live terminal remains', async () => {
    const { store, service, sessionId } = fixture()
    const create = vi.fn(async () => ({ ...info, terminalId: 'new' }))
    service.registerTerminalProvider({ id: 'old', match: () => true, createTransport: () => undefined,
      createWorkspaceSource: () => ({ create, list: async () => ({ terminals: [{ ...info, exited: true }] }),
        terminate: async () => {}, createTransport: () => { throw new Error('unused') } }),
    })
    await ensureBottomTerminal(store, service, sessionId)
    expect(create).toHaveBeenCalledOnce()
    expect(allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)[0]!.meta)
      .toMatchObject({ workspaceTerminalId: 'new' })
  })
  it('never falls back to local on remote ensure errors', async () => {
    const { store, service, sessionId } = fixture()
    const local = vi.spyOn(api, 'workspaceTerminalEnsure')
    const create = vi.fn()
    service.registerTerminalProvider({ id: 'remote', match: () => true, createTransport: () => undefined,
      createWorkspaceSource: () => ({ create, ensure: async () => { throw new Error('remote quota') },
        list: async () => ({ terminals: [] }), terminate: async () => {}, createTransport: () => { throw new Error('unused') } }),
    })
    await ensureBottomTerminal(store, service, sessionId)
    expect(local).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
    expect(store.getSnapshot().state!.workspaceTerminalError).toBe('remote quota')
  })
})
