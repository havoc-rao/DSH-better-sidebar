// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type WorkspaceTerminalInfo } from '../src/client/api.ts'
import { createBetterSidebarService, SIDEBAR_FEATURES } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { TerminalProviderDescriptor, WorkspaceTerminalSource } from '../src/client/terminal-source.ts'

const info: WorkspaceTerminalInfo = { terminalId: 'one', title: 'shell', cwd: '/work', createdBySessionId: 'A', createdAt: 1, exited: false, activity: 'busy', runningCommands: ['node', 'node', '/secret'] }
const services: ReturnType<typeof createBetterSidebarService>[] = []
function fixture() {
  const service = createBetterSidebarService(createSidebarStore(), undefined, () => '/work')
  services.push(service)
  return service
}
function events() {
  let snapshot!: (value: { terminals: WorkspaceTerminalInfo[] }) => void
  let error!: (value: unknown) => void
  const off = vi.fn()
  const source: WorkspaceTerminalSource = {
    list: vi.fn(), create: vi.fn(), terminate: vi.fn(), createTransport: vi.fn(),
    subscribe: vi.fn((onSnapshot, onError) => { snapshot = onSnapshot; error = onError!; return off }),
  }
  const provider: TerminalProviderDescriptor = { id: 'remote', match: () => true, createTransport: () => undefined, createWorkspaceSource: vi.fn(() => source) }
  return { source, provider, off, emit: (terminals = [info]) => snapshot({ terminals }), fail: (value: unknown) => error(value) }
}
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers(); vi.restoreAllMocks() })
describe('shared workspace terminal summary subscriptions', () => {
  it('shares event catalogs, replays latest, isolates listeners and releases the last reference', async () => {
    vi.useFakeTimers()
    const service = fixture(), event = events()
    service.registerTerminalProvider(event.provider)
    const first = vi.fn(), second = vi.fn(), error = vi.fn()
    const offA = service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, first, error)
    event.emit([info, info])
    const offB = service.subscribeWorkspaceTerminalSummary({ sessionId: 'A', cwd: '/work' }, second)
    expect(second).toHaveBeenCalledWith({ total: 1, busy: 1, idle: 0, unknown: 0, exited: 0, runningCommands: [{ name: 'node', count: 1 }] })
    expect(event.source.subscribe).toHaveBeenCalledTimes(1)
    expect(event.provider.createWorkspaceSource).toHaveBeenCalledTimes(1)
    expect(SIDEBAR_FEATURES).toContain('workspaceTerminalSummarySubscription')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(event.source.list).not.toHaveBeenCalled()
    const logging = vi.spyOn(console, 'error').mockImplementation(() => {})
    const offThrow = service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, () => { throw new Error('listener') })
    event.emit([])
    expect(first).toHaveBeenLastCalledWith({ total: 0, busy: 0, idle: 0, unknown: 0, exited: 0 })
    expect(logging).toHaveBeenCalled()
    event.fail(new Error('offline'))
    expect(error).toHaveBeenCalledTimes(1)
    const late = vi.fn(), lateError = vi.fn()
    const offLate = service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, late, lateError)
    expect(late).not.toHaveBeenCalled()
    expect(lateError).toHaveBeenCalledTimes(1)
    offA(); offB(); offThrow()
    expect(event.off).not.toHaveBeenCalled()
    offLate(); offLate()
    expect(event.off).toHaveBeenCalledTimes(1)
    event.emit()
    expect(late).not.toHaveBeenCalled()
  })
  it('never shares distinct session authorization or cwd identities', () => {
    const service = fixture(), event = events()
    service.registerTerminalProvider(event.provider)
    service.subscribeWorkspaceTerminalSummary({ sessionId: 'A', cwd: '/same' }, vi.fn())
    service.subscribeWorkspaceTerminalSummary({ sessionId: 'B', cwd: '/same' }, vi.fn())
    service.subscribeWorkspaceTerminalSummary({ sessionId: 'A', cwd: '/other' }, vi.fn())
    expect(event.source.subscribe).toHaveBeenCalledTimes(3)
    service.dispose()
    expect(event.off).toHaveBeenCalledTimes(3)
  })
  it('polls legacy sources once per shared key, without overlap, and aborts pending results', async () => {
    vi.useFakeTimers()
    const service = fixture(), event = events()
    delete event.source.subscribe
    let resolve!: (value: { terminals: WorkspaceTerminalInfo[] }) => void
    const list = vi.mocked(event.source.list).mockImplementation(() => new Promise(done => { resolve = done }))
    service.registerTerminalProvider(event.provider)
    const receive = vi.fn()
    const offA = service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, receive)
    const offB = service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, vi.fn())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(list).toHaveBeenCalledTimes(1)
    resolve({ terminals: [info] })
    await vi.advanceTimersByTimeAsync(0)
    expect(receive).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9999)
    expect(list).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(list).toHaveBeenCalledTimes(2)
    const signal = list.mock.calls[1]![0]!
    offA(); offB()
    expect(signal.aborted).toBe(true)
    resolve({ terminals: [] })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(2)
  })
  it.each([{ status: 401 }, { status: 403 }, { code: 'FORBIDDEN' }, { retryable: false }])('stops legacy polling on structured policy error %j until registry change', async failure => {
    vi.useFakeTimers()
    const service = fixture(), event = events()
    delete event.source.subscribe
    const list = vi.mocked(event.source.list).mockRejectedValue(failure)
    service.registerTerminalProvider(event.provider)
    const receive = vi.fn(), error = vi.fn()
    service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, receive, error)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(list).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(failure)
    expect(receive).not.toHaveBeenCalled()
    service.registerTerminalProvider({ id: 'other', match: () => false, createTransport: () => undefined })
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(2)
  })
  it('retries transient legacy errors and permits a fresh subscription after policy failure', async () => {
    vi.useFakeTimers()
    const service = fixture(), event = events()
    delete event.source.subscribe
    const list = vi.mocked(event.source.list).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce({ status: 403 }).mockResolvedValue({ terminals: [] })
    service.registerTerminalProvider(event.provider)
    const off = service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(list).toHaveBeenCalledTimes(2)
    const receive = vi.fn(), error = vi.fn()
    const joinedOff = service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, receive, error)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(list).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith({ status: 403 })
    expect(receive).not.toHaveBeenCalled()
    off(); joinedOff()
    service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, receive, error)
    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(3)
    expect(receive).toHaveBeenCalledTimes(1)
  })
  it('fails closed on provider removal, ignores old frames, and recovers on replacement without duplicate streams', () => {
    const service = fixture(), old = events(), replacement = events()
    const local = vi.spyOn(api, 'workspaceTerminalList')
    const unregister = service.registerTerminalProvider(old.provider)
    const receive = vi.fn(), error = vi.fn()
    service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, receive, error)
    old.emit()
    service.registerTerminalProvider({ id: 'unrelated', match: () => false, createTransport: () => undefined })
    expect(old.source.subscribe).toHaveBeenCalledTimes(1)
    unregister()
    expect(old.off).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
    old.emit([])
    expect(receive).toHaveBeenCalledTimes(1)
    service.registerTerminalProvider(replacement.provider)
    replacement.emit([])
    expect(replacement.source.subscribe).toHaveBeenCalledTimes(1)
    expect(receive).toHaveBeenCalledTimes(2)
    expect(local).not.toHaveBeenCalled()
  })
  it('does not transfer an owned scope when its still-registered provider stops matching', () => {
    const service = fixture(), owner = events(), other = events()
    const match = vi.fn(() => true)
    owner.provider.match = match
    other.provider.id = 'other'
    service.registerTerminalProvider(owner.provider)
    const receive = vi.fn(), error = vi.fn()
    service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, receive, error)
    owner.emit()
    match.mockReturnValue(false)
    service.registerTerminalProvider(other.provider)
    expect(owner.off).toHaveBeenCalledTimes(1)
    expect(other.source.subscribe).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
    owner.emit([])
    expect(receive).toHaveBeenCalledTimes(1)
  })
  it('does not duplicate a source when a synchronous initial listener joins the same scope', () => {
    const service = fixture(), event = events()
    event.source.subscribe = vi.fn(onSnapshot => { onSnapshot({ terminals: [info] }); return event.off })
    service.registerTerminalProvider(event.provider)
    const second = vi.fn()
    service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, () => {
      service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, second)
    })
    expect(event.source.subscribe).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    service.dispose()
    expect(event.off).toHaveBeenCalledTimes(1)
  })
  it('handles registry mutation from synchronous initial delivery without leaking a stream', () => {
    const service = fixture(), event = events()
    let unregister!: () => void
    event.source.subscribe = vi.fn(onSnapshot => { onSnapshot({ terminals: [info] }); return event.off })
    unregister = service.registerTerminalProvider(event.provider)
    service.subscribeWorkspaceTerminalSummary({ sessionId: 'A' }, () => unregister(), vi.fn())
    expect(event.source.subscribe).toHaveBeenCalledTimes(1)
    expect(event.off).toHaveBeenCalledTimes(1)
    service.dispose()
    expect(event.off).toHaveBeenCalledTimes(1)
  })
})
