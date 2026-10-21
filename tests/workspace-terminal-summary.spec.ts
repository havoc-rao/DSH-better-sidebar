// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type WorkspaceTerminalInfo } from '../src/client/api.ts'
import { createBetterSidebarService, SIDEBAR_FEATURES } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

const info: WorkspaceTerminalInfo = { terminalId: 'one', title: 'shell', cwd: '/work', createdBySessionId: 'A', createdAt: 1, exited: false }
function fixture() { return createBetterSidebarService(createSidebarStore(), undefined, () => '/work') }
afterEach(() => { vi.restoreAllMocks() })
describe('workspace terminal summary capability', () => {
  it('counts live processes once and never treats missing or unknown activity as busy', async () => {
    const service = fixture()
    vi.spyOn(api, 'workspaceTerminalList').mockResolvedValue({ terminals: [
      { ...info, activity: 'busy' }, { ...info, activity: 'busy' },
      { ...info, terminalId: 'idle', activity: 'idle' },
      { ...info, terminalId: 'unknown', activity: 'unknown' },
      { ...info, terminalId: 'old-provider' },
      { ...info, terminalId: 'exited', activity: 'busy', exited: true },
      { ...info, terminalId: 'exited-state', activity: 'exited' },
    ] })
    expect(SIDEBAR_FEATURES).toContain('workspaceTerminalSummary')
    expect(await service.getWorkspaceTerminalSummary({ sessionId: 'A' })).toEqual({ total: 4, busy: 1, idle: 1, unknown: 2, exited: 2 })
    expect(api.workspaceTerminalList).toHaveBeenCalledExactlyOnceWith('A', undefined)
  })
  it('aggregates validated names once per busy terminal and ignores stale metadata', async () => {
    const service = fixture()
    vi.spyOn(api, 'workspaceTerminalList').mockResolvedValue({ terminals: [
      { ...info, activity: 'busy', runningCommands: ['node', 'node', 'claude', '/secret/path', 'node --token=secret', '\u001b[31m', 'x'.repeat(65)] },
      { ...info, activity: 'busy', runningCommands: ['ignored-duplicate-id'] },
      { ...info, terminalId: 'two', activity: 'busy', runningCommands: ['node'] },
      ...(['idle', 'unknown', 'exited'] as const).map(activity => ({ ...info, terminalId: activity, activity, runningCommands: ['stale'] })),
      { ...info, terminalId: 'exited-busy', exited: true, activity: 'busy', runningCommands: ['stale'] },
      { ...info, terminalId: 'old-provider', activity: 'busy' },
    ] })
    expect(await service.getWorkspaceTerminalSummary({ sessionId: 'A' })).toEqual({
      total: 5, busy: 3, idle: 1, unknown: 1, exited: 2,
      runningCommands: [{ name: 'claude', count: 1 }, { name: 'node', count: 2 }],
    })
  })
  it('routes through the captured remote backend without local fallback', async () => {
    const service = fixture()
    const local = vi.spyOn(api, 'workspaceTerminalList')
    const list = vi.fn(async () => ({ terminals: [{ ...info, activity: 'busy' as const, runningCommands: ['python'] }] }))
    const match = vi.fn(() => true)
    service.registerTerminalProvider({ id: 'remote', match, createTransport: () => undefined,
      createWorkspaceSource: () => ({ list, create: vi.fn(), terminate: vi.fn(), createTransport: vi.fn() }),
    })
    expect(await service.getWorkspaceTerminalSummary({ sessionId: 'A', cwd: '/remote' })).toMatchObject({ total: 1, busy: 1, runningCommands: [{ name: 'python', count: 1 }] })
    expect(match).toHaveBeenCalledWith('A', '/remote', 'terminal:workspace-management')
    expect(local).not.toHaveBeenCalled()
    list.mockRejectedValueOnce(new Error('disconnected'))
    await expect(service.getWorkspaceTerminalSummary({ sessionId: 'A' })).rejects.toThrow('disconnected')
    expect(local).not.toHaveBeenCalled()
  })
  it('fails closed for unavailable matched provider rather than reporting local counts', async () => {
    const service = fixture()
    const local = vi.spyOn(api, 'workspaceTerminalList')
    service.registerTerminalProvider({ id: 'legacy', match: () => true, createTransport: () => undefined })
    await expect(service.getWorkspaceTerminalSummary({ sessionId: 'A' })).rejects.toThrow('management unavailable')
    await expect(service.getWorkspaceTerminalSummary({ sessionId: '' })).rejects.toThrow('requires a session id')
    expect(local).not.toHaveBeenCalled()
  })
})
