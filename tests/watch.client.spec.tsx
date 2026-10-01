// @vitest-environment jsdom
/**
 * Client side of the file-tree live refresh: useDirectoryWatch's socket
 * lifetime. The server watcher set is covered by fs-watch.spec.ts; this
 * suite pins the client contract — one socket per session, watch frames for
 * the expanded set, silent teardown when the tree unmounts mid-handshake.
 *
 * The fake Socket implements Chromium's teardown law: close() on a
 * CONNECTING socket throws InvalidStateError, so a regression to the
 * unconditional close-in-cleanup fails these tests the way the real
 * browser console did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { useDirectoryWatch, type DirectoryWatchOptions } from '../src/client/use-dir-watch.ts'

setupReactAct()

class Socket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: Socket[] = []
  readonly url: string
  readyState = Socket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  send = vi.fn()
  close = vi.fn(() => {
    if (this.readyState === Socket.CONNECTING) {
      // Chromium: "WebSocket is closed before the connection is established".
      throw new Error('WebSocket is closed before the connection is established')
    }
    if (this.readyState === Socket.CLOSED) return
    this.readyState = Socket.CLOSED
    this.onclose?.()
  })
  constructor(url: string) {
    this.url = url
    Socket.instances.push(this)
  }
}

function Probe(options: DirectoryWatchOptions): null {
  useDirectoryWatch(options)
  return null
}

const baseOptions = (onStale: (dir: string) => void) => ({
  sessionId: 'S',
  root: '/work',
  dirs: ['/work/a'],
  onStale,
})

function openLatest(): Socket {
  const socket = Socket.instances.at(-1)!
  socket.readyState = Socket.OPEN
  act(() => { socket.onopen?.() })
  return socket
}

/** Simulate the server dropping the connection. */
function drop(socket: Socket): void {
  socket.readyState = Socket.CLOSED
  act(() => { socket.onclose?.() })
}

const sent = (socket: Socket) => socket.send.mock.calls.map(call => JSON.parse(String(call[0])))

beforeEach(() => {
  Socket.instances = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('useDirectoryWatch socket lifetime', () => {
  it('opens one socket per session and watches the expanded set on open', () => {
    const onStale = vi.fn()
    const rendered = renderRoot(createElement(Probe, baseOptions(onStale)))
    const socket = Socket.instances[0]!
    expect(new URL(socket.url).searchParams.get('sessionId')).toBe('S')
    expect(socket.send).not.toHaveBeenCalled()

    openLatest()
    expect(sent(socket)).toEqual([
      { op: 'watch', path: '/work' },
      { op: 'watch', path: '/work/a' },
    ])

    // The server confirms what it watches; a stale frame names a directory
    // whose listing is dropped, exactly once per notice.
    act(() => { socket.onmessage?.({ data: JSON.stringify({ dir: '/work/a', ok: true }) }) })
    act(() => { socket.onmessage?.({ data: JSON.stringify({ dir: '/work/a' }) }) })
    expect(onStale).toHaveBeenCalledWith('/work/a')
    expect(onStale).toHaveBeenCalledTimes(1)

    // Collapsing a folder un-watches it on the next expanded-set change;
    // a refusals frame (ok: false) is not treated as a stale notice.
    act(() => { socket.onmessage?.({ data: JSON.stringify({ dir: '/work/b', ok: false }) }) })
    rendered.rerender(createElement(Probe, { ...baseOptions(onStale), dirs: [] }))
    expect(sent(socket).slice(-2)).toEqual([
      { op: 'watch', path: '/work' },
      { op: 'unwatch', path: '/work/a' },
    ])
    expect(onStale).toHaveBeenCalledTimes(1)
    rendered.unmount()
  })

  it('unmounts silently while the socket is still CONNECTING', () => {
    const rendered = renderRoot(createElement(Probe, baseOptions(vi.fn())))
    const socket = Socket.instances[0]!
    expect(socket.readyState).toBe(Socket.CONNECTING)
    expect(() => rendered.unmount()).not.toThrow()
    expect(socket.close).not.toHaveBeenCalled()
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('tears down a socket that opens after unmount without sending watch frames', () => {
    const rendered = renderRoot(createElement(Probe, baseOptions(vi.fn())))
    const socket = Socket.instances[0]!
    rendered.unmount()
    // The handshake completes after the cleanup: close is legal now, and the
    // unmounted tree must never hear a watch frame.
    socket.readyState = Socket.OPEN
    act(() => { socket.onopen?.() })
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('drops stale frames that land after unmount', () => {
    const onStale = vi.fn()
    const rendered = renderRoot(createElement(Probe, baseOptions(onStale)))
    const socket = openLatest()
    rendered.unmount()
    expect(socket.close).toHaveBeenCalled()
    act(() => { socket.onmessage?.({ data: JSON.stringify({ dir: '/work/a' }) }) })
    expect(onStale).not.toHaveBeenCalled()
  })

  it('leaves a mid-handshake socket inert when the session switches', () => {
    const onStale = vi.fn()
    const rendered = renderRoot(createElement(Probe, baseOptions(onStale)))
    const first = Socket.instances[0]!
    rendered.rerender(createElement(Probe, { ...baseOptions(onStale), sessionId: 'T' }))
    expect(Socket.instances).toHaveLength(2)
    const second = Socket.instances[1]!

    // The old handshake completes after the switch: it closes itself without
    // ever reconciling the abandoned session's tree.
    first.readyState = Socket.OPEN
    act(() => { first.onopen?.() })
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(first.send).not.toHaveBeenCalled()
    act(() => { first.onmessage?.({ data: JSON.stringify({ dir: '/work/a' }) }) })
    expect(onStale).not.toHaveBeenCalled()

    // The new session's socket still reconciles normally.
    expect(second.send).not.toHaveBeenCalled()
    second.readyState = Socket.OPEN
    act(() => { second.onopen?.() })
    expect(sent(second)).toEqual([
      { op: 'watch', path: '/work' },
      { op: 'watch', path: '/work/a' },
    ])
    rendered.unmount()
  })

  it('reconnects with backoff capped at RETRY_MAX_MS and resubscribes on open', () => {
    const rendered = renderRoot(createElement(Probe, baseOptions(vi.fn())))
    let socket = openLatest()
    // RETRY_BASE_MS doubling to the cap: 1s, 2s, 4s, 8s, then 15s forever.
    const delays = [1000, 2000, 4000, 8000, 15_000, 15_000]
    const seen: number[] = []
    for (const delay of delays) {
      drop(socket)
      vi.advanceTimersByTime(delay - 1)
      expect(Socket.instances).toHaveLength(seen.length + 1)
      vi.advanceTimersByTime(1)
      seen.push(Socket.instances.length)
      socket = Socket.instances.at(-1)!
    }
    expect(seen).toEqual([2, 3, 4, 5, 6, 7])

    // An open resets the failure counter: the next drop waits RETRY_BASE_MS
    // again, not the cap.
    socket.readyState = Socket.OPEN
    act(() => { socket.onopen?.() })
    expect(sent(socket)).toEqual([
      { op: 'watch', path: '/work' },
      { op: 'watch', path: '/work/a' },
    ])
    drop(socket)
    vi.advanceTimersByTime(999)
    expect(Socket.instances).toHaveLength(7)
    vi.advanceTimersByTime(1)
    expect(Socket.instances).toHaveLength(8)
    rendered.unmount()
  })

  it('unmounting mid-backoff cancels the scheduled reconnect', () => {
    const rendered = renderRoot(createElement(Probe, baseOptions(vi.fn())))
    const socket = openLatest()
    drop(socket)
    rendered.unmount()
    vi.advanceTimersByTime(120_000)
    expect(Socket.instances).toHaveLength(1)
  })
})