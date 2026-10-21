import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { attachWorkspaceTerminalWatch } from '../src/workspace-terminal-watch.ts'
import { resolveTerminalWorkspace } from '../src/workspace-terminal.ts'
import { SidebarError } from '../src/wire.ts'
vi.mock('../src/workspace-terminal.ts', () => ({ resolveTerminalWorkspace: vi.fn() }))
class Socket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  send = vi.fn()
  close = vi.fn((_code: number, _reason: string) => { this.readyState = 3; this.emit('close') })
}
const attach = (manager: unknown, ws: Socket, url = '/?sessionId=one') =>
  attachWorkspaceTerminalWatch({} as never, manager as never, ws as unknown as WebSocket, url)

describe('workspace metadata watch route', () => {
  it('resolves authoritative workspace, sends initial snapshot, and releases on close', async () => {
    const workspace = { key: 'local:one', cwd: '/authoritative' }
    vi.mocked(resolveTerminalWorkspace).mockResolvedValue(workspace)
    const off = vi.fn()
    const subscribe = vi.fn((_workspace, listener) => { listener({ revision: 1, terminals: [] }); return off })
    const ws = new Socket()
    await attach({ subscribe }, ws, '/?sessionId=one&cwd=/foreign')
    expect(resolveTerminalWorkspace).toHaveBeenLastCalledWith({}, 'one')
    expect(subscribe).toHaveBeenCalledWith(workspace, expect.any(Function))
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ revision: 1, terminals: [] }))
    ws.emit('close'); ws.emit('error')
    expect(off).toHaveBeenCalledTimes(1)
    subscribe.mock.calls[0]![1]({ revision: 2, terminals: [] })
    expect(ws.send).toHaveBeenCalledTimes(1)
  })
  it('does not subscribe after a socket closes during workspace resolution', async () => {
    let resolve!: (value: {key:string;cwd:string}) => void
    vi.mocked(resolveTerminalWorkspace).mockReturnValue(new Promise(done => { resolve = done }))
    const ws = new Socket(), subscribe = vi.fn()
    const pending = attach({ subscribe }, ws)
    ws.emit('close')
    resolve({ key: 'one', cwd: '/one' })
    await pending
    expect(subscribe).not.toHaveBeenCalled()
  })
  it('rejects missing sessions and policy errors, degrades missing PTY to empty snapshot', async () => {
    const missing = new Socket()
    await attach(null, missing, '/')
    expect(missing.close).toHaveBeenCalledWith(1008, 'sessionId is required')
    vi.mocked(resolveTerminalWorkspace).mockRejectedValueOnce(new SidebarError('bad-request', 'unavailable', 400))
    const refused = new Socket()
    await attach(null, refused)
    expect(refused.close).toHaveBeenCalledWith(1008, 'workspace-terminal-watch-unavailable')
    vi.mocked(resolveTerminalWorkspace).mockResolvedValue({ key: 'one', cwd: '/one' })
    const empty = new Socket()
    await attach(null, empty)
    expect(empty.send).toHaveBeenCalledWith(JSON.stringify({ revision: 0, terminals: [] }))
  })
  it('closes backpressured observers and releases even during synchronous initial delivery', async () => {
    vi.mocked(resolveTerminalWorkspace).mockResolvedValue({ key: 'one', cwd: '/one' })
    const off = vi.fn(), ws = new Socket()
    ws.bufferedAmount = 2 * 1024 * 1024
    await attach({ subscribe: (_workspace: unknown, listener: (value: unknown) => void) => {
      listener({ revision: 1, terminals: [] }); return off
    } }, ws)
    expect(ws.close).toHaveBeenCalledWith(1013, 'workspace-terminal-watch-backpressure')
    expect(off).toHaveBeenCalledTimes(1)
    expect(ws.send).not.toHaveBeenCalled()
  })
})
