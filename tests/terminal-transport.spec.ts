/**
 * localTransport tests: the default terminal connection layer (the exact
 * logic TerminalView inlined before the transport slot existed). The
 * behavior contract lives here — the upgrade URL (sessionId+tab+cwd for
 * UI tabs, uuid for agent tabs), the resize/close/park upstream frames,
 * the on-open terminal-mode reset, the 2s bounded reconnect loop with the
 * FAILURE_LIMIT=3 fatal banner, and the close-code interpretation (1011 +
 * pty-deps-missing → the repair-details fetch; 1011 + reason → server-side
 * refusal; anything else → counted failure).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/client/api.ts'
import { t } from '../src/client/locales.ts'
import { PTY_DEPS_MISSING, FAILURE_LIMIT, localTransport, parseDownlinkFrame, type TerminalDepsInfo, type TerminalTransportSession, type TerminalTransportSurface } from '../src/client/terminal-transport.ts'

/** Test double for the browser WebSocket (jsdom ships none). */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = FakeWebSocket.CLOSED }

  // Test helpers.
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.() }
  message(data: string): void { this.onmessage?.({ data }) }
  drop(code: number, reason: string): void { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code, reason, wasClean: code === 1000 }) }
  error(): void { this.onerror?.() }
}

/** The fake xterm surface (the transport only sees this slice). */
function fakeTerm(): TerminalTransportSurface & { write: ReturnType<typeof vi.fn<(data: string) => void>> } {
  return { write: vi.fn(), cols: 80, rows: 24 }
}

interface SessionHarness {
  term: TerminalTransportSurface & { write: ReturnType<typeof vi.fn<(data: string) => void>> }
  callbacks: {
    onOutput: ReturnType<typeof vi.fn<(data: string) => void>>
    onTitle: ReturnType<typeof vi.fn<(title: string, info?: { cwd?: string; command?: string }) => void>>
    onConnected: ReturnType<typeof vi.fn<(connected: boolean) => void>>
    onFatal: ReturnType<typeof vi.fn<(reason: string | null, detail?: { deps?: TerminalDepsInfo }) => void>>
    onEndpoint: ReturnType<typeof vi.fn<(endpoint: string) => void>>
  }
}

/** Open a local transport session against a fake scope; returns the session
 *  harness + the handle. */
function openSession(overrides: Partial<TerminalTransportSession> = {}): { handle: ReturnType<typeof localTransport.open>; h: SessionHarness } {
  const term = fakeTerm()
  const callbacks: SessionHarness['callbacks'] = {
    onOutput: vi.fn<(data: string) => void>(),
    onTitle: vi.fn<(title: string, info?: { cwd?: string; command?: string }) => void>(),
    onConnected: vi.fn<(connected: boolean) => void>(),
    onFatal: vi.fn<(reason: string | null, detail?: { deps?: TerminalDepsInfo }) => void>(),
    onEndpoint: vi.fn<(endpoint: string) => void>(),
  }
  const session: TerminalTransportSession = {
    term,
    scope: { sessionId: 's1', cwd: '/ws/project' },
    tabId: 'terminal:t1',
    cwd: '/ws/project',
    onOutput: callbacks.onOutput,
    onTitle: callbacks.onTitle,
    onConnected: callbacks.onConnected,
    onFatal: callbacks.onFatal,
    onEndpoint: callbacks.onEndpoint,
    ...overrides,
  }
  const handle = localTransport.open(session)
  return { handle, h: { term, callbacks } }
}

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
}

/** The upgrade URL parsed (searchParams decoded by the URL itself). */
function urlOf(socket: FakeWebSocket): URL {
  return new URL(socket.url)
}

beforeEach(() => {
  FakeWebSocket.instances = []
  ;(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).WebSocket
})

describe('localTransport', () => {
  it('connects a UI tab to /sidebar/ws/terminal with sessionId+tab+cwd and reports the endpoint', () => {
    const { handle, h } = openSession()
    const socket = lastSocket()
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING)
    const url = urlOf(socket)
    expect(url.protocol).toBe('ws:')
    expect(url.pathname).toBe('/sidebar/ws/terminal')
    expect(url.searchParams.get('sessionId')).toBe('s1')
    expect(url.searchParams.get('tab')).toBe('terminal:t1')
    expect(url.searchParams.get('cwd')).toBe('/ws/project')
    expect(h.callbacks.onEndpoint).toHaveBeenCalledWith(socket.url)
    handle.dispose()
  })

  it('connects an agent tab by uuid (no session/cwd query)', () => {
    const { handle } = openSession({ tabId: 'agent:u-1234' })
    const url = urlOf(lastSocket())
    expect(url.searchParams.get('uuid')).toBe('u-1234')
    expect(url.searchParams.get('sessionId')).toBeNull()
    expect(url.searchParams.get('cwd')).toBeNull()
    handle.dispose()
  })

  it('prefers the explicit cwd param over scope.cwd and omits it when empty', () => {
    const { handle } = openSession({ cwd: '/remote/ws' })
    expect(urlOf(lastSocket()).searchParams.get('cwd')).toBe('/remote/ws')
    handle.dispose()
    const { handle: h2 } = openSession({ scope: { sessionId: 's2' }, cwd: undefined })
    expect(urlOf(lastSocket()).searchParams.get('cwd')).toBeNull()
    h2.dispose()
  })

  it('on open: resets terminal modes, sends the resize frame, flips connected', () => {
    const { handle, h } = openSession()
    lastSocket().open()
    expect(h.callbacks.onConnected).toHaveBeenCalledWith(true)
    expect(h.term.write).toHaveBeenCalledWith('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l')
    const frames = lastSocket().sent.map(frame => JSON.parse(frame))
    expect(frames).toContainEqual({ type: 'resize', cols: 80, rows: 24 })
    handle.dispose()
  })

  it('forwards input and resize while open, dropping both once closed', () => {
    const { handle } = openSession()
    lastSocket().open()
    handle.input('ls -la\r')
    handle.resize(120, 30)
    expect(lastSocket().sent[lastSocket().sent.length - 2]).toBe('ls -la\r')
    expect(JSON.parse(lastSocket().sent[lastSocket().sent.length - 1]!)).toEqual({ type: 'resize', cols: 120, rows: 30 })
    handle.dispose()
    handle.input('after\r')
    handle.resize(10, 10)
    const frames = lastSocket().sent.filter(frame => frame.startsWith('{')).map(frame => JSON.parse(frame)).filter((frame: { type: string }) => frame.type === 'resize')
    // The on-open resize (80x24) + the explicit one; the post-dispose
    // resize(10,10) never made it out.
    expect(frames.map((frame: { cols: number }) => frame.cols)).toEqual([80, 120])
  })

  it('parses title frames into onTitle and streams everything else verbatim', () => {
    const { handle, h } = openSession()
    lastSocket().open()
    lastSocket().message('{"type":"title","title":"npm","command":"npm run dev","cwd":"/ws"}')
    expect(h.callbacks.onTitle).toHaveBeenCalledWith('npm', { cwd: '/ws', command: 'npm run dev' })
    lastSocket().message('npm run dev\r\n')
    expect(h.callbacks.onOutput).toHaveBeenCalledWith('npm run dev\r\n')
    // Output that merely looks like JSON is verbatim too.
    lastSocket().message('{"type":"resize","cols":80}')
    expect(h.callbacks.onOutput).toHaveBeenLastCalledWith('{"type":"resize","cols":80}')
    handle.dispose()
  })

  it('sends {type:"close"} on close() and {type:"park"} on park() (only while open)', () => {
    const { handle } = openSession()
    expect(lastSocket().sent).toHaveLength(0)
    handle.park()
    expect(lastSocket().sent).toHaveLength(0)
    handle.close()
    expect(lastSocket().sent).toHaveLength(0)
    lastSocket().open()
    handle.close()
    handle.park()
    const frames = lastSocket().sent.map(frame => JSON.parse(frame))
    expect(frames).toEqual([
      { type: 'resize', cols: 80, rows: 24 },
      { type: 'close' },
      { type: 'park' },
    ])
    handle.dispose()
    handle.close()
    handle.park()
    expect(lastSocket().sent.map(frame => JSON.parse(frame)).filter((frame: { type: string }) => frame.type === 'close' || frame.type === 'park')).toHaveLength(2)
  })

  it('dispose(): bare drop — closes the socket, stops the reconnect loop', () => {
    const { handle, h } = openSession()
    lastSocket().open()
    handle.dispose()
    expect(lastSocket().readyState).toBe(FakeWebSocket.CLOSED)
    expect(h.callbacks.onConnected).toHaveBeenCalledTimes(1) // no onclose flip after dispose
    // No reconnect timer survives dispose.
    vi.advanceTimersByTime(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('close-code 1011 + pty-deps-missing fetches repair details and reports the deps banner payload', async () => {
    const spy = vi.spyOn(api, 'terminalDeps').mockResolvedValue({
      ok: false,
      cause: 'Cannot find package node-pty',
      command: 'bash install.sh --repair',
      profile: 'web',
    })
    const { handle, h } = openSession()
    lastSocket().open()
    lastSocket().drop(1011, PTY_DEPS_MISSING)
    expect(h.callbacks.onConnected).toHaveBeenLastCalledWith(false)
    expect(spy).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.callbacks.onFatal).toHaveBeenCalledWith(null, {
      deps: { ok: false, cause: 'Cannot find package node-pty', command: 'bash install.sh --repair', profile: 'web' },
    })
    handle.dispose()
  })

  it('...and falls back to the plain banner when the host recovered or the fetch failed', async () => {
    const ok = vi.spyOn(api, 'terminalDeps').mockResolvedValue({ ok: true })
    const { handle: h1, h: hh1 } = openSession()
    lastSocket().open()
    lastSocket().drop(1011, PTY_DEPS_MISSING)
    await vi.advanceTimersByTimeAsync(0)
    expect(hh1.callbacks.onFatal).toHaveBeenCalledWith(t('terminalDepsFailed'))
    h1.dispose()

    const failing = vi.spyOn(api, 'terminalDeps').mockRejectedValue(new Error('network down'))
    const { handle: h2, h: hh2 } = openSession()
    lastSocket().open()
    lastSocket().drop(1011, PTY_DEPS_MISSING)
    await vi.advanceTimersByTimeAsync(0)
    expect(hh2.callbacks.onFatal).toHaveBeenCalledWith(t('terminalDepsFailed'))
    h2.dispose()
    void ok; void failing
  })

  it('1011 + an explicit reason is a server-side refusal: surfaced once, no reconnect loop', () => {
    const { handle, h } = openSession()
    lastSocket().open()
    lastSocket().drop(1011, 'spawn /bin/sh ENOENT')
    expect(h.callbacks.onFatal).toHaveBeenCalledWith('spawn /bin/sh ENOENT')
    vi.advanceTimersByTime(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    handle.dispose()
  })

  it(`reconnects after ${FAILURE_LIMIT - 1} unreasoned drops, then shows the close-code banner`, () => {
    const { handle, h } = openSession()
    lastSocket().drop(1006, '')
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(2000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(h.callbacks.onEndpoint).toHaveBeenCalledTimes(2)
    lastSocket().drop(1006, '')
    vi.advanceTimersByTime(2000)
    expect(FakeWebSocket.instances).toHaveLength(3)
    lastSocket().drop(1006, '')
    expect(h.callbacks.onFatal).toHaveBeenCalledWith(expect.stringContaining('1006'))
    // The loop is dead; nothing more to try.
    vi.advanceTimersByTime(10_000)
    expect(FakeWebSocket.instances).toHaveLength(3)
    handle.dispose()
  })

  it('retry(): one fresh attempt that keeps the failure counter (parity with the old connect() retry)', () => {
    const { handle, h } = openSession()
    for (let i = 0; i < FAILURE_LIMIT; i += 1) {
      lastSocket().drop(1006, '')
      vi.advanceTimersByTime(2000)
    }
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(FAILURE_LIMIT)
    expect(handle.retry).toBeDefined()
    handle.retry?.()
    const count = FakeWebSocket.instances.length
    expect(FakeWebSocket.instances[count - 1]!.readyState).toBe(FakeWebSocket.CONNECTING)
    lastSocket().drop(1006, '')
    // Still over the limit → fatal again immediately, no timer restarted.
    expect(h.callbacks.onFatal).toHaveBeenLastCalledWith(expect.stringContaining('1006'))
    vi.advanceTimersByTime(10_000)
    expect(FakeWebSocket.instances).toHaveLength(count)
    handle.dispose()
  })
})

describe('parseDownlinkFrame', () => {
  it('parses title frames, ignores everything else, bound at 512 chars', () => {
    expect(parseDownlinkFrame('{"type":"title","title":"npm"}')).toEqual({ type: 'title', title: 'npm' })
    expect(parseDownlinkFrame('{"type":"title","title":"npm","command":"npm run dev","cwd":"/ws/code-agent-link"}'))
      .toEqual({ type: 'title', title: 'npm', command: 'npm run dev', cwd: '/ws/code-agent-link' })
    expect(parseDownlinkFrame('npm run dev\r\n')).toBeNull()
    expect(parseDownlinkFrame('')).toBeNull()
    expect(parseDownlinkFrame('{"type":"resize","cols":80}')).toBeNull()
    expect(parseDownlinkFrame('{"type":"title"}')).toBeNull()
    expect(parseDownlinkFrame('{"type":"title","title":5}')).toBeNull()
    expect(parseDownlinkFrame(`{"type":"title","title":"${'x'.repeat(600)}"}`)).toBeNull()
  })

  it('title frames with sparse info keep the info bar fields optional', () => {
    expect(parseDownlinkFrame('{"type":"title","title":"vim","cwd":"/ws"}'))
      .toEqual({ type: 'title', title: 'vim', cwd: '/ws' })
    // An empty-string command is still a string field — kept verbatim
    // (matches the pre-slot parser byte for byte).
    expect(parseDownlinkFrame('{"type":"title","title":"vim","command":""}'))
      .toEqual({ type: 'title', title: 'vim', command: '' })
  })
})