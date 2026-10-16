import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { NodePtyModule } from '../src/pty-deps.ts'
import { WorkspaceTerminalManager, resolveTerminalWorkspace, type WorkspaceTerminalLifecycleOptions } from '../src/workspace-terminal.ts'
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
function setup(cap = 3, global = 64, bytes = 1024, options: WorkspaceTerminalLifecycleOptions = {}) {
  const processes: MockPty[] = []
  const nodePty = { spawn: vi.fn(() => { const p = new MockPty(); processes.push(p); return p }) }
  return { processes, nodePty, manager: new WorkspaceTerminalManager(process.execPath, nodePty as unknown as NodePtyModule, cap, global, bytes, options), workspace: { key: 'local:one', cwd: dir() } }
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

describe('workspace lifecycle', () => {
  it('publishes sampled commands and clears them on input/output, probe failure and exit', async () => {
    const probe = vi.fn(async () => ({ activity: 'busy' as const, reason: 'fixture', runningCommands: ['node'] }))
    const { manager, workspace, processes } = setup(3, 64, 1024, { probe })
    const info = manager.create(workspace, 'one')
    await manager.sweep()
    expect(manager.list(workspace)[0]!.runningCommands).toEqual(['node'])
    const ws = new Socket(); manager.attach(workspace, info.terminalId, ws as never)
    ws.emit('message', Buffer.from('input'))
    expect(manager.list(workspace)[0]!.runningCommands).toBeUndefined()
    await manager.sweep()
    processes[0]!.events.emit('data', 'output')
    expect(manager.list(workspace)[0]!.runningCommands).toBeUndefined()
    await manager.sweep()
    probe.mockRejectedValueOnce(new Error('permission denied'))
    await manager.sweep()
    expect(manager.list(workspace)[0]).toMatchObject({ activity: 'unknown' })
    expect(manager.list(workspace)[0]!.runningCommands).toBeUndefined()
    await manager.sweep()
    processes[0]!.events.emit('exit', { exitCode: 0 })
    expect(manager.list(workspace)[0]!.runningCommands).toBeUndefined()
    manager.disposeAll()
  })
  it('atomically ensures reuse across sessions and concurrent windows', async () => {
    const { manager, workspace, nodePty } = setup()
    const results = await Promise.all(Array.from({ length: 12 }, () => manager.ensure(workspace, 'one')))
    expect(new Set(results.map(info => info.terminalId)).size).toBe(1)
    const others = await Promise.all(['two', 'three', 'four'].map(id => manager.ensure(workspace, id)))
    expect(others.every(info => info.terminalId === results[0]!.terminalId)).toBe(true)
    expect(nodePty.spawn).toHaveBeenCalledTimes(1)
    manager.disposeAll()
  })
  it.each(['idle', 'busy', 'unknown'] as const)('reattaches an attached pinned %s terminal without restarting or sending input', async activity => {
    const { manager, workspace, nodePty, processes } = setup(1, 64, 1024, { probe: async () => ({ activity, reason: 'fixture' }) })
    const original = manager.create(workspace, 'creator')
    await manager.sweep()
    manager.pin(workspace, original.terminalId, true)
    manager.attach(workspace, original.terminalId, new Socket() as never)
    expect((await manager.ensure(workspace, 'one')).terminalId).toBe(original.terminalId)
    expect((await manager.ensure(workspace, 'two')).terminalId).toBe(original.terminalId)
    expect(nodePty.spawn).toHaveBeenCalledTimes(1)
    expect(processes[0]!.write).not.toHaveBeenCalled()
    expect(processes[0]!.kill).not.toHaveBeenCalled()
    manager.disposeAll()
  })
  it('prefers the session own live shell and creates only when all shells have exited', async () => {
    const { manager, workspace, nodePty, processes } = setup()
    manager.create(workspace, 'other')
    const own = manager.create(workspace, 'one')
    expect((await manager.ensure(workspace, 'one')).terminalId).toBe(own.terminalId)
    for (const pty of processes) pty.events.emit('exit', { exitCode: 0 })
    expect((await manager.ensure(workspace, 'one')).terminalId).not.toBe(own.terminalId)
    expect(nodePty.spawn).toHaveBeenCalledTimes(3)
    manager.disposeAll()
  })
  it('protects busy, unknown, attached and pinned and reaps only continuously proven idle', async () => {
    let now = 0
    let activity: 'idle' | 'busy' | 'unknown' = 'unknown'
    const { manager, workspace, processes } = setup(6, 64, 1024, { now: () => now, probe: async () => ({ activity, reason: 'fixture' }) })
    const info = manager.create(workspace, 'one')
    expect(info.activity).toBe('unknown')
    now = 60 * 60_000
    expect(await manager.cleanup(workspace)).toEqual({ removed: 0 })
    activity = 'busy'; expect(await manager.sweep()).toBe(0)
    activity = 'idle'; await manager.sweep()
    now += 31 * 60_000
    manager.pin(workspace, info.terminalId, true)
    expect(await manager.sweep()).toBe(0)
    manager.pin(workspace, info.terminalId, false)
    const ws = new Socket(); manager.attach(workspace, info.terminalId, ws as never)
    expect(manager.list(workspace)[0]!.attachedViews).toBe(1)
    expect(await manager.sweep()).toBe(0)
    ws.emit('close')
    expect(await manager.sweep()).toBe(0)
    now += 2 * 60_000
    expect(await manager.cleanup(workspace)).toEqual({ removed: 1 })
    expect(processes[0]!.kill).toHaveBeenCalledTimes(1)
  })
  it('retains exited transcripts ten minutes and prunes before history quota checks', () => {
    let now = 0
    const { manager, workspace, processes } = setup(1, 4, 1024, { now: () => now })
    for (let i = 0; i < 4; i++) {
      manager.create(workspace, 'one'); processes[i]!.events.emit('exit', { exitCode: 0 })
    }
    expect(manager.list(workspace)[0]).toMatchObject({ activity: 'exited', exitedAt: 0 })
    expect(() => manager.create(workspace, 'one')).toThrow('terminal-workspace-history-limit')
    now = 10 * 60_000
    manager.create(workspace, 'one')
    expect(manager.list(workspace)).toHaveLength(1)
    expect(() => manager.create(workspace, 'one')).toThrow('terminal-workspace-live-limit')
  })
  it('protects pinned exited transcripts and detach grace even after retention', async () => {
    let now = 0
    const { manager, workspace, processes } = setup(3, 64, 1024, { now: () => now })
    const info = manager.create(workspace, 'one')
    manager.pin(workspace, info.terminalId, true)
    processes[0]!.events.emit('exit', { exitCode: 0 })
    now = 11 * 60_000
    expect(await manager.cleanup(workspace)).toEqual({ removed: 0 })
    manager.pin(workspace, info.terminalId, false)
    expect(await manager.cleanup(workspace)).toEqual({ removed: 1 })
  })
  it('rechecks activity and rejects late idle proof after input, pin or disposal', async () => {
    let now = 0
    let resolveProbe: ((value: { activity: 'idle'; reason: string }) => void) | undefined
    let pending = false
    const { manager, workspace } = setup(3, 64, 1024, { now: () => now, probe: () => pending
      ? new Promise(resolve => { resolveProbe = resolve }) : Promise.resolve({ activity: 'idle', reason: 'fixture' }) })
    const info = manager.create(workspace, 'one')
    await manager.sweep(); now = 31 * 60_000
    pending = true
    const sweep = manager.sweep()
    manager.pin(workspace, info.terminalId, true)
    resolveProbe!({ activity: 'idle', reason: 'stale' })
    expect(await sweep).toBe(0)
    manager.pin(workspace, info.terminalId, false)
    const disposedSweep = manager.sweep()
    manager.disposeAll()
    resolveProbe!({ activity: 'idle', reason: 'late' })
    expect(await disposedSweep).toBe(0)
    expect(manager.list(workspace)).toEqual([])
    await expect(manager.ensure(workspace, 'one')).rejects.toThrow('disposed')
  })
  it('protects an ensure acquisition racing an in-flight sweep before the socket attaches', async () => {
    let now = 0, deferred = false
    let resolveProbe!: (value: { activity: 'idle'; reason: string }) => void
    const { manager, workspace, processes } = setup(3, 64, 1024, { now: () => now, probe: () => deferred
      ? new Promise(resolve => { resolveProbe = resolve }) : Promise.resolve({ activity: 'idle', reason: 'fixture' }) })
    const info = manager.create(workspace, 'one')
    await manager.sweep(); now = 31 * 60_000
    deferred = true
    const sweep = manager.sweep()
    expect((await manager.ensure(workspace, 'one')).terminalId).toBe(info.terminalId)
    resolveProbe({ activity: 'idle', reason: 'stale' })
    expect(await sweep).toBe(0)
    expect(processes[0]!.kill).not.toHaveBeenCalled()
    deferred = false
    expect(await manager.sweep()).toBe(0)
  })
  it('reprobes before idle reclamation and never kills a newly busy process', async () => {
    let now = 0, calls = 0
    const { manager, workspace, processes } = setup(3, 64, 1024, { now: () => now, probe: async () => ({
      activity: ++calls === 3 ? 'busy' : 'idle', reason: 'fixture',
    }) })
    manager.create(workspace, 'one')
    await manager.sweep(); now = 31 * 60_000
    expect(await manager.sweep()).toBe(0)
    expect(calls).toBe(3)
    expect(processes[0]!.kill).not.toHaveBeenCalled()
    expect(manager.list(workspace)[0]!.activity).toBe('busy')
  })
  it('reattaches across sessions without waiting for a pending activity probe', async () => {
    let resolveProbe!: (value: { activity: 'idle'; reason: string }) => void
    const { manager, workspace, nodePty } = setup(3, 64, 1024, { probe: () => new Promise(resolve => { resolveProbe = resolve }) })
    const info = manager.create(workspace, 'creator')
    const sweep = manager.sweep()
    expect((await manager.ensure(workspace, 'other')).terminalId).toBe(info.terminalId)
    resolveProbe({ activity: 'idle', reason: 'stale' })
    await sweep
    expect(manager.list(workspace)[0]).toMatchObject({ activity: 'unknown' })
    expect(nodePty.spawn).toHaveBeenCalledTimes(1)
    manager.disposeAll()
  })
  it('records input/output and prevents late probe results from hiding them', async () => {
    let now = 123
    let resolveProbe!: (value: { activity: 'idle'; reason: string }) => void
    const { manager, workspace, processes } = setup(3, 64, 1024, { now: () => now,
      probe: () => new Promise(resolve => { resolveProbe = resolve }),
    })
    const info = manager.create(workspace, 'one')
    const ws = new Socket(); manager.attach(workspace, info.terminalId, ws as never)
    const sweep = manager.sweep()
    ws.emit('message', Buffer.from('work'))
    now = 124; processes[0]!.events.emit('data', 'result')
    resolveProbe({ activity: 'idle', reason: 'stale' })
    await sweep
    expect(manager.list(workspace)[0]).toMatchObject({ lastInputAt: 123, lastOutputAt: 124, activity: 'unknown', attachedViews: 1 })
    ws.emit('close'); expect(manager.list(workspace)[0]).toMatchObject({ lastDetachedAt: 124, attachedViews: 0 })
  })
  it('distinguishes global live and history limits from workspace limits', () => {
    const { manager, workspace, processes } = setup(10, 1)
    manager.create(workspace, 'one')
    expect(() => manager.create({ ...workspace, key: 'other' }, 'two')).toThrow('terminal-global-live-limit')
    for (let i = 0; i < 4; i++) {
      processes[i]!.events.emit('exit', { exitCode: 0 })
      if (i < 3) manager.create({ ...workspace, key: `other-${i}` }, 'two')
    }
    expect(() => manager.create(workspace, 'one')).toThrow('terminal-global-history-limit')
  })
  it('times out failing probes and keeps unknown terminals safe with fake timers', async () => {
    vi.useFakeTimers()
    try {
      const { manager, workspace } = setup(3, 64, 1024, { probe: () => new Promise(() => {}) })
      manager.create(workspace, 'one')
      const sweep = manager.sweep()
      await vi.advanceTimersByTimeAsync(2000)
      expect(await sweep).toBe(0)
      expect(manager.list(workspace)[0]).toMatchObject({ activity: 'unknown', activityReason: 'process-probe-timeout' })
      manager.disposeAll()
    } finally { vi.useRealTimers() }
  })
})

it('opt-in zsh integration requires settled prompt and invalidates proof on input', async () => {
  if (!['darwin', 'linux'].includes(process.platform)) return
  let now = 0
  const probe = vi.fn(async (_pid: number, prompt?: boolean) => ({ activity: prompt ? 'idle' as const : 'unknown' as const, reason: 'fixture' }))
  const { manager, workspace, processes, nodePty } = setup(3, 64, 1024, { now: () => now, probe })
  const info = manager.create(workspace, 'one', undefined, '/bin/zsh', [], true)
  const options = nodePty.spawn.mock.calls[0] as unknown as [string, string[], { env: { ZDOTDIR: string } }]
  const { readFileSync } = await import('node:fs')
  const rc = readFileSync(options[2].env.ZDOTDIR + '/.zshrc', 'utf8')
  const token = rc.match(/633;dsh;([a-f0-9]+);prompt/)![1]!
  try {
    expect(options[1]).toEqual(['-i'])
    processes[0]!.events.emit('data', `fixture> \x1b]633;dsh;${token};prompt\x07`)
    await manager.sweep(); expect(manager.list(workspace)[0]!.activity).toBe('idle')
    expect(probe.mock.calls.at(-1)![1]).toBe(false) // presentation is not cleanup proof
    now = 2000
    await manager.sweep(); expect(manager.list(workspace)[0]!.activity).toBe('idle')
    expect(manager.readOutput(workspace, info.terminalId).data).toBe('fixture> ')
    processes[0]!.events.emit('data', '\x1b]633;dsh;')
    await manager.sweep(); expect(manager.list(workspace)[0]!.activity).toBe('idle')
    expect(probe.mock.calls.at(-1)![1]).toBe(false) // partial bytes still invalidate cleanup proof
    processes[0]!.events.emit('data', `${token};prompt\x07`)
    now += 2000
    await manager.sweep(); expect(manager.list(workspace)[0]!.activity).toBe('idle')
    const ws = new Socket(); manager.attach(workspace, info.terminalId, ws as never)
    ws.emit('message', Buffer.from('read answer\r'))
    await manager.sweep(); expect(probe.mock.calls.at(-1)![1]).toBe(false)
    processes[0]!.events.emit('data', `\x1b]633;dsh;${token};unsupported\x07\x1b]633;dsh;${token};prompt\x07`)
    now += 3000
    await manager.sweep()
    expect(manager.list(workspace)[0]).toMatchObject({ activity: 'unknown', activityReason: 'shell-integration-unsupported-hooks' })
  } finally { manager.disposeAll() }
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
    const ensured = await Promise.all(Array.from({ length: 5 }, () => invoke('workspace-terminal.ensure', { sessionId: 'a' })))
    expect(ensured.every(result => result.body.value.terminalId === info.terminalId)).toBe(true)
    expect((await invoke('workspace-terminal.pin', { sessionId: 'foreign', terminalId: info.terminalId, pinned: true })).status).toBe(403)
    expect((await invoke('workspace-terminal.pin', { sessionId: 'a', terminalId: info.terminalId, pinned: 'true' })).status).toBe(400)
    expect((await invoke('workspace-terminal.pin', { sessionId: 'a', terminalId: info.terminalId, pinned: true })).body.value).toEqual({ ok: true })
    expect((await invoke('workspace-terminal.cleanup', { sessionId: 'b' })).body.value).toEqual({ removed: 0 })
    expect((await invoke('workspace-terminal.terminate', { sessionId: 'foreign', terminalId: info.terminalId })).status).toBe(403)
    expect((await invoke('workspace-terminal.terminate', { sessionId: 'b', terminalId: info.terminalId })).body.value).toEqual({ ok: true })
  } finally { cleanup.forEach(f => f()) }
})
