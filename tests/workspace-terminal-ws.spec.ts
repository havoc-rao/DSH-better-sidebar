import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'
const state = vi.hoisted(() => ({ spawn: vi.fn(), accepted: undefined as unknown }))
vi.mock('../src/pty-deps.ts', async original => ({ ...await original<object>(), loadNodePty: () => ({ spawn: state.spawn }) }))
vi.mock('ws', () => ({
  WebSocket: { OPEN: 1 },
  WebSocketServer: class { handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, cb: (ws: unknown) => void) { cb(state.accepted) } close() {} },
}))
import { apply } from '../src/index.ts'
class Socket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  send = vi.fn()
  close = vi.fn((code: number, reason: string) => { this.readyState = 3; this.emit('close', code, reason) })
}
it('WS route attaches only existing workspace ids and rejects stale/foreign/exited without spawning', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sidebar-ws-route-'))
  const other = mkdtempSync(join(tmpdir(), 'sidebar-ws-other-'))
  const events = new EventEmitter(), kill = vi.fn(), write = vi.fn()
  state.spawn.mockReturnValue({ kill, write, resize: vi.fn(), onData: (fn: (s: string) => void) => {
    events.on('data', fn); return { dispose: () => events.off('data', fn) }
  }, onExit: (fn: (event: unknown) => void) => { events.on('exit', fn); return { dispose: () => events.off('exit', fn) } } })
  const routes: SidebarWebRoute[] = [], upgrades: SidebarWebUpgradeRoute[] = [], cleanup: Array<() => void> = []
  let creatorRemoved = false
  apply({ webRuntime: { trustedHosts: [] }, webServer: {
    register: (r: SidebarWebRoute) => { routes.push(r); return () => {} },
    registerUpgrade: (r: SidebarWebUpgradeRoute) => { upgrades.push(r); return () => {} },
  }, sessions: { get: (id: string) => creatorRemoved && id === 'one' ? undefined : ({ header: { cwd: id === 'foreign' ? other : cwd } }) },
  tools: { register: () => () => {} }, get: () => undefined, on: () => () => {}, inject: () => () => {},
  effect: (fn: () => (() => void) | void) => { const disposer = fn(); if (disposer) cleanup.push(disposer) },
  } as never)
  const api = routes.find(r => r.path === '/sidebar/api')!
  async function call(method: string, payload: unknown) {
    let body = ''
    await api.handler({ url: `/sidebar/api/${method}`, method: 'POST', headers: { host: '127.0.0.1:3080' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(payload) } },
      { statusCode: 0, writeHead: () => {}, end: value => { body = String(value) } })
    return JSON.parse(body).value
  }
  const upgrade = upgrades.find(r => r.path === '/sidebar/ws/terminal')!
  async function attach(id: string, viewer = 'two', host = '127.0.0.1:3080') {
    const ws = new Socket(), transport = { destroy: vi.fn() }
    state.accepted = ws
    await upgrade.handler({ url: `/sidebar/ws/terminal?sessionId=${viewer}&terminalId=${encodeURIComponent(id)}&cwd=${encodeURIComponent(other)}`, headers: { host } } as never, transport, Buffer.alloc(0))
    // Await realpath/stat resolution of the asynchronously accepted socket.
    await vi.waitFor(() => { expect(ws.close.mock.calls.length + ws.listenerCount('message') + transport.destroy.mock.calls.length).toBeGreaterThan(0) })
    return { ws, transport }
  }
  try {
    const info = await call('workspace-terminal.create', { sessionId: 'one' })
    const { ws: a } = await attach(info.terminalId)
    creatorRemoved = true // creator session lifetime does not own the workspace terminal
    const { ws: b } = await attach(info.terminalId)
    a.emit('close')
    b.emit('message', Buffer.from('hello'))
    expect(write).toHaveBeenCalledWith('hello')
    expect(kill).not.toHaveBeenCalled()
    expect((await attach(info.terminalId, 'foreign')).ws.close).toHaveBeenCalledWith(1008, 'workspace-mismatch')
    expect((await attach('terminal:missing')).ws.close).toHaveBeenCalledWith(1008, 'terminal-not-found')
    expect((await attach(info.terminalId, 'two', 'evil.test')).transport.destroy).toHaveBeenCalled()
    events.emit('exit', { exitCode: 0 })
    expect(b.close).toHaveBeenCalledWith(1000, 'terminal-exited')
    expect((await attach(info.terminalId)).ws.close).toHaveBeenCalledWith(1000, 'terminal-exited')
    await call('workspace-terminal.terminate', { sessionId: 'two', terminalId: info.terminalId })
    expect((await attach(info.terminalId)).ws.close).toHaveBeenCalledWith(1008, 'terminal-not-found')
    expect(state.spawn).toHaveBeenCalledTimes(1)
    // Old clients already use terminal:<uuid> as legacy tab ids. Registry
    // separation is by query contract, not by banning this shared prefix.
    const legacy = new Socket()
    state.accepted = legacy
    await upgrade.handler({ url: '/sidebar/ws/terminal?sessionId=two&tab=terminal%3Alegacy-uuid', headers: { host: '127.0.0.1:3080' } } as never,
      { destroy: vi.fn() }, Buffer.alloc(0))
    await vi.waitFor(() => expect(legacy.listenerCount('message')).toBe(1))
    expect(legacy.close).not.toHaveBeenCalled()
    expect(state.spawn).toHaveBeenCalledTimes(2)
    legacy.emit('message', Buffer.from('legacy input'))
    expect(write).toHaveBeenCalledWith('legacy input')
  } finally { cleanup.forEach(f => f()); rmSync(cwd, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }) }
})
