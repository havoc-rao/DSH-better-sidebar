// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchWorkspaceTerminals } from '../src/client/workspace-terminal-watch.ts'
class Socket {
  static CONNECTING = 0
  static all: Socket[] = []
  readyState = 0
  onopen?: () => void
  onmessage?: (event: { data: unknown }) => void
  onclose?: (event: { code: number; reason: string }) => void
  close = vi.fn(() => { this.readyState = 3 })
  constructor(readonly url: string) { Socket.all.push(this) }
  open() { this.readyState = 1; this.onopen?.() }
  frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  drop(code = 1006, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }) }
}
const info = { terminalId: 'one', title: 'Shell', cwd: '/work', createdBySessionId: 'A', createdAt: 1, exited: false }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Socket.all = [] })
function setup() { vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket) }
describe('workspace terminal event wire', () => {
  it('validates snapshots, orders frames and accepts a new reconnect baseline', () => {
    setup()
    const snapshot = vi.fn(); const off = watchWorkspaceTerminals('A & B', snapshot)
    const first = Socket.all[0]!
    expect(new URL(first.url).pathname).toBe('/sidebar/ws/workspace-terminals')
    expect(new URL(first.url).searchParams.get('sessionId')).toBe('A & B')
    first.open()
    for (const frame of [null, {}, { revision: 1, terminals: [null] }, { revision: 1, terminals: [{ ...info, title: 1 }] }, { revision: 1, terminals: [{ ...info, runningCommands: [3] }] }]) first.frame(frame)
    expect(snapshot).not.toHaveBeenCalled()
    first.frame({ revision: 100, terminals: [{ ...info, exitCode: null }] }); first.frame({ revision: 99, terminals: [] })
    expect(snapshot).toHaveBeenCalledExactlyOnceWith({ terminals: [{ ...info, exitCode: null }] })
    first.drop(); vi.advanceTimersByTime(1000)
    const second = Socket.all[1]!
    second.open(); second.frame({ revision: 0, terminals: [] }); first.frame({ revision: 101, terminals: [info] })
    expect(snapshot).toHaveBeenCalledTimes(2); expect(snapshot).toHaveBeenLastCalledWith({ terminals: [] })
    off()
  })
  it('bounds exponential retry and stops on policy refusal', () => {
    setup()
    const error = vi.fn(); const off = watchWorkspaceTerminals('A', vi.fn(), error)
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
      const previous = Socket.all.length
      Socket.all.at(-1)!.open(); Socket.all.at(-1)!.drop(1013)
      vi.advanceTimersByTime(delay - 1); expect(Socket.all).toHaveLength(previous)
      vi.advanceTimersByTime(1); expect(Socket.all).toHaveLength(previous + 1)
    }
    Socket.all.at(-1)!.drop(1008, 'workspace-terminal-watch-unavailable')
    expect(error.mock.calls.at(-1)![0]).toMatchObject({ code: 'FORBIDDEN', status: 403, retryable: false })
    expect(error.mock.calls.at(-1)![0].message).toContain('workspace-terminal-watch-unavailable')
    const count = Socket.all.length; vi.advanceTimersByTime(120_000); expect(Socket.all).toHaveLength(count)
    off()
  })
  it('disposes connecting sockets on eventual open and suppresses callbacks/retries', () => {
    setup()
    const snapshot = vi.fn(); const error = vi.fn(); const off = watchWorkspaceTerminals('A', snapshot, error)
    const socket = Socket.all[0]!; off(); expect(socket.close).not.toHaveBeenCalled()
    socket.frame({ revision: 1, terminals: [info] }); socket.open(); socket.drop(1008)
    expect(socket.close).toHaveBeenCalledOnce(); expect(snapshot).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
    vi.advanceTimersByTime(120_000); expect(Socket.all).toHaveLength(1)
  })
  it('cancels pending reconnect on unsubscribe', () => {
    setup()
    const off = watchWorkspaceTerminals('A', vi.fn()); Socket.all[0]!.drop(); off()
    vi.advanceTimersByTime(120_000); expect(Socket.all).toHaveLength(1)
  })
})
