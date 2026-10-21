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
function mount(terminalId?: string, tabId = 'workspace-view:terminal:abc', visible = false) {
  const store = createSidebarStore(); store.setSession('B')
  store.reduce(state => openTabInBottomPane(state, { id: tabId, type: 'terminal', title: 'shell', meta: terminalId === undefined ? undefined : { workspaceTerminalId: terminalId } }))
  if (visible) store.reduce(state => ({ ...state, bottomOpen: true }))
  function Harness() {
    useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
    const tab = tabs(store).find(tab => tab.id === tabId)
    return tab === undefined ? null : createElement(TerminalView, { ctx: {} as Context,
      scope: { sessionId: 'B', cwd: '/work' }, tabId, terminalId: workspaceTerminalIdOf(tab), store, visible: visible && store.getSnapshot().state!.bottomOpen })
  }
  const rendered = renderRoot(createElement(Harness))
  return { ...rendered, store, tabId, socket: Socket.instances[0]! }
}
function mountExternal(supportsRetry = true) {
  const store = createSidebarStore(); store.setSession('B')
  const tabId = 'external-view'
  store.reduce(state => openTabInBottomPane(state, { id: tabId, type: 'terminal', title: 'remote',
    meta: { workspaceTerminalId: 'remote-old', workspaceTerminalProviderId: 'remote' } }))
  const handle = { input: vi.fn(), resize: vi.fn(), close: vi.fn(), park: vi.fn(), dispose: vi.fn(), retry: vi.fn() }
  const sessions: import('../src/client/terminal-transport.ts').TerminalTransportSession[] = []
  const { retry: _retry, ...handleWithoutRetry } = handle
  const transport = { kind: 'remote-managed', open: vi.fn((session: typeof sessions[number]) => {
    sessions.push(session)
    return supportsRetry ? handle : handleWithoutRetry
  }) }
  const source = { create: vi.fn(async () => replacement), list: vi.fn(async () => ({ terminals: [] })),
    terminate: vi.fn(async () => ({})), createTransport: vi.fn(() => transport) }
  const localCreate = vi.spyOn(api, 'workspaceTerminalCreate')
  const element = (terminalId = 'remote-old') => createElement(TerminalView, { ctx: {} as Context, scope: { sessionId: 'B' },
    store, tabId, terminalId, visible: true, transport, workspaceBinding: { providerId: 'remote', source } })
  const root = renderRoot(element())
  return { ...root, store, handle, transport, source, localCreate, sessions, session: sessions[0]!, element }
}
describe('workspace terminal view lifetime', () => {
  it('shows structured attach state, clears the banner when connected, and retries the same handle', async () => {
    const view = mountExternal()
    act(() => view.session.onState?.({ phase: 'connecting', intent: 'attach-existing' }))
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(t('terminalViewAttaching'))
    expect(view.container.querySelector('button')).toBeNull()
    act(() => view.session.onState?.({ phase: 'connected', intent: 'attach-existing' }))
    expect(view.container.querySelector('[role="status"]')).toBeNull()
    expect(view.container.textContent).not.toContain(t('terminalViewAttaching'))
    act(() => view.session.onState?.({ phase: 'disconnected', intent: 'attach-existing' }))
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain(t('terminalViewDisconnected'))
    expect(view.container.querySelector('button')?.textContent).toBe(t('terminalViewReconnect'))
    act(() => view.container.querySelector<HTMLButtonElement>('button')!.click())
    expect(view.handle.retry).toHaveBeenCalledOnce()
    // A retry click alone is not evidence that a new connection attempt began.
    expect(view.container.textContent).toContain(t('terminalViewDisconnected'))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(view.transport.open).toHaveBeenCalledOnce()
    expect(view.source.createTransport).not.toHaveBeenCalled()
    expect(view.source.create).not.toHaveBeenCalled()
    expect(view.localCreate).not.toHaveBeenCalled()
    expect(Socket.instances).toHaveLength(0)
    expect(view.session.terminalId).toBe('remote-old')
    act(() => view.session.onState?.({ phase: 'connecting', intent: 'attach-existing' }))
    expect(view.container.textContent).toContain(t('terminalViewAttaching'))
    act(() => view.session.onState?.({ phase: 'connected' }))
    expect(view.container.querySelector('[role="status"]')).toBeNull()
    view.unmount()
  })
  it('offers no reconnect action when the external handle does not support retry', () => {
    const view = mountExternal(false)
    expect(view.transport.open.mock.results[0]!.value).not.toHaveProperty('retry')
    act(() => view.session.onState?.({ phase: 'disconnected', intent: 'attach-existing' }))
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(t('terminalViewDisconnected'))
    expect(view.container.querySelector('button')).toBeNull()
    expect(view.transport.open).toHaveBeenCalledOnce()
    expect(view.source.create).not.toHaveBeenCalled()
    expect(view.localCreate).not.toHaveBeenCalled()
    view.unmount()
  })
  it('shows creating only when the external transport explicitly reports create intent', () => {
    const view = mountExternal()
    act(() => view.session.onState?.({ phase: 'connecting', intent: 'create' }))
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(t('terminalViewCreating'))
    expect(view.container.textContent).not.toContain(t('terminalViewAttaching'))
    expect(view.container.querySelector('button')).toBeNull()
    expect(view.source.create).not.toHaveBeenCalled()
    expect(view.localCreate).not.toHaveBeenCalled()
    view.unmount()
  })
  it('supports legacy onConnected(false) as disconnected with same-handle retry', () => {
    const view = mountExternal()
    act(() => view.session.onConnected?.(true))
    expect(view.container.querySelector('[role="status"]')).toBeNull()
    act(() => view.session.onConnected?.(false))
    expect(view.container.textContent).toContain(t('terminalViewDisconnected'))
    expect(view.container.querySelector('button')?.textContent).toBe(t('terminalViewReconnect'))
    act(() => view.container.querySelector<HTMLButtonElement>('button')!.click())
    expect(view.handle.retry).toHaveBeenCalledOnce()
    expect(view.transport.open).toHaveBeenCalledOnce()
    expect(view.source.create).not.toHaveBeenCalled()
    expect(view.localCreate).not.toHaveBeenCalled()
    act(() => view.session.onConnected?.(true))
    expect(view.container.querySelector('[role="status"]')).toBeNull()
    view.unmount()
  })
  it('treats structured state as authoritative over later legacy callbacks', () => {
    const view = mountExternal()
    act(() => { view.session.onState?.({ phase: 'connecting', intent: 'attach-existing' }); view.session.onConnected?.(true) })
    expect(view.container.textContent).toContain(t('terminalViewAttaching'))
    act(() => { view.session.onState?.({ phase: 'connected' }); view.session.onConnected?.(false) })
    expect(view.container.querySelector('[role="status"]')).toBeNull()
    act(() => { view.session.onState?.({ phase: 'disconnected' }); view.session.onConnected?.(true) })
    expect(view.container.textContent).toContain(t('terminalViewDisconnected'))
    expect(view.transport.open).toHaveBeenCalledOnce()
    expect(view.source.create).not.toHaveBeenCalled()
    view.unmount()
  })
  it('shows confirmed access denial without reconnect or start-new actions', async () => {
    const view = mountExternal()
    act(() => view.session.onAccessDenied?.('workspace-mismatch'))
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(t('terminalViewForbidden'))
    expect(view.container.textContent).toContain('workspace-mismatch')
    expect(view.container.querySelector('button')).toBeNull()
    act(() => {
      view.session.onState?.({ phase: 'connected' }); view.session.onConnected?.(true)
      view.session.onClosed?.('missing'); view.session.onFatal?.('late failure')
    })
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(view.container.textContent).toContain(t('terminalViewForbidden'))
    expect(view.container.textContent).not.toContain(t('terminalViewMissing'))
    expect(view.container.querySelector('button')).toBeNull()
    expect(view.handle.retry).not.toHaveBeenCalled()
    expect(view.transport.open).toHaveBeenCalledOnce()
    expect(view.source.create).not.toHaveBeenCalled()
    expect(view.localCreate).not.toHaveBeenCalled()
    view.unmount()
  })
  it('ignores callbacks from a disposed transport after a new terminal identity mounts', () => {
    const view = mountExternal()
    const previous = view.session
    const oldTerm = xterms.instances[0]!
    view.rerender(view.element('remote-new'))
    expect(view.handle.dispose).toHaveBeenCalledOnce()
    const current = view.sessions[1]!
    act(() => current.onState?.({ phase: 'connected' }))
    act(() => {
      previous.onOutput('stale output'); previous.term.write('stale direct write')
      previous.onState?.({ phase: 'disconnected' }); previous.onConnected?.(false)
      previous.onEndpoint?.('stale-endpoint'); previous.onFatal?.('stale-failure')
      previous.onClosed?.('missing'); previous.onAccessDenied?.('stale-denial')
    })
    expect(oldTerm.dispose).toHaveBeenCalledOnce()
    expect(oldTerm.write).not.toHaveBeenCalled()
    expect(xterms.instances[1]!.write).not.toHaveBeenCalled()
    expect(view.container.querySelector('[role="status"]')).toBeNull()
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(view.container.querySelector('button')).toBeNull()
    expect(view.container.textContent).not.toMatch(/stale-/)
    expect(view.transport.open).toHaveBeenCalledTimes(2)
    expect(view.source.create).not.toHaveBeenCalled()
    expect(view.localCreate).not.toHaveBeenCalled()
    view.unmount()
  })
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
    expect(root.container.textContent).toContain(t('terminalViewExited'))
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
  it('never replaces a visible remote managed terminal without an explicit click', async () => {
    const store = createSidebarStore(); store.setSession('B')
    const tabId = 'remote-view'
    store.reduce(state => openTabInBottomPane(state, { id: tabId, type: 'terminal', title: 'remote',
      meta: { workspaceTerminalId: 'remote-old', workspaceTerminalProviderId: 'remote' } }))
    let session!: import('../src/client/terminal-transport.ts').TerminalTransportSession
    const transport = { kind: 'remote-managed', open: vi.fn((value: typeof session) => {
      session = value
      return { input: vi.fn(), resize: vi.fn(), close: vi.fn(), park: vi.fn(), dispose: vi.fn() }
    }) }
    const source = { create: vi.fn(async () => ({ ...replacement, terminalId: 'remote-new' })),
      list: vi.fn(async () => ({ terminals: [] })), terminate: vi.fn(async () => ({})), createTransport: () => transport }
    const local = vi.spyOn(api, 'workspaceTerminalCreate')
    const view = renderRoot(createElement(TerminalView, { ctx: {} as Context, scope: { sessionId: 'B' },
      store, tabId, terminalId: 'remote-old', visible: true, transport, workspaceBinding: { providerId: 'remote', source } }))
    await act(async () => { session.onClosed?.('missing') })
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(source.create).not.toHaveBeenCalled()
    expect(local).not.toHaveBeenCalled()
    expect(transport.open).toHaveBeenCalledOnce()
    expect(tabs(store)[0]!.meta).toMatchObject({ workspaceTerminalId: 'remote-old', workspaceTerminalProviderId: 'remote' })
    expect(view.container.textContent).toContain(t('terminalViewMissing'))
    expect(view.container.querySelector('button')?.textContent).toBe(t('terminalViewStartNew'))
    await act(async () => { view.container.querySelector<HTMLButtonElement>('button')!.click() })
    expect(source.create).toHaveBeenCalledOnce()
    expect(local).not.toHaveBeenCalled()
    expect(tabs(store)[0]!.meta).toMatchObject({ workspaceTerminalId: 'remote-new', workspaceTerminalProviderId: 'remote' })
    view.unmount()
  })
  it('does not auto-create a replacement for an uncertain remote transport failure', async () => {
    const store = createSidebarStore(); store.setSession('B')
    const tabId = 'uncertain-remote'
    store.reduce(state => openTabInBottomPane(state, { id: tabId, type: 'terminal', title: 'remote',
      meta: { workspaceTerminalId: 'remote-old', workspaceTerminalProviderId: 'remote' } }))
    let session!: import('../src/client/terminal-transport.ts').TerminalTransportSession
    const transport = { kind: 'remote-managed', open: vi.fn((value: typeof session) => {
      session = value
      return { input: vi.fn(() => false), resize: vi.fn(), close: vi.fn(), park: vi.fn(), dispose: vi.fn() }
    }) }
    const source = { create: vi.fn(async () => replacement), list: vi.fn(async () => ({ terminals: [] })),
      terminate: vi.fn(async () => ({})), createTransport: () => transport }
    const view = renderRoot(createElement(TerminalView, { ctx: {} as Context, scope: { sessionId: 'B' },
      store, tabId, terminalId: 'remote-old', visible: true, transport, workspaceBinding: { providerId: 'remote', source } }))
    act(() => { session.onConnected?.(false); session.onFatal?.('TRANSPORT_UNCERTAIN: remote process status unknown') })
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(source.create).not.toHaveBeenCalled()
    expect(tabs(store)[0]!.meta).toMatchObject({ workspaceTerminalId: 'remote-old' })
    expect(view.container.textContent).toContain('TRANSPORT_UNCERTAIN')
    view.unmount()
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
    expect(view.container.textContent).toContain(reason === 'terminal-exited' ? t('terminalViewExited') : reason === 'terminal-terminated' ? t('terminalViewTerminated') : t('terminalViewForbidden'))
    act(() => view.root.unmount())
  })
  it.each([[1000, 'terminal-terminated', 'terminalViewTerminated'], [1000, 'terminal-exited', 'terminalViewExited'], [1008, 'terminal-not-found', 'terminalViewMissing']] as const)('explicitly restarts %s %s into the same tab with a new socket', async (code, reason, key) => {
    const create = vi.spyOn(api, 'workspaceTerminalCreate').mockResolvedValue(replacement)
    const view = mount('terminal:abc')
    act(() => { view.socket.onmessage?.({ data: 'old history' }); view.socket.onclose?.({ code, reason }) })
    expect(xterms.instances[0]!.write).toHaveBeenCalledWith('old history')
    expect(view.container.textContent).toContain(t(key))
    expect(view.container.querySelector('button')?.textContent).toBe(t('terminalViewStartNew'))
    expect(create).not.toHaveBeenCalled()
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
    expect(view.container.textContent).toContain(t('terminalViewTerminated'))
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
    expect(view.container.textContent).toContain(t('terminalViewTerminated'))
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
    expect(view.container.textContent).toContain(t('terminalViewForbidden'))
    expect(view.container.querySelector('button')).toBeNull()
    act(() => view.root.unmount())
  })
  it.each([[1000, 'terminal-exited', 'terminalViewExited'], [1000, 'terminal-terminated', 'terminalViewTerminated'], [1008, 'terminal-not-found', 'terminalViewMissing']] as const)('never replaces a visible settled terminal (%s %s)', async (code, reason, key) => {
    const create = vi.spyOn(api, 'workspaceTerminalCreate').mockResolvedValue(replacement)
    const view = mount('terminal:abc', undefined, true)
    await act(async () => { view.socket.onclose?.({ code, reason }); vi.advanceTimersByTime(60_000) })
    expect(create).not.toHaveBeenCalled()
    expect(Socket.instances).toHaveLength(1)
    expect(tabs(view.store)).toHaveLength(1)
    expect(workspaceTerminalIdOf(tabs(view.store)[0]!)).toBe('terminal:abc')
    expect(view.container.textContent).toContain(t(key))
    expect(view.container.querySelector('button')?.textContent).toBe(t('terminalViewStartNew'))
    act(() => view.root.unmount())
  })
  it('never replaces a hidden closed view on activation or reactivation, but permits an explicit click', async () => {
    const create = vi.spyOn(api, 'workspaceTerminalCreate').mockResolvedValue(replacement)
    const view = mount('terminal:abc', undefined, true)
    act(() => view.store.reduce(state => ({ ...state, bottomOpen: false })))
    await act(async () => { view.socket.onclose?.({ code: 1008, reason: 'terminal-not-found' }) })
    for (let activation = 0; activation < 2; activation++) {
      await act(async () => { view.store.reduce(state => ({ ...state, bottomOpen: true })); vi.advanceTimersByTime(60_000) })
      expect(create).not.toHaveBeenCalled()
      expect(Socket.instances).toHaveLength(1)
      expect(workspaceTerminalIdOf(tabs(view.store)[0]!)).toBe('terminal:abc')
      expect(view.container.textContent).toContain(t('terminalViewMissing'))
      act(() => view.store.reduce(state => ({ ...state, bottomOpen: false })))
    }
    await act(async () => { view.container.querySelector<HTMLButtonElement>('button')!.click() })
    expect(create).toHaveBeenCalledExactlyOnceWith('B')
    expect(workspaceTerminalIdOf(tabs(view.store)[0]!)).toBe(replacement.terminalId)
    act(() => view.root.unmount())
  })
  it.each([[1000, 'terminal-terminated'], [1008, 'workspace-mismatch'], [1006, 'network']] as const)('does not auto-restart visible terminated, refused or disconnected views (%s %s)', async (code, reason) => {
    const create = vi.spyOn(api, 'workspaceTerminalCreate')
    const view = mount('terminal:abc', undefined, true)
    await act(async () => { view.socket.onclose?.({ code, reason }) })
    expect(create).not.toHaveBeenCalled()
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
