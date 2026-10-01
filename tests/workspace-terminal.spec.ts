import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { NodePtyModule } from '../src/pty-deps.ts'
import { WorkspaceTerminalManager, resolveTerminalWorkspace } from '../src/workspace-terminal.ts'
import { PtyManager } from '../src/pty-manager.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

const mock = vi.hoisted(() => ({ spawn: vi.fn(), processes: [] as unknown[] }))
vi.mock('../src/pty-deps.ts', async importOriginal => ({ ...await importOriginal<object>(), loadNodePty: () => ({ spawn: mock.spawn }) }))
import { apply } from '../src/index.ts'
class MockPty {
  events = new EventEmitter()
  kill = vi.fn()
  write = vi.fn()
  resize = vi.fn()
  onData(fn: (data: string) => void) { this.events.on('data', fn); return { dispose: () => { this.events.off('data', fn) } } }
  onExit(fn: (event: { exitCode: number }) => void) { this.events.on('exit', fn); return { dispose: () => { this.events.off('exit', fn) } } }
}
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN
  bufferedAmount = 0
  send = vi.fn()
  close = vi.fn((code?: number, reason?: string) => { this.readyState = WebSocket.CLOSED as 1; this.emit('close', code, reason) })
}
const dirs: string[] = []
function dir() { const path = mkdtempSync(join(tmpdir(), 'sidebar-workspace-terminal-')); dirs.push(path); return realpathSync(path) }
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); vi.clearAllMocks() })
function setup(cap = 3, global = 64, bytes = 1024) {
  const processes: MockPty[] = []
  const nodePty = { spawn: vi.fn(() => { const p = new MockPty(); processes.push(p); return p }) }
  return { processes, nodePty, manager: new WorkspaceTerminalManager(process.execPath, nodePty as unknown as NodePtyModule, cap, global, bytes), workspace: { key: 'local:one', cwd: dir() } }
}
it('legacy session/tab open reuse, exited restart and close remain compatible', () => {
  const { nodePty, processes, workspace } = setup()
  const manager = new PtyManager(process.execPath, 3, [], nodePty as unknown as NodePtyModule)
  const handle = manager.open('legacy', 'tab', workspace.cwd, 80, 24)
  expect(manager.open('legacy', 'tab', workspace.cwd, 80, 24)).toBe(handle)
  processes[0]!.events.emit('exit', { exitCode: 0 })
  expect(manager.open('legacy', 'tab', workspace.cwd, 80, 24)).not.toBe(handle)
  manager.close('legacy:tab')
  expect(processes[1]!.kill).toHaveBeenCalledTimes(1)
  expect(manager.keysOf('legacy')).toEqual([])
  manager.disposeAll()
})

describe('workspace PTY registry', () => {
  it('shares across viewers; disconnect/park/close do not kill; terminate rejects stale writes and attachment', () => {
    const { manager, workspace, processes, nodePty } = setup()
    const info = manager.create(workspace, 'creator', 'shell')
    expect(info.terminalId).toMatch(/^terminal:[\da-f-]{36}$/)
    const a = new Socket(), b = new Socket()
    manager.attach(workspace, info.terminalId, a as never); manager.attach(workspace, info.terminalId, b as never)
    a.emit('close'); b.emit('message', Buffer.from('{"type":"park"}'))
    expect(processes[0]!.kill).not.toHaveBeenCalled()
    const c = new Socket(); manager.attach(workspace, info.terminalId, c as never)
    c.emit('message', Buffer.from('{"type":"close"}'))
    expect(processes[0]!.kill).not.toHaveBeenCalled()
    const d = new Socket(); manager.attach(workspace, info.terminalId, d as never)
    manager.terminate(workspace, info.terminalId)
    expect(d.close).toHaveBeenCalledWith(1000, 'terminal-terminated')
    d.emit('message', Buffer.from('stale input'))
    expect(processes[0]!.write).not.toHaveBeenCalled()
    expect(() => manager.attach(workspace, info.terminalId, new Socket() as never)).toThrow('terminal-not-found')
    expect(nodePty.spawn).toHaveBeenCalledTimes(1)
  })
  it('retains exited instances without restart and bounds UTF-8 replay with independent cursors', () => {
    const { manager, workspace, processes, nodePty } = setup(3, 64, 8)
    const info = manager.create(workspace, 'creator')
    processes[0]!.events.emit('data', '你好12345678')
    const result = manager.readOutput(workspace, info.terminalId)
    expect(Buffer.byteLength(result.data)).toBeLessThanOrEqual(8)
    expect(result.truncated).toBe(true)
    expect(result.data).not.toContain('�')
    expect(manager.readOutput(workspace, info.terminalId, result.cursor).data).toBe('')
    processes[0]!.events.emit('exit', { exitCode: 7 })
    const ws = new Socket(); manager.attach(workspace, info.terminalId, ws as never)
    expect(ws.close).toHaveBeenCalledWith(1000, 'terminal-exited')
    expect(manager.list(workspace)[0]).toMatchObject({ exited: true, exitCode: 7 })
    expect(nodePty.spawn).toHaveBeenCalledTimes(1)
    manager.disposeAll()
  })
  it('enforces workspace/global quotas, foreign workspace rejection and retained-record bound', () => {
    const { manager, workspace, processes } = setup(1, 2)
    const first = manager.create(workspace, 'one')
    expect(() => manager.create(workspace, 'two')).toThrow('limit')
    const other = { ...workspace, key: 'local:two' }
    manager.create(other, 'two')
    expect(() => manager.create({ ...other, key: 'three' }, 'three')).toThrow('limit')
    expect(() => manager.terminate(other, first.terminalId)).toThrow('workspace-mismatch')
    expect(() => manager.attach(other, first.terminalId, new Socket() as never)).toThrow('workspace-mismatch')
    for (let i = 0; i < 3; i++) {
      processes.filter(p => p !== processes[1]).at(-1)!.events.emit('exit', { exitCode: 0 })
      manager.create(workspace, 'one')
    }
    processes.at(-1)!.events.emit('exit', { exitCode: 0 })
    expect(() => manager.create(workspace, 'one')).toThrow('limit')
    manager.disposeAll()
  })
})

describe('authoritative workspace identity', () => {
  it('uses public workspace registry stable identity and rejects missing authoritative headers', async () => {
    const cwd = dir()
    const ctx = { sessions: { get: () => ({ header: { cwd } }) }, get: () => ({ list: () => [{ id: 'host-id', path: cwd, sessionIds: ['one'] }] }) }
    expect((await resolveTerminalWorkspace(ctx as never, 'one')).key).toContain('host:host-id')
    await expect(resolveTerminalWorkspace({ sessions: { get: () => undefined }, get: () => undefined } as never, 'missing')).rejects.toThrow('authoritative')
  })
  it('prefers explicit membership for same-path host identities and survives creator removal', async () => {
    const cwd = dir()
    let creatorRemoved = false
    const registry = { list: () => [
      { id: 'first', path: cwd, sessionIds: creatorRemoved ? ['viewer'] : ['creator', 'viewer'] },
      { id: 'second', path: cwd, sessionIds: ['other'] },
    ] }
    const ctx = {
      sessions: { get: (id: string) => creatorRemoved && id === 'creator' ? undefined : ({ header: { cwd } }) },
      get: (name: string) => name === 'workspaceRegistry' ? registry : undefined,
    }
    const creator = await resolveTerminalWorkspace(ctx as never, 'creator')
    creatorRemoved = true
    expect((await resolveTerminalWorkspace(ctx as never, 'viewer')).key).toBe(creator.key)
    expect((await resolveTerminalWorkspace(ctx as never, 'other')).key).not.toBe(creator.key)
    // Unaccounted sessions use canonical-directory matching in registry order;
    // this is a root-based local workspace fallback, not claimed membership.
    expect((await resolveTerminalWorkspace(ctx as never, 'unaccounted')).key).toBe(creator.key)
  })
  it('reads cold persisted header without consuming events and always releases handle', async () => {
    const close = vi.fn(), read = vi.fn()
    const ctx = { sessions: { get: () => undefined }, get: (name: string) => name === 'sessionPersistence' ? { open: async () => ({ header: { cwd: dir() }, close, read }) } : undefined }
    expect((await resolveTerminalWorkspace(ctx as never, 'cold')).key).toContain('root:')
    expect(close).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled()
  })
})

it('mounted POST API inherits trust fence and validates workspace on create/list/terminate', async () => {
  const cwd = dir(), foreign = dir(), routes: SidebarWebRoute[] = [], cleanup: Array<() => void> = []
  mock.spawn.mockImplementation(() => new MockPty())
  const ctx = {
    webRuntime: { trustedHosts: [] }, webServer: { register: (r: SidebarWebRoute) => { routes.push(r); return () => {} }, registerUpgrade: () => () => {} },
    sessions: { get: (id: string) => id === 'missing' ? undefined : ({ header: { cwd: id === 'foreign' ? foreign : cwd } }) },
    tools: { register: () => () => {} }, get: () => undefined, on: () => () => {}, inject: () => () => {},
    effect: (fn: () => (() => void) | void) => { const f = fn(); if (f) cleanup.push(f) },
  }
  apply(ctx as never)
  const route = routes.find(r => r.path === '/sidebar/api')!
  async function invoke(method: string, payload: unknown, host = '127.0.0.1:3080') {
    let status = 0, body = ''
    await route.handler({ method: 'POST', url: `/sidebar/api/${method}`, headers: { host }, async *[Symbol.asyncIterator]() { yield JSON.stringify(payload) } },
      { statusCode: 0, writeHead: n => { status = n }, end: value => { body = String(value) } })
    return { status, body: JSON.parse(body) }
  }
  try {
    expect((await invoke('workspace-terminal.create', { sessionId: 'a' }, 'evil.test')).status).toBe(403)
    expect(mock.spawn).not.toHaveBeenCalled()
    const created = await invoke('workspace-terminal.create', { sessionId: 'a', title: 'UI', cwd: foreign })
    expect(created.status).toBe(200)
    const info = created.body.value
    expect(info.cwd).toBe(cwd)
    expect((await invoke('workspace-terminal.list', { sessionId: 'b' })).body.value.terminals).toHaveLength(1)
    expect((await invoke('workspace-terminal.list', { sessionId: 'foreign' })).body.value.terminals).toEqual([])
    expect((await invoke('workspace-terminal.list', { sessionId: 'missing', cwd })).status).toBe(400)
    expect((await invoke('workspace-terminal.terminate', { sessionId: 'foreign', terminalId: info.terminalId })).status).toBe(403)
    expect((await invoke('workspace-terminal.terminate', { sessionId: 'b', terminalId: info.terminalId })).body.value).toEqual({ ok: true })
  } finally { cleanup.forEach(f => f()) }
})
