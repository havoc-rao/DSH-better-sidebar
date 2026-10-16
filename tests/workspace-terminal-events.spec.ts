import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { NodePtyModule } from '../src/pty-deps.ts'
import { WorkspaceTerminalManager, type WorkspaceTerminalSnapshot } from '../src/workspace-terminal.ts'

vi.mock('../src/zsh-integration.ts', async original => ({
  ...await original<object>(), prepareZshIntegration: () => ({ token: 'fixture', env: {}, dispose: vi.fn() }),
}))
class Pty extends EventEmitter {
  pid = 123
  kill = vi.fn()
  write = vi.fn()
  resize = vi.fn()
  onData(fn: (data: string) => void) { this.on('data', fn); return { dispose: () => this.off('data', fn) } }
  onExit(fn: (data: { exitCode: number }) => void) { this.on('exit', fn); return { dispose: () => this.off('exit', fn) } }
}
class Socket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  send = vi.fn()
  close = vi.fn(() => this.emit('close'))
}
const workspace = { key: 'one', cwd: process.cwd() }
const other = { ...workspace, key: 'other' }
const managers: WorkspaceTerminalManager[] = []
afterEach(() => { managers.splice(0).forEach(manager => manager.disposeAll()); vi.useRealTimers() })
function setup(probe = vi.fn(async () => ({ activity: 'unknown' as const, reason: 'fixture' }))) {
  let now = 10
  const pty = new Pty()
  const manager = new WorkspaceTerminalManager(process.execPath, { spawn: () => pty } as unknown as NodePtyModule, 3, 64, 1024, { now: () => now, probe })
  managers.push(manager)
  return { manager, pty, advance: (ms: number) => { now += ms } }
}
const marker = (kind: string) => `\x1b]633;dsh;fixture;${kind}\x07`
it('subscribes immediately, isolates workspaces/consumers and preserves revisions after unsubscribe', () => {
  const { manager } = setup()
  const a: WorkspaceTerminalSnapshot[] = [], b = vi.fn()
  const unsubscribe = manager.subscribe(workspace, value => a.push(value))
  manager.subscribe(other, b)
  manager.subscribe(workspace, () => { throw new Error('bad consumer') })
  expect(a).toEqual([{ revision: 0, terminals: [] }])
  const info = manager.create(workspace, 'one')
  expect(a.at(-1)!.terminals).toHaveLength(1)
  expect(b).toHaveBeenCalledTimes(1)
  manager.pin(workspace, info.terminalId, true)
  expect(a.at(-1)!.terminals[0]!.pinned).toBe(true)
  const revision = a.at(-1)!.revision
  unsubscribe(); unsubscribe()
  manager.terminate(workspace, info.terminalId)
  expect(a.at(-1)!.revision).toBe(revision)
  const next = vi.fn(); manager.subscribe(workspace, next)
  expect(next.mock.calls[0]![0]).toMatchObject({ terminals: [], revision: expect.any(Number) })
  expect(next.mock.calls[0]![0].revision).toBeGreaterThan(revision)
})
it('coalesces IO bursts, flushes exit immediately, and cancels pending notifications on disposal', () => {
  vi.useFakeTimers()
  const { manager, pty } = setup()
  const listener = vi.fn(); manager.subscribe(workspace, listener)
  const info = manager.create(workspace, 'one')
  const socket = new Socket(); manager.attach(workspace, info.terminalId, socket as never)
  expect(listener.mock.calls.at(-1)![0].terminals[0].attachedViews).toBe(1)
  listener.mockClear()
  for (let i = 0; i < 1000; i++) { pty.emit('data', 'a'); socket.emit('message', Buffer.from('x')) }
  expect(listener).not.toHaveBeenCalled()
  vi.advanceTimersByTime(100)
  expect(listener).toHaveBeenCalledTimes(1)
  expect(listener.mock.calls[0]![0].terminals[0]).toMatchObject({ lastInputAt: 10, lastOutputAt: 10 })
  socket.emit('close')
  expect(listener.mock.calls.at(-1)![0].terminals[0]).toMatchObject({ attachedViews: 0, lastDetachedAt: 10 })
  pty.emit('data', 'pending')
  pty.emit('exit', { exitCode: 4 })
  expect(listener.mock.calls.at(-1)![0].terminals[0]).toMatchObject({ exited: true, exitCode: 4 })
  const count = listener.mock.calls.length
  vi.advanceTimersByTime(1000)
  expect(listener).toHaveBeenCalledTimes(count)
  // A new live terminal leaves pending IO when teardown occurs.
  manager.create(workspace, 'two'); pty.emit('data', 'teardown-pending')
  const beforeDispose = listener.mock.calls.length
  manager.disposeAll(); vi.runAllTimers()
  expect(listener).toHaveBeenCalledTimes(beforeDispose)
  expect(() => manager.subscribe(workspace, listener)).toThrow('disposed')
})
it('keeps hook execution state across output and typing; end awaits prompt, startup does not complete', async () => {
  const { manager, pty, advance } = setup()
  const listener = vi.fn(); manager.subscribe(workspace, listener)
  const info = manager.create(workspace, 'one', undefined, '/bin/zsh', [], true)
  pty.emit('data', marker('prompt'))
  expect(manager.list(workspace)[0]).toMatchObject({ activity: 'idle' })
  expect(manager.list(workspace)[0]!.commandFinishedAt).toBeUndefined()
  const socket = new Socket(); manager.attach(workspace, info.terminalId, socket as never)
  socket.emit('message', Buffer.from('typing'))
  expect(manager.list(workspace)[0]!.commandStartedAt).toBeUndefined()
  pty.emit('data', marker('accept')) // blank Enter accepts a line, not a command
  expect(manager.list(workspace)[0]!.activity).toBe('unknown')
  expect(manager.list(workspace)[0]!.commandStartedAt).toBeUndefined()
  pty.emit('data', marker('prompt'))
  expect(manager.list(workspace)[0]!.commandFinishedAt).toBeUndefined()
  pty.emit('data', marker('accept'))
  pty.emit('data', marker('start'))
  advance(50); pty.emit('data', marker('start')) // tolerate duplicate start marker
  pty.emit('data', 'echo/output')
  await manager.sweep()
  expect(manager.list(workspace)[0]).toMatchObject({ activity: 'busy', commandStartedAt: 10 })
  advance(100); pty.emit('data', marker('end;7'))
  expect(manager.list(workspace)[0]).toMatchObject({ activity: 'unknown', commandFinishedAt: 160, commandDurationMs: 150, commandExitCode: 7 })
  pty.emit('data', 'slow prompt rendering')
  expect(manager.list(workspace)[0]!.activity).toBe('unknown')
  pty.emit('data', marker('prompt'))
  expect(listener.mock.calls.at(-1)![0].terminals[0].activity).toBe('idle')
  pty.emit('data', marker('unsupported'))
  pty.emit('data', marker('prompt'))
  expect(manager.list(workspace)[0]).toMatchObject({ activity: 'unknown', activityReason: 'shell-integration-unsupported-hooks' })
})
it('hook idle presentation never substitutes for process proof during cleanup', async () => {
  const probe = vi.fn(async () => ({ activity: 'unknown' as const, reason: 'no-proof' }))
  const { manager, pty, advance } = setup(probe)
  manager.create(workspace, 'one', undefined, '/bin/zsh', [], true)
  pty.emit('data', marker('prompt'))
  advance(60 * 60_000)
  expect(await manager.cleanup(workspace)).toEqual({ removed: 0 })
  advance(60 * 60_000)
  expect(await manager.cleanup(workspace)).toEqual({ removed: 0 })
  expect(pty.kill).not.toHaveBeenCalled()
  expect(manager.list(workspace)[0]!.activity).toBe('idle')
})
