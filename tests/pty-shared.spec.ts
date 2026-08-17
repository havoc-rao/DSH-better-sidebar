/**
 * Workspace-shared PTY tests: a `ws:` stub tab id opens ONE pty per
 * workspace (key `shared:<tabId>`, no session), so every session's pinned
 * terminal attaches to the same long-running process. Covers the key
 * mapping, cross-session reuse, first-cwd-wins (no respawn), quota
 * bypass, exited respawn, and teardown.
 */
import { describe, expect, it, vi } from 'vitest'
import { PtyManager, isSharedTabId, ptyKeyOf, type SidebarPty } from '../src/pty-manager.ts'
import type { NodePtyModule } from '../src/pty-deps.ts'

/** A fake node-pty module: records spawns, exposes per-pty listeners so
 *  tests can fire exit events. */
function fakeNodePty(): { module: NodePtyModule; spawns: Array<{ pty: FakePty; args: { cwd: string } }> } {
  const spawns: Array<{ pty: FakePty; args: { cwd: string } }> = []
  const module = {
    spawn: (_shell: string, _args: string[], options: { cwd: string }) => {
      const pty = new FakePty()
      spawns.push({ pty, args: options })
      return pty as unknown as import('node-pty').IPty
    },
  } as unknown as NodePtyModule
  return { module, spawns }
}

class FakePty {
  readonly dataListeners: Array<(data: string) => void> = []
  readonly exitListeners: Array<(info: { exitCode: number; signal?: number }) => void> = []
  write = vi.fn()
  resize = vi.fn()
  kill = vi.fn()
  onData(fn: (data: string) => void): { dispose: () => void } {
    this.dataListeners.push(fn)
    return { dispose: () => {} }
  }
  onExit(fn: (info: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.exitListeners.push(fn)
    return { dispose: () => {} }
  }
  /** Emit data to every subscriber (the manager's transcript mirror). */
  emit(data: string): void {
    for (const fn of this.dataListeners) fn(data)
  }
  /** Fire the exit event (marks the manager's handle exited). */
  exit(code: number): void {
    for (const fn of this.exitListeners) fn({ exitCode: code })
  }
}

const STUB_ID = 'ws:11111111:1'
const OTHER_STUB_ID = 'ws:11111111:2'

describe('shared pty key mapping', () => {
  it('ws: stub ids map to a session-less shared key', () => {
    expect(isSharedTabId(STUB_ID)).toBe(true)
    expect(isSharedTabId('terminal:3')).toBe(false)
    expect(ptyKeyOf('session-a', STUB_ID)).toBe(`shared:${STUB_ID}`)
    expect(ptyKeyOf('session-a', 'terminal:3')).toBe('session-a:terminal:3')
    // Two sessions share ONE key for the same stub.
    expect(ptyKeyOf('session-b', STUB_ID)).toBe(ptyKeyOf('session-a', STUB_ID))
  })
})

describe('workspace-shared pty (bound terminals)', () => {
  it('two sessions opening the same ws: stub attach to the SAME process', () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const first = manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    const second = manager.open('session-b', STUB_ID, '/ws-a', 100, 40)

    expect(spawns).toHaveLength(1) // one process for the whole workspace
    expect(second).toBe(first)
    expect(second.key).toBe(`shared:${STUB_ID}`)
    expect(second.shared).toBe(true)
    // Output mirrored once into the shared transcript; both sees it.
    spawns[0]!.pty.emit('hello from the long-running process')
    expect(first.transcript).toContain('hello from the long-running process')
    manager.close(first.key)
  })

  it('a different session cwd never respawns a shared pty (first cwd wins)', () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const first = manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    const second = manager.open('session-b', STUB_ID, '/elsewhere', 80, 24)

    expect(spawns).toHaveLength(1)
    expect(second).toBe(first)
    expect(second.cwd).toBe('/ws-a')
    manager.close(first.key)
  })

  it('shared ptys never count toward a session quota', () => {
    const { module } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 1, module)
    manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    manager.open('session-b', STUB_ID, '/ws-a', 80, 24)

    // The per-session cap is 1: two LOCAL terminals must still be refused…
    manager.open('session-a', 'terminal:1', '/ws-a', 80, 24)
    expect(() => manager.open('session-a', 'terminal:2', '/ws-a', 80, 24)).toThrow(/limit reached/)
    // …but a second shared stub opens freely (workspace-level, no session).
    manager.open('session-a', OTHER_STUB_ID, '/ws-a', 80, 24)
    manager.close(`shared:${STUB_ID}`)
    manager.close(`shared:${OTHER_STUB_ID}`)
    manager.close('session-a:terminal:1')
  })

  it('a reconnected exited shared pty respawns a fresh shell', () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const first = manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    spawns[0]!.pty.exit(0)
    expect(first.exited).toBe(true)

    const reopened = manager.open('session-b', STUB_ID, '/ws-a', 80, 24)
    expect(spawns).toHaveLength(2)
    expect(reopened).not.toBe(first)
    expect(reopened.exited).toBe(false)
    manager.close(reopened.key)
  })

  it('close kills the shared process (window closed everywhere)', () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const handle = manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    manager.close(handle.key)
    expect(spawns[0]!.pty.kill).toHaveBeenCalledTimes(1)
    expect(manager.get(handle.key)).toBeUndefined()
  })

  it('scheduleClose on a shared key with a grace still kills after the timer', async () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const handle = manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    manager.scheduleClose(handle.key, 20)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(spawns[0]!.pty.kill).toHaveBeenCalledTimes(1)
  })

  it('a shared handle records the first session id but is excluded from its keys', () => {
    const { module } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    expect(manager.keysOf('session-a')).toEqual([])
    expect(manager.keysOf('session-b')).toEqual([])
    manager.close(`shared:${STUB_ID}`)
  })
})
