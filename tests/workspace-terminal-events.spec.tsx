// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import type { WorkspaceTerminalSource } from '../src/client/terminal-source.ts'
import { api, type WorkspaceTerminalInfo } from '../src/client/api.ts'
import { WorkspaceTerminals } from '../src/client/WorkspaceTerminals.tsx'
import { resolveWorkspaceTerminalBinding } from '../src/client/workspace-terminals.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { t } from '../src/client/locales.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()
const info: WorkspaceTerminalInfo = { terminalId: 'one', title: 'Shell', cwd: '/work', createdBySessionId: 'A', createdAt: 1, exited: false }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear() })
function fixture() {
  const store = createSidebarStore(); store.setSession('A')
  const service = createBetterSidebarService(store)
  const listeners: Array<{ push: (value: { terminals: WorkspaceTerminalInfo[] }) => void; error?: (value: unknown) => void; off: ReturnType<typeof vi.fn> }> = []
  const list = vi.fn(async (_signal?: AbortSignal) => ({ terminals: [info] }))
  const subscribe = vi.fn<NonNullable<WorkspaceTerminalSource['subscribe']>>((push, error) => {
    const off = vi.fn(); listeners.push({ push, error, off }); return off
  })
  const source: WorkspaceTerminalSource = { create: async () => info, list, subscribe, terminate: vi.fn(async () => {}), createTransport: () => { throw Error('unused') } }
  const off = service.registerTerminalProvider({ id: 'remote', match: () => true, createTransport: () => undefined, createWorkspaceSource: () => source })
  return { store, service, source, list, subscribe, listeners, off, props: { sessionId: 'A', store, ctx: { betterSidebar: service } as Context } }
}
describe('workspace terminal pushed catalog', () => {
  it('opts the local backend into source-owned subscriptions', () => {
    expect(resolveWorkspaceTerminalBinding(undefined, 'A').source.subscribe).toBeTypeOf('function')
  })
  it('uses pushed snapshots without initial/periodic list and keeps subscription on manual refresh', async () => {
    vi.useFakeTimers()
    const f = fixture(); const root = renderRoot(createElement(WorkspaceTerminals, f.props))
    expect(f.subscribe).toHaveBeenCalledOnce(); expect(f.list).not.toHaveBeenCalled()
    act(() => f.listeners[0]!.push({ terminals: [info] }))
    expect(root.container.textContent).toContain('Shell')
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(f.list).not.toHaveBeenCalled()
    let finish!: (value: { terminals: WorkspaceTerminalInfo[] }) => void
    f.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    act(() => root.container.querySelector<HTMLButtonElement>(`button[title="${t('refresh')}"]`)!.click())
    expect(f.list).toHaveBeenCalledOnce(); expect(f.subscribe).toHaveBeenCalledOnce()
    act(() => f.listeners[0]!.push({ terminals: [{ ...info, title: 'Newest event' }] }))
    await act(async () => finish({ terminals: [{ ...info, title: 'Stale list' }] }))
    expect(root.container.textContent).toContain('Newest event'); expect(root.container.textContent).not.toContain('Stale list')
    root.unmount(); expect(f.listeners[0]!.off).toHaveBeenCalledOnce()
  })
  it('unsubscribes on tab/page hiding and session changes; ignores stale snapshots/errors', async () => {
    const f = fixture(); const root = renderRoot(createElement(WorkspaceTerminals, f.props))
    act(() => f.listeners[0]!.push({ terminals: [info] }))
    root.rerender(createElement(WorkspaceTerminals, { ...f.props, visible: false }))
    expect(f.listeners[0]!.off).toHaveBeenCalledOnce()
    act(() => { f.listeners[0]!.push({ terminals: [{ ...info, title: 'stale' }] }); f.listeners[0]!.error?.(Error('stale error')) })
    expect(f.store.getSessionStates().get('A')?.workspaceTerminalError).toBeUndefined()
    root.rerender(createElement(WorkspaceTerminals, f.props))
    expect(f.subscribe).toHaveBeenCalledTimes(2)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(f.listeners[1]!.off).toHaveBeenCalledOnce()
    hidden.mockReturnValue(false); act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(f.subscribe).toHaveBeenCalledTimes(3)
    act(() => f.store.setSession('B'))
    root.rerender(createElement(WorkspaceTerminals, { ...f.props, sessionId: 'B' }))
    expect(f.listeners[2]!.off).toHaveBeenCalledOnce()
    act(() => f.listeners[2]!.push({ terminals: [{ ...info, title: 'old session' }] }))
    expect(root.container.textContent).not.toContain('old session')
    act(() => f.listeners[3]!.push({ terminals: [{ ...info, title: 'B terminal' }] }))
    expect(root.container.textContent).toContain('B terminal')
    root.unmount()
  })
  it('formats pushed command lifecycle and refreshes management without resubscribing', async () => {
    const f = fixture(); const root = renderRoot(createElement(WorkspaceTerminals, f.props))
    const commandStartedAt = Date.parse('2026-10-16T09:00:00Z')
    act(() => f.listeners[0]!.push({ terminals: [{ ...info, commandStartedAt, commandFinishedAt: commandStartedAt + 1200, commandExitCode: 1, commandDurationMs: 1200 }] }))
    const status = root.container.querySelector('[title*="exit: 1"]')!
    expect(status.getAttribute('title')).toContain('1.2 s')
    expect(status.getAttribute('title')).toContain(new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(commandStartedAt)))
    expect(status.getAttribute('title')).not.toContain(String(commandStartedAt))
    act(() => root.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    await act(async () => root.container.querySelector<HTMLButtonElement>('[role="group"] button')!.click())
    expect(f.source.terminate).toHaveBeenCalledWith('one')
    expect(f.list).toHaveBeenCalledOnce(); expect(f.subscribe).toHaveBeenCalledOnce()
    root.unmount()
  })
  it('explicit refresh restarts a refused subscription instead of leaving a dead stream', async () => {
    const f = fixture(); const root = renderRoot(createElement(WorkspaceTerminals, f.props))
    act(() => f.listeners[0]!.error?.(Object.assign(new Error('denied'), { code: 'FORBIDDEN', retryable: false })))
    await act(async () => root.container.querySelector<HTMLButtonElement>(`button[title="${t('refresh')}"]`)!.click())
    expect(f.listeners[0]!.off).toHaveBeenCalledOnce()
    expect(f.subscribe).toHaveBeenCalledTimes(2)
    expect(f.list).not.toHaveBeenCalled()
    act(() => f.listeners[1]!.push({ terminals: [info] }))
    expect(root.container.textContent).toContain('Shell')
    root.unmount()
  })
  it('pauses denied legacy polling until an explicit refresh', async () => {
    vi.useFakeTimers()
    const f = fixture()
    delete f.source.subscribe
    f.list.mockRejectedValue(Object.assign(new Error('Remote terminal access denied'), { code: 'FORBIDDEN', status: 403, retryable: false }))
    const root = renderRoot(createElement(WorkspaceTerminals, f.props))
    await act(async () => {})
    expect(f.list).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(f.list).toHaveBeenCalledTimes(1)
    f.list.mockResolvedValue({ terminals: [info] })
    await act(async () => root.container.querySelector<HTMLButtonElement>(`button[title="${t('refresh')}"]`)!.click())
    expect(f.list).toHaveBeenCalledTimes(2)
    expect(root.container.textContent).toContain('Shell')
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(f.list).toHaveBeenCalledTimes(3)
    root.unmount()
  })
  it('disposes a removed backend instead of silently switching to local and rejects its late events', () => {
    const f = fixture(); const local = vi.spyOn(api, 'workspaceTerminalList')
    const root = renderRoot(createElement(WorkspaceTerminals, f.props))
    act(() => f.listeners[0]!.push({ terminals: [info] }))
    act(() => f.off())
    expect(f.listeners[0]!.off).toHaveBeenCalledOnce()
    act(() => f.listeners[0]!.push({ terminals: [{ ...info, title: 'late' }] }))
    expect(root.container.textContent).not.toContain('late'); expect(local).not.toHaveBeenCalled()
    root.unmount()
  })
})
