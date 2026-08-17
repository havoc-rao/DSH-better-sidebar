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

describe('pty re-parenting (bind/unbind keep the process alive)', () => {
  it('bind direction: a session pty moves to the shared key, same process', () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const local = manager.open('session-a', 'terminal:1', '/ws-a', 80, 24)
    spawns[0]!.pty.emit('running npm run dev…')
    expect(local.title).toBe('') // not digested here; transcript is what matters

    const moved = manager.reparent('session-a:terminal:1', `shared:${STUB_ID}`, 'session-a', true)

    expect(moved).toBe(true)
    expect(manager.get('session-a:terminal:1')).toBeUndefined()
    const shared = manager.get(`shared:${STUB_ID}`)!
    expect(shared).toBe(local) // SAME handle: same process, transcript intact
    expect(shared.key).toBe(`shared:${STUB_ID}`)
    expect(shared.shared).toBe(true)
    expect(shared.migrated).toBe(true)
    expect(shared.transcript).toContain('running npm run dev…')
    expect(spawns[0]!.pty.kill).not.toHaveBeenCalled() // nothing killed
    // The stub attaches from any session of the workspace to that process.
    expect(manager.open('session-b', STUB_ID, '/elsewhere', 80, 24)).toBe(local)
    expect(spawns).toHaveLength(1)
    manager.close(`shared:${STUB_ID}`)
  })

  it('unbind direction: a shared pty moves to the session key and counts toward its quota', () => {
    const { module } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 1, module)
    manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    // Before unbind the shared pty is quota-exempt…
    expect(manager.keysOf('session-a')).toEqual([])

    const moved = manager.reparent(`shared:${STUB_ID}`, 'session-a:terminal:9', 'session-a', false)

    expect(moved).toBe(true)
    const local = manager.get('session-a:terminal:9')!
    expect(local.shared).toBe(false)
    expect(local.sessionId).toBe('session-a')
    expect(local.migrated).toBe(true)
    // …after unbind it is a session terminal: counted in keysOf, so the
    // per-session cap is now exhausted (a second local terminal is refused).
    expect(manager.keysOf('session-a')).toEqual(['session-a:terminal:9'])
    expect(() => manager.open('session-a', 'terminal:2', '/ws-a', 80, 24)).toThrow(/limit reached/)
    manager.close('session-a:terminal:9')
  })

  it('a migrated handle survives an open() with a different cwd (no respawn)', () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const shared = manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    manager.reparent(`shared:${STUB_ID}`, 'session-a:terminal:9', 'session-a', false)

    // The unbinding session's cwd differs from the pty's spawn cwd: the
    // migrated process must NOT be respawned (it was spawned deliberately
    // in /ws-a and the tab-id change is not a reason to restart it).
    const attached = manager.open('session-a', 'terminal:9', '/elsewhere', 80, 24)
    expect(attached).toBe(shared)
    expect(spawns).toHaveLength(1)
    expect(attached.cwd).toBe('/ws-a')
    manager.close('session-a:terminal:9')
  })

  it('a NON-migrated per-session handle still respawns on a cwd change', () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const first = manager.open('session-a', 'terminal:1', '/ws-a', 80, 24)
    expect(first.migrated).toBeUndefined()

    const reopened = manager.open('session-a', 'terminal:1', '/elsewhere', 80, 24)
    expect(spawns).toHaveLength(2)
    expect(reopened).not.toBe(first)
    expect(reopened.cwd).toBe('/elsewhere')
    manager.close('session-a:terminal:1')
  })

  it('reparent cancels a pending grace close (the process survives the timer)', async () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const local = manager.open('session-a', 'terminal:1', '/ws-a', 80, 24)
    manager.scheduleClose('session-a:terminal:1', 20) // bare socket drop, grace pending
    expect(manager.reparent('session-a:terminal:1', `shared:${STUB_ID}`, 'session-a', true)).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 60))
    expect(spawns[0]!.pty.kill).not.toHaveBeenCalled()
    expect(manager.get(`shared:${STUB_ID}`)).toBe(local)
    manager.close(`shared:${STUB_ID}`)
  })

  it('reparent with no source handle is a no-op (the new tab spawns fresh)', () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    expect(manager.reparent('session-a:terminal:1', `shared:${STUB_ID}`, 'session-a', true)).toBe(false)
    expect(spawns).toHaveLength(0)

    const fresh = manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    expect(spawns).toHaveLength(1)
    expect(fresh.migrated).toBeUndefined()
    manager.close(fresh.key)
  })

  it('an exited handle migrates and the new attach respawns fresh (status quo for dead shells)', () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const shared = manager.open('session-a', STUB_ID, '/ws-a', 80, 24)
    spawns[0]!.pty.exit(0)
    expect(manager.reparent(`shared:${STUB_ID}`, 'session-a:terminal:9', 'session-a', false)).toBe(true)

    const reopened = manager.open('session-a', 'terminal:9', '/ws-a', 80, 24)
    expect(spawns).toHaveLength(2)
    expect(reopened).not.toBe(shared)
    expect(reopened.exited).toBe(false)
    manager.close('session-a:terminal:9')
  })

  it('round trip local → shared → local keeps ONE process end to end', () => {
    const { module, spawns } = fakeNodePty()
    const manager = new PtyManager('/bin/fake', 3, module)
    const original = manager.open('session-a', 'terminal:1', '/ws-a', 80, 24)
    spawns[0]!.pty.emit('server listening on :3000')

    manager.reparent('session-a:terminal:1', `shared:${STUB_ID}`, 'session-a', true)
    expect(spawns).toHaveLength(1)
    const viaStub = manager.open('session-b', STUB_ID, '/ws-a', 80, 24)
    expect(viaStub).toBe(original)

    manager.reparent(`shared:${STUB_ID}`, 'session-a:terminal:9', 'session-a', false)
    expect(spawns).toHaveLength(1)
    const back = manager.open('session-a', 'terminal:9', '/ws-a', 80, 24)
    expect(back).toBe(original)
    expect(back.transcript).toContain('server listening on :3000')
    manager.close('session-a:terminal:9')
  })
})
