/**
 * Terminal transport layer: the injectable connection slot behind
 * TerminalView (the "remote terminal" seam, feature `terminalSource`).
 *
 * The view owns xterm rendering, the block overlay, selection, fit/theme/
 * font and the banner state machine; a consumer plugin injects its own
 * connection layer through the `transport` prop (resolved by the built-in
 * terminal descriptor through the provider registry — see
 * terminal-source.ts). With no transport the view keeps its built-in local
 * pty WebSocket, byte for byte. Typed structurally — NO xterm dependency.
 */
import type { Context } from '../context-types.ts'
import type { SessionScope } from './api.ts'
import type { SidebarStore } from './state.ts'

export interface TerminalTransportSurface {
  /** Append raw data to the terminal buffer (never called after dispose). */
  write(data: string): void
  /** The current grid dimensions (transports size their channel from these). */
  readonly cols: number
  readonly rows: number
}

export interface TerminalTransportSession {
  term: TerminalTransportSurface
  scope: SessionScope
  /** The tab id (`agent:`-prefixed ids are agent-owned terminals). */
  tabId: string
  /** Working-directory hint (used as the remote start dir). */
  cwd?: string
  /** Raw downlink bytes → written into the terminal buffer verbatim. */
  onOutput(data: string): void
  /** A channel-reported title → the tab retitles. */
  onTitle?(title: string, info?: { cwd?: string; command?: string }): void
  /** Connection-state flips (the view's disconnected banner rides this). */
  onConnected?(connected: boolean): void
  /** An unrecoverable failure → the view's fatal banner + retry button.
   *  A plain `null` reason clears the banner (a transport's retry uses it). */
  onFatal?(reason: string | null): void
  /** The endpoint the current attempt targets (the fatal banner's URL line). */
  onEndpoint?(endpoint: string): void
}

export interface TerminalTransport {
  /** Diagnostic kind ('local-pty-ws', 'remote-ssh-pty', …). */
  readonly kind: string
  /** Open one terminal session; returns the handle the view drives until
   *  unmount. One handle per view mount. */
  open(session: TerminalTransportSession): TerminalTransportHandle
}

export interface TerminalTransportHandle {
  input(data: string): void
  resize(cols: number, rows: number): void
  /** The user closed the tab → kill the session immediately. */
  close(): void
  /** The user switched conversations (the tab stays open there) → keep the
   *  session alive for reattach. */
  park(): void
  /** The view unmounted — tear the channel down. */
  dispose(): void
  /** The user hit the banner's retry — re-establish the connection. */
  retry?(): void
}

/** TerminalView's props, shared so the core bundle and the lazy terminal
 *  chunk agree on the same shape. */
export interface TerminalViewProps {
  ctx: Context
  scope: SessionScope
  tabId: string
  store: SidebarStore
  /** Absent → the built-in local pty WebSocket (byte for byte). Read ONCE
   *  at mount: pass a stable instance. */
  transport?: TerminalTransport
  onTitleChange?: (title: string) => void
  visible?: boolean
  infoBar?: boolean
}