/**
 * The ⌘W desktop-shortcut claimer (client half).
 *
 * DSH Desktop's Electron main process intercepts the app menu's ⌘W before
 * the renderer ever sees the keydown (see src/desktop-cmdw.ts for the
 * shell-side contract). The sidebar claims the chord through the plugin's
 * own `/sidebar/ws/cmd-w` socket: the host broadcasts `{type:'cmd-w',id}`
 * and THIS module answers with whether the sidebar would have consumed the
 * key itself — the exact conditions of the builtin ⌘W binding
 * (`focusInSidebar && !plusMenuOpen` with a closeable active tab), plus
 * `document.hasFocus()` so only the FOCUSED window's view ever claims in a
 * multi-window shell. A claim closes that tab (parity: the same
 * `sessionScopeOf` + `closeTab` path the binding uses) and tells the host,
 * which then keeps the window open. Everything else answers "unclaimed"
 * and the shell keeps its existing window-close confirm flow.
 *
 * The link is page-global (not session-scoped): the verdict is evaluated
 * against the CURRENT snapshot at request time, so one socket serves every
 * session switch. Reconnect behavior mirrors the agent-opens socket.
 */
import { CMD_W_CHANNEL_PATH, parseCmdWFrame, type CmdWFrame, type CmdWReplyFrame } from '../cmd-w-wire.ts'
import { buildKeybindingContext, sessionScopeOf, workingTabIdOf, type SidebarKeybindingContext } from './keybindings.ts'
import type { Context } from '../context-types.ts'
import type { BetterSidebarService } from './service.ts'
import type { SidebarStore } from './state.ts'

/** `WebSocket.OPEN` (1) — kept local so tests never need a WebSocket global. */
const WS_OPEN = 1

/** Reconnect delay between failed attempts (mirror of the agent-opens loop). */
const CMD_W_RETRY_DELAY_MS = 2000
/** Give up after this many consecutive failures. */
const CMD_W_FAILURE_LIMIT = 4

/** The minimal socket surface the link touches (the real WebSocket in
 *  production; tests inject a fake via {@link CmdWLinkOptions}). */
export interface CmdWClientSocket {
  readyState: number
  send(data: string): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

/** Test seams for {@link attachCmdWClaim}. */
export interface CmdWLinkOptions {
  /** Socket factory (default: the real WebSocket). */
  createSocket?: (url: string) => CmdWClientSocket
  retryDelayMs?: number
  failureLimit?: number
}

/**
 * Pure claim predicate — would the sidebar consume ⌘W right now? Mirror of
 * the builtin binding's when-clause (`focusInSidebar && !plusMenuOpen`)
 * PLUS the focused-window guard: the keydown path implies document focus
 * (the event only fires in the focused window), but the desktop route asks
 * a possibly-unfocused window too, so `hasFocus` is explicit here. Whether
 * there is actually a tab to close is the separate `claimTargetOf` concern.
 */
export function shouldClaimCmdW(context: SidebarKeybindingContext, hasFocus: boolean): boolean {
  return hasFocus && context.focusInSidebar && !context.plusMenuOpen
}

/**
 * The tab a claim would close: the focus-pinned working tab (the one whose
 * content holds the DOM focus — the user may be typing in the bottom pane's
 * terminal while `activePane` still points at the right pane), falling back
 * to the state's active tab; undefined when the gates deny the claim or
 * nothing is closeable. Shared with the builtin binding via
 * `workingTabIdOf` — the two must never close different tabs.
 */
export function claimTargetOf(context: SidebarKeybindingContext, hasFocus: boolean): string | undefined {
  if (!shouldClaimCmdW(context, hasFocus)) return undefined
  return workingTabIdOf(context.state)
}

/**
 * Evaluate one claim request and act on it: `claimed: true` closes the
 * working tab (the same `sessionScopeOf` + `closeTab` path the builtin ⌘W
 * binding uses — the onClose callback sees the identical scope) and answers
 * true; anything else answers false WITHOUT side effects. The reply is
 * ALWAYS sent (claimed or not): the host resolves a round when every view
 * has answered, so silence would only stall it until the timeout.
 */
export function claimCmdW(
  ctx: Context,
  store: SidebarStore,
  service: BetterSidebarService,
  id: string,
): CmdWReplyFrame {
  const hasFocus = typeof document !== 'undefined' ? document.hasFocus() : false
  const context = buildKeybindingContext(store)
  const targetId = claimTargetOf(context, hasFocus)
  if (targetId === undefined) {
    return { type: 'cmd-w-reply', id, claimed: false }
  }
  const scope = sessionScopeOf(ctx, store)
  if (scope === undefined) {
    return { type: 'cmd-w-reply', id, claimed: false }
  }
  service.closeTab(targetId, scope)
  return { type: 'cmd-w-reply', id, claimed: true }
}

/**
 * Open (and keep open) the claim link for one plugin activation. Returns
 * the disposer (call through `ctx.effect` — HMR-safe). The socket lives for
 * the whole page: requests arrive at any moment (the user can press ⌘W any
 * time), so it must NOT be tied to a session or to the panel being open.
 */
export function attachCmdWClaim(
  ctx: Context,
  store: SidebarStore,
  service: BetterSidebarService,
  options: CmdWLinkOptions = {},
): () => void {
  const createSocket = options.createSocket
    ?? ((url: string): CmdWClientSocket => new WebSocket(url) as unknown as CmdWClientSocket)
  const retryDelayMs = options.retryDelayMs ?? CMD_W_RETRY_DELAY_MS
  const failureLimit = options.failureLimit ?? CMD_W_FAILURE_LIMIT
  let socket: CmdWClientSocket | null = null
  let retry: number | undefined
  let closed = false
  let failures = 0

  const connect = (): void => {
    if (closed) return
    const url = new URL(CMD_W_CHANNEL_PATH, location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = createSocket(url.toString())
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const frame = parseCmdWFrame(event.data)
      if (frame === null || frame.type !== 'cmd-w') return
      const reply = claimCmdW(ctx, store, service, frame.id)
      if (socket !== null && socket.readyState === WS_OPEN) {
        try {
          socket.send(JSON.stringify(reply satisfies CmdWFrame))
        } catch {
          // A dying socket cannot answer; the host's timeout resolves the round.
        }
      }
    }
    socket.onclose = () => {
      if (closed) return
      failures += 1
      if (failures >= failureLimit) {
        console.error('[dsh-better-sidebar] ⌘W claim link failed; stopping reconnect loop')
        return
      }
      retry = window.setTimeout(connect, retryDelayMs)
    }
    socket.onerror = () => { socket?.close() }
  }
  connect()
  return () => {
    closed = true
    window.clearTimeout(retry)
    socket?.close()
  }
}