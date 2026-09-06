/**
 * Terminal transport layer: the injectable connection slot behind
 * TerminalView. The view renders xterm + block dividers + selection popup +
 * info bar + banners and delegates EVERYTHING about "who provides the bytes"
 * to a {@link TerminalTransport}: the default {@link localTransport} speaks
 * WebSocket to this plugin's host pty manager (exactly the behavior
 * TerminalView always had, byte for byte), and a consumer plugin (e.g.
 * dsh-remote) injects its own transport — a remote SSH PTY channel — through
 * TerminalView's `transport` prop, without touching the view's UI or
 * interactions.
 *
 * This file lives in the CORE bundle (no xterm runtime import: the terminal
 * surface is typed structurally, see {@link TerminalTransportSurface}), so
 * both the core client exports and the lazy terminal chunk can import it.
 * The slot is generic — there is no dsh-remote (or any other plugin)
 * dependency here. Cross-plugin consumers resolve the symbols through the
 * client module system (`ctx.modules.import('dsh-better-sidebar')`) or copy
 * the file into their own bundle (it is dependency-light by design).
 */
import { api, type SessionScope, type TerminalDepsStatus } from './api.ts'
import { t } from './locales.ts'
import { agentUuidOf, isAgentTabId, type SidebarStore } from './state.ts'
import type { Context } from '../context-types.ts'

/** How many consecutive unreasoned failures before surfacing the error banner. */
export const FAILURE_LIMIT = 3

/**
 * The WS close-code-1011 reason the host sends when node-pty is unavailable
 * (mirror of the host's PTY_DEPS_MISSING; the value is a wire contract, so
 * the two sides keep the literal in lockstep). LOCAL-transport-only: the
 * view raises the pty-deps repair banner only when the default transport
 * reports this — a remote transport never triggers it.
 */
export const PTY_DEPS_MISSING = 'pty-deps-missing'

/** The terminal-deps status record reduced to its failure shape (deps.ok ===
 *  false carries `command`, `profile` and `note` — the banner's content). */
export type TerminalDepsInfo = Extract<TerminalDepsStatus, { ok: false }>

/**
 * The write-only slice of the xterm instance a transport may touch. The
 * view owns everything else (onData, selection, fit, theme, block tracker);
 * this surface exists so transports can inject bytes (the shell-mode resets
 * on connect, a "connecting…" banner) and read the current grid for their
 * resize frames. Typed structurally so the transport contract carries NO
 * xterm dependency — a consumer plugin types against it without installing
 * @xterm/xterm just for the types (the real Terminal satisfies it).
 */
export interface TerminalTransportSurface {
  /** Append raw data to the terminal buffer (never called after dispose). */
  write(data: string): void
  /** The current grid dimensions (transports size their channel from these). */
  readonly cols: number
  readonly rows: number
}

/**
 * The per-mount session contract handed to {@link TerminalTransport.open}.
 * One open() per view mount; the returned handle is the view's only channel
 * back into the transport until unmount.
 */
export interface TerminalTransportSession {
  /** The terminal surface the transport may write into. */
  term: TerminalTransportSurface
  /** The session scope this terminal belongs to. */
  scope: SessionScope
  /** The tab id; `agent:`-prefixed ids are agent-owned terminals (the local
   *  transport attaches them by uuid and never parks them — their lifetime
   *  belongs to the agent). */
  tabId: string
  /** Working-directory hint (the local pty spawns here; a remote transport
   *  uses it as the remote start dir). */
  cwd?: string
  /** Raw downlink bytes → written into the terminal buffer verbatim. */
  onOutput(data: string): void
  /** A title frame → the tab retitles AND the info bar updates (cwd +
   *  running CLI). Call with `info` undefined to retitle only, leaving the
   *  info bar untouched. */
  onTitle?(title: string, info?: { cwd?: string; command?: string }): void
  /** Connection-state flips (the view's disconnected banner and the block
   *  overlay's visibility ride this). */
  onConnected?(connected: boolean): void
  /** An unrecoverable failure → the view's fatal banner + retry button.
   *  `detail.deps` (set only by the LOCAL transport's pty-deps-missing
   *  path) raises the repair banner instead. */
  onFatal?(reason: string | null, detail?: { deps?: TerminalDepsInfo }): void
  /** The endpoint the current attempt targets (the fatal banner's URL line;
   *  the local transport reports its WS url). */
  onEndpoint?(endpoint: string): void
}

/**
 * A connection layer behind TerminalView. An implementation owns the socket /
 * channel lifecycle, the reconnect loop, downlink frame parsing and the
 * upstream control frames; the view only renders the state transitions the
 * callbacks report and forwards input/resize.
 */
export interface TerminalTransport {
  /** What kind of channel this is ('local-pty-ws', 'remote-ssh-pty', …) —
   *  diagnostic only. */
  readonly kind: string
  /** Open one terminal session; returns the handle the view drives until
   *  unmount. One handle per view mount — the view calls open() exactly
   *  once per mount (plus once more per banner retry when the handle has no
   *  `retry`). A transport may reuse internal connections across handles. */
  open(session: TerminalTransportSession): TerminalTransportHandle
}

/**
 * The view's handle onto one open session (returned by
 * {@link TerminalTransport.open}).
 */
export interface TerminalTransportHandle {
  /** Forward one input chunk (the view feeds its block tracker first). */
  input(data: string): void
  /** The grid changed (xterm opened / fit / visibility re-fit). */
  resize(cols: number, rows: number): void
  /** The user closed the tab → kill the session immediately. */
  close(): void
  /** The user switched conversations (the tab stays open there) → keep the
   *  session alive for reattach. */
  park(): void
  /** The view unmounted — tear the channel down. Called AFTER the close /
   *  park decision; bare dispose() (no close/park) is the same-session
   *  unmount case (page refresh, re-render). */
  dispose(): void
  /** The user hit the banner's retry — re-establish the connection. Absent:
   *  the view disposes the handle and calls open() again. */
  retry?(): void
}

/**
 * TerminalView's props — the shared definition, so core-bundle code, the
 * lazy terminal chunk and cross-plugin consumers (dsh-remote) all agree on
 * the same shape. The full component lives in the lazy chunk (xterm is not
 * in the core bundle); consumer plugins get it via
 * `loadTerminalView()` (the client exports) and pass `transport` to swap
 * the connection layer.
 */
export interface TerminalViewProps {
  /** The client context (the "add to conversation" draft lives on it). */
  ctx: Context
  /** The session scope this tab belongs to. */
  scope: SessionScope
  /** The tab id (`agent:`-prefixed ids are agent-owned terminals). */
  tabId: string
  /** The sidebar store (block model extents, tab-open state for unmount
   *  triage, font prefs). */
  store: SidebarStore
  /** Host-downlink command-title updates; routes through updateTab so the
   *  tab title follows the running command's first token. */
  onTitleChange?: (title: string) => void
  /** Whether the tab is the active one with the panel open; hidden tabs
   *  re-fit + repaint on the way back to visible. */
  visible?: boolean
  /** Render the box's info bar (cwd + running CLI) above the terminal. */
  infoBar?: boolean
  /** The connection layer behind this terminal. Absent → localTransport
   *  (the local pty WS — the historical behavior, byte for byte). Read ONCE
   *  at mount: pass a stable instance; swapping requires remounting. */
  transport?: TerminalTransport
}

/**
 * Parse one host-downlink control frame. The `title` frame today carries
 * {type:'title', title, command, cwd} (the info bar's running CLI + project
 * dir); anything else — including terminal output that merely looks like
 * JSON — returns null and is written verbatim. Bounded length and a
 * leading-`{` fast path so high-volume program output never pays a
 * JSON.parse per chunk.
 *
 * Exported (from the chunk AND the client exports) so a custom transport
 * implementing the same frame protocol can reuse it.
 */
export function parseDownlinkFrame(data: string): { type: 'title'; title: string; command?: string; cwd?: string } | null {
  if (data.length > 512 || data.charCodeAt(0) !== 0x7b) return null // '{'
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (record.type === 'title' && typeof record.title === 'string') {
      return {
        type: 'title',
        title: record.title,
        ...(typeof record.command === 'string' ? { command: record.command } : {}),
        ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * The default connection layer: a WebSocket to the host's local pty — the
 * same /sidebar/ws/terminal upgrade endpoint, frame protocol, reconnect
 * loop and close-code semantics TerminalView always used. The logic lives
 * here — OUTSIDE the view — so a consumer can inject a different transport
 * without touching the view; the default view behavior stays identical
 * because this is exactly the code the view inlined before the slot existed.
 *
 * Lifecycle semantics owned by this transport:
 * - upstream `{type:'close'|'park'|'resize'}` frames (the view only decides
 *   WHICH branch applies on unmount; the transport implements what each
 *   frame means for the pty),
 * - bare socket drop (no frame) on same-session unmount → the host's
 *   reconnect grace keeps the shell alive,
 * - agent terminals (`agent:` tab ids) attach by uuid and never park,
 * - close-code interpretation: 1011 + PTY_DEPS_MISSING → the pty-deps
 *   repair path (LOCAL-transport-only; remote transports never report it),
 *   1011 + a reason → server-side refusal surfaced with a retry, repeated
 *   unreasoned failures (>= FAILURE_LIMIT) → the close-code banner (the
 *   loop never spins forever).
 */
export const localTransport: TerminalTransport = {
  kind: 'local-pty-ws',
  open(session: TerminalTransportSession): TerminalTransportHandle {
    const { term, scope, tabId, cwd, onOutput, onTitle, onConnected, onFatal, onEndpoint } = session
    const effectiveCwd = cwd !== undefined ? cwd : scope.cwd
    let socket: WebSocket | null = null
    let closed = false
    let retry: number | undefined
    let failures = 0

    /** The upgrade URL: agent terminals attach by uuid (the host looks them
     *  up in the agent pty registry); UI-tab terminals attach by
     *  sessionId+tab (the host uses the UI-tab pty manager). Same endpoint,
     *  different query. Same construction the app's own downlink
     *  WebSockets use (new URL over location.origin + protocol swap). */
    const wsUrl = (): string => {
      const url = new URL('/sidebar/ws/terminal', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      if (isAgentTabId(tabId)) {
        url.search = new URLSearchParams({ uuid: agentUuidOf(tabId) }).toString()
      } else {
        const params = new URLSearchParams({ sessionId: scope.sessionId, tab: tabId })
        if (effectiveCwd !== undefined && effectiveCwd !== '') params.set('cwd', effectiveCwd)
        url.search = params.toString()
      }
      return url.toString()
    }

    /** One upstream control frame, sent only while the socket is open. */
    const send = (frame: unknown): void => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame))
      }
    }

    const connect = (): void => {
      if (closed) return
      const url = wsUrl()
      onEndpoint?.(url)
      socket = new WebSocket(url)
      socket.onopen = () => {
        failures = 0
        onConnected?.(true)
        // Reset stale terminal modes (mouse tracking normal/button/any-event,
        // SGR extended mouse, bracketed paste) IN THE XTERM INSTANCE itself —
        // ported from tabby's resetTerminalModes (it writes into the
        // frontend, not the session). A fresh instance no-ops; a reused
        // instance that a previous program left in mouse/bracketed-paste
        // mode stops leaking escape sequences into the shell (e.g. after the
        // host respawned the pty for a cwd change or an exited handle).
        term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l')
        send({ type: 'resize', cols: term.cols, rows: term.rows })
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        // Host downlink control frames ({type:'title',…}) are intercepted;
        // anything else — including terminal output that merely looks like
        // JSON — is written verbatim.
        const frame = parseDownlinkFrame(event.data)
        if (frame !== null) {
          if (frame.type === 'title') onTitle?.(frame.title, { cwd: frame.cwd, command: frame.command })
          return
        }
        onOutput(event.data)
      }
      socket.onclose = (event) => {
        onConnected?.(false)
        // node-pty dependency missing/broken (issue #140): the host closed
        // with the short marker. Fetch the full repair details over HTTP —
        // a WS close reason is capped at 123 bytes, too small for the
        // pasteable command. A failed fetch falls back to the plain banner.
        if (event.code === 1011 && event.reason === PTY_DEPS_MISSING) {
          void api.terminalDeps().then((status) => {
            if (closed) return
            if (status.ok) {
              // The host recovered between the close and the fetch — the
              // plain banner with a retry is the honest state.
              onFatal?.(t('terminalDepsFailed'))
              return
            }
            onFatal?.(null, { deps: status })
          }).catch(() => {
            if (closed) return
            onFatal?.(t('terminalDepsFailed'))
          })
          return
        }
        // A server-side refusal carries a close code + reason; retrying it
        // forever would only spin the banner, so surface it with a retry.
        if (event.code === 1011 && event.reason !== '') {
          onFatal?.(event.reason)
          return
        }
        // Unreasoned drops (upgrade rejected, host down, mid-handshake
        // refusal) normally recover on the next attempt; after a few
        // consecutive failures stop spinning and show the close code.
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          const detail = event.reason !== '' ? ` (${event.code}: ${event.reason})` : ` (${event.code})`
          console.error('[dsh-better-sidebar] terminal connection failed:', event.code, event.reason, url)
          onFatal?.(`${t('terminalConnectFailed')}${detail}`)
          return
        }
        if (!closed) retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => {
        socket?.close()
      }
    }

    connect()

    return {
      input(data: string): void {
        if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(data)
      },
      resize(cols: number, rows: number): void {
        send({ type: 'resize', cols, rows })
      },
      /** The user closed the tab: kill the pty immediately (quota released). */
      close(): void {
        send({ type: 'close' })
      },
      /** The user switched conversations: keep the pty alive indefinitely
       *  (no grace countdown) so switching back reattaches the same shell. */
      park(): void {
        send({ type: 'park' })
      },
      /** View unmounted: bare socket drop — the host's reconnect grace keeps
       *  the shell alive for a quick reconnect (same-session re-render,
       *  page refresh, plugin teardown). */
      dispose(): void {
        closed = true
        window.clearTimeout(retry)
        socket?.close()
        socket = null
      },
      /** Banner retry: one fresh connection attempt (a same-session
       *  re-attach); the on-open path resets the failure counter. */
      retry(): void {
        connect()
      },
    }
  },
}