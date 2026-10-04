// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useSyncExternalStore } from 'react'
import { api, type WorkspaceTerminalInfo } from '../src/client/api.ts'
import { workspaceTerminalIdOf } from '../src/client/workspace-terminals.ts'
import { t } from '../src/client/locales.ts'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { createSidebarStore, openTabInBottomPane, closeTab, allLeaves } from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'
const xterms = vi.hoisted(() => ({ instances: [] as { write: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  constructor() { xterms.instances.push(this) }
  cols = 80; rows = 24; buffer = { active: { length: 0 } }; options = {}
  loadAddon() {} registerLinkProvider() { return { dispose() {} } }
  onData() { return { dispose() {} } } write = vi.fn(); dispose = vi.fn(); refresh() {}
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('../src/client/open-when-sized.ts', () => ({ openWhenSized: () => () => {} }))
vi.mock('../src/client/theme.ts', () => ({ isDarkScheme: () => false, effectiveTokenValue: () => '', tokenValue: () => '', subscribeColorScheme: () => () => {} }))
vi.mock('../src/client/TerminalBlockOverlay.tsx', () => ({ TerminalBlockOverlay: () => null }))
import { TerminalView } from '../src/client/TerminalView.tsx'
setupReactAct()
class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1; onopen?: () => void; onmessage?: (event: { data: string }) => void
  onclose?: (event: { code: number; reason: string }) => void; onerror?: () => void
  send = vi.fn(); close = vi.fn()
  constructor(readonly url: string) { Socket.instances.push(this) }
}
beforeEach(() => {
  Socket.instances = []; xterms.instances = []; vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren() })
const replacement: WorkspaceTerminalInfo = { terminalId: 'terminal:new', title: 'new shell', cwd: '/authoritative', createdAt: 2, createdBySessionId: 'B', exited: false }
const tabs = (store: ReturnType<typeof createSidebarStore>) => allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
function mount(terminalId?: string, tabId = 'workspace-view:terminal:abc') {
  const store = createSidebarStore(); store.setSession('B')
  store.reduce(state => openTabInBottomPane(state, { id: tabId, type: 'terminal', title: 'shell', meta: terminalId === undefined ? undefined : { workspaceTerminalId: terminalId } }))
  function Harness() {
    useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
    const tab = tabs(store).find(tab => tab.id === tabId)
    return tab === undefined ? null : createElement(TerminalView, { ctx: {} as Context,
      scope: { sessionId: 'B', cwd: '/work' }, tabId, terminalId: workspaceTerminalIdOf(tab), store })
  }
  const rendered = renderRoot(createElement(Harness))
  return { ...rendered, store, tabId, socket: Socket.instances[0]! }
}
describe('workspace terminal view lifetime', () => {
  it('managed remote views only dispose on tab close and expose remote restart on settled callbacks', async () => {
    const store = createSidebarStore(); store.setSession('B')
    const tabId = 'workspace-view:remote:term-old'
    store.reduce(state => openTabInBottomPane(state, { id: tabId, type: 'terminal', title: 'remote',
      meta: { workspaceTerminalId: 'term-old', workspaceTerminalProviderId: 'remote' } }))
    const handle = { input: vi.fn(), resize: vi.fn(), close: vi.fn(), park: vi.fn(), dispose: vi.fn() }
    let session!: import('../src/client/terminal-transport.ts').TerminalTransportSession
    const transport = { kind: 'remote-managed', open: vi.fn((value: typeof session) => { session = value; return handle }) }
    const source = { create: vi.fn(async () => ({ ...replacement, terminalId: 'term-new' })),
      list: vi.fn(async () => ({ terminals: [] })), terminate: vi.fn(async () => ({})), createTransport: () => transport }
    const local = vi.spyOn(api, 'workspaceTerminalCreate')
    const root = renderRoot(createElement(TerminalView, { ctx: {} as Context, scope: { sessionId: 'B' },
      store, tabId, terminalId: 'term-old', transport, workspaceBinding: { providerId: 'remote', source } }))
    expect(Socket.instances).toHaveLength(0)
    expect(session.terminalId).toBe('term-old')
    act(() => session.onClosed?.('exited'))
    expect(root.container.textContent).toContain(t('workspaceTerminalExited'))
    await act(async () => { root.container.querySelector<HTMLButtonElement>('button')!.click() })
    expect(source.create).toHaveBeenCalledOnce()
    expect(local).not.toHaveBeenCalled()
    expect(tabs(store)[0]!.meta).toMatchObject({ workspaceTerminalId: 'term-new', workspaceTerminalProviderId: 'remote' })
    act(() => store.reduce(state => closeTab(state, allLeaves(state.bottomSplits)[0]!.id, tabId)))
    root.unmount()
    expect(handle.dispose).toHaveBeenCalledOnce()
    expect(handle.close).not.toHaveBeenCalled(); expect(handle.park).not.toHaveBeenCalled()
    expect(source.terminate).not.toHaveBeenCalled()
  })
  it('attaches with viewer and terminalId, never legacy tab/cwd, and tab close only detaches', () => {
    const view = mount('terminal:abc')
    const url = new URL(view.socket.url)
    expect(url.searchParams.get('sessionId')).toBe('B'); expect(url.searchParams.get('terminalId')).toBe('terminal:abc')
    expect(url.searchParams.has('tab')).toBe(false); expect(url.searchParams.has('cwd')).toBe(false)
    act(() => view.store.reduce(state => closeTab(state, allLeaves(state.bottomSplits)[0]!.id, view.tabId)))
    act(() => view.root.unmount())
    expect(view.socket.send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'close' })); expect(view.socket.send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'park' })); expect(view.socket.close).toHaveBeenCalled()
  })
  it.each([[1000, 'terminal-exited'], [1000, 'terminal-terminated'], [1000, 'terminal-detached'], [1000, 'workspace-detached'], [1008, 'workspace-mismatch']])('stops automatic reconnect for settled close %s %s', (code, reason) => {
    const view = mount('terminal:abc')
    act(() => view.socket.onclose?.({ code: code as number, reason: reason as string }))
    act(() => vi.advanceTimersByTime(10000))
    expect(Socket.instances).toHaveLength(1)
    expect(view.container.textContent).toContain(reason === 'terminal-exited' ? t('workspaceTerminalExited') : reason === 'terminal-terminated' ? t('workspaceTerminalTerminated') : reason)
    act(() => view.root.unmount())
  })
  it.each([[1000, 'terminal-terminated', 'workspaceTerminalTerminated'], [1000, 'terminal-exited', 'workspaceTerminalExited'], [1008, 'terminal-not-found', 'workspaceTerminalUnavailable']] as const)('explicitly restarts %s %s into the same tab with a new socket', async (code, reason, key) => {
    const create = vi.spyOn(api, 'workspaceTerminalCreate').mockResolvedValue(replacement)
    const view = mount('terminal:abc')
    act(() => { view.socket.onmessage?.({ data: 'old history' }); view.socket.onclose?.({ code, reason }) })
    expect(xterms.instances[0]!.write).toHaveBeenCalledWith('old history')
    expect(view.container.textContent).toContain(t(key))
    await act(async () => { view.container.querySelector<HTMLButtonElement>('button')!.click() })
    expect(create).toHaveBeenCalledExactlyOnceWith('B')
    expect(tabs(view.store)).toHaveLength(1)
    expect(tabs(view.store)[0]).toMatchObject({ id: view.tabId, title: replacement.title, meta: { workspaceTerminalId: replacement.terminalId } })
    expect(Socket.instances).toHaveLength(2)
    expect(xterms.instances).toHaveLength(2)
    expect(xterms.instances[0]!.dispose).toHaveBeenCalled()
    expect(xterms.instances[1]!.write).not.toHaveBeenCalled()
    expect(new URL(Socket.instances[1]!.url).searchParams.get('terminalId')).toBe(replacement.terminalId)
    expect(view.container.textContent).not.toContain(t(key))
    act(() => view.root.unmount())
  })
  it('preserves the closed reason on failure and permits a second attempt', async () => {
    const create = vi.spyOn(api, 'workspaceTerminalCreate').mockRejectedValueOnce(new Error('quota')).mockResolvedValueOnce(replacement)
    const view = mount('terminal:abc')
    act(() => view.socket.onclose?.({ code: 1000, reason: 'terminal-terminated' }))
    await act(async () => { view.container.querySelector<HTMLButtonElement>('button')!.click() })
    expect(view.container.textContent).toContain(t('workspaceTerminalTerminated'))
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('quota')
    expect(view.container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
    await act(async () => { view.container.querySelector<HTMLButtonElement>('button')!.click() })
    expect(create).toHaveBeenCalledTimes(2)
    expect(view.store.getSnapshot().state!.workspaceTerminalError).toBeUndefined()
    act(() => view.root.unmount())
  })
  it.each([false, true])('guards pending clicks and delayed create after session switch (closed=%s)', async closed => {
    let resolve!: (value: WorkspaceTerminalInfo) => void
    const create = vi.spyOn(api, 'workspaceTerminalCreate').mockImplementation(() => new Promise(done => { resolve = done }))
    const terminate = vi.spyOn(api, 'workspaceTerminalTerminate').mockResolvedValue({ ok: true })
    const view = mount('terminal:abc')
    act(() => view.socket.onclose?.({ code: 1000, reason: 'terminal-terminated' }))
    const button = view.container.querySelector<HTMLButtonElement>('button')!
    act(() => { button.click(); button.click() })
    expect(create).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    expect(view.container.textContent).toContain(t('workspaceTerminalTerminated'))
    act(() => {
      if (closed) view.store.reduce(state => closeTab(state, allLeaves(state.bottomSplits)[0]!.id, view.tabId))
      view.store.setSession('C')
    })
    await act(async () => { resolve(replacement) })
    expect(tabs(view.store)).toHaveLength(0)
    const sourceTabs = allLeaves(view.store.getSessionStates().get('B')!.bottomSplits).flatMap(leaf => leaf.tabs)
    if (closed) { expect(sourceTabs).toHaveLength(0); expect(terminate).toHaveBeenCalledExactlyOnceWith('B', replacement.terminalId) }
    else { expect(sourceTabs[0]!.meta).toMatchObject({ workspaceTerminalId: replacement.terminalId }); expect(terminate).not.toHaveBeenCalled() }
    act(() => view.root.unmount())
  })
  it('does not offer replacement for a workspace permission refusal', () => {
    const view = mount('terminal:abc')
    act(() => view.socket.onclose?.({ code: 1008, reason: 'workspace-mismatch' }))
    expect(view.container.textContent).not.toContain(t('workspaceTerminalRestart'))
    act(() => view.root.unmount())
  })
  it('preserves legacy and agent close-frame semantics', () => {
    for (const tabId of ['terminal:old', 'agent:uuid']) {
      const view = mount(undefined, tabId)
      act(() => view.store.reduce(state => closeTab(state, allLeaves(state.bottomSplits)[0]!.id, tabId)))
      act(() => view.root.unmount())
      expect(view.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'close' }))
    }
  })
})
