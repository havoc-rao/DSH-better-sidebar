/**
 * The desktop-shortcut claimer (host half).
 *
 * DSH Desktop's Electron main process owns a ShortcutRouter installed on the
 * profile's Cordis context as `ctx.desktopShortcuts` (see the shell's
 * `apps/electron/src/shortcuts.ts`): when the app menu's ⌘W ("Close
 * Window") accelerator fires, `window.ts` routes the chord through
 * `route('cmd-w')` and only proceeds with the window-close confirm flow
 * when no registered handler claims it. This module is the plugin's claimer:
 *
 * - `CmdWChannel`: the request/reply side of the claim channel. The CLAIM
 *   DECISION lives in the sidebar view (focus in the sidebar + a closeable
 *   active tab + the + menu closed — exactly the builtin ⌘W binding's
 *   when-clause), so the host broadcasts `{type:'cmd-w',id}` to every
 *   connected view over `/sidebar/ws/cmd-w` and resolves the verdict from
 *   the first claim, from every view answering "unclaimed", or from the
 *   reply timeout (no view = unclaimed, so the shell keeps its existing
 *   confirm dialog — zero behavior change without the desktop service).
 * - `registerDesktopShortcutClaim`: feature-detects `ctx.desktopShortcuts`
 *   and registers the 'cmd-w' handler; a missing service (plain browser /
 *   older shells) is a strict no-op.
 */
import { parseCmdWFrame, type CmdWFrame } from './cmd-w-wire.ts'

/** How long an arbitration round waits for the views before giving up. The
 *  local round-trip is a few ms; the cap only guards a degraded renderer
 *  that never answers (a hanging route would stall the shell's close flow). */
export const CMD_W_REPLY_TIMEOUT_MS = 500

/** The shell's ShortcutRouter, as the plugin sees it (structural subset:
 *  only the register surface this side consumes — no harness typing is
 *  imported). */
export interface DesktopShortcuts {
  /** Register one shortcut's claimer; returns the disposer. */
  register(
    shortcut: string,
    handler: () => DesktopShortcutVerdict | Promise<DesktopShortcutVerdict>,
  ): () => void
}

/** One shortcut route's verdict. */
export type DesktopShortcutVerdict = 'claimed' | 'unclaimed'

/** The subset of the `ws` socket this channel touches (structural, so the
 *  channel unit-tests run without the real WebSocket). */
export interface CmdWSocketFace {
  readyState: number
  send(data: string): void
  on(event: 'message', listener: (raw: unknown) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: () => void): void
}

/** `ws.OPEN` (1) — kept local so tests never need the ws module. */
const WS_OPEN = 1

/** One in-flight arbitration round. */
interface PendingRound {
  /** Views that have not answered yet. */
  open: Set<CmdWSocketFace>
  resolve: (verdict: DesktopShortcutVerdict) => void
  timer: ReturnType<typeof setTimeout>
}

/** The host side of the ⌘W claim channel: view registry + arbitration. */
export class CmdWChannel {
  private readonly sockets = new Set<CmdWSocketFace>()
  private readonly pending = new Map<string, PendingRound>()
  private nextId = 0

  constructor(private readonly replyTimeoutMs = CMD_W_REPLY_TIMEOUT_MS) {}

  /** Register one connected view (the upgrade handler's socket). Returns
   *  the disposer; close/error auto-detach. */
  attach(ws: CmdWSocketFace): () => void {
    this.sockets.add(ws)
    const onMessage = (raw: unknown): void => this.onMessage(ws, raw)
    const onGone = (): void => this.dropSocket(ws)
    ws.on('message', onMessage)
    ws.on('close', onGone)
    ws.on('error', onGone)
    return () => {
      this.sockets.delete(ws)
      this.dropSocket(ws)
    }
  }

  /**
   * Run one ⌘W arbitration round: broadcast a request frame to every open
   * view and resolve 'claimed' on the first claim, 'unclaimed' once every
   * view has answered "no", on the reply timeout, or immediately when no
   * view is connected. Never rejects (a route must always hand the shell a
   * verdict — the shell's own guard falls back to the confirm dialog).
   */
  route(): Promise<DesktopShortcutVerdict> {
    const open = [...this.sockets].filter(ws => ws.readyState === WS_OPEN)
    if (open.length === 0) return Promise.resolve('unclaimed')
    const id = `cmd-w:${++this.nextId}`
    return new Promise<DesktopShortcutVerdict>((resolve) => {
      const timer = setTimeout(() => this.finish(id, 'unclaimed'), this.replyTimeoutMs)
      this.pending.set(id, { open: new Set(open), resolve, timer })
      const request = JSON.stringify({ type: 'cmd-w', id } satisfies CmdWFrame)
      for (const ws of open) {
        try {
          ws.send(request)
        } catch {
          // A socket that dies mid-send cannot answer; drop it so the
          // round still resolves on the others / the timeout.
          this.dropSocket(ws)
        }
      }
    })
  }

  /** One view's reply. Stale or already-answered sockets are ignored. */
  private onMessage(ws: CmdWSocketFace, raw: unknown): void {
    const frame = parseCmdWFrame(raw)
    if (frame === null || frame.type !== 'cmd-w-reply') return
    const round = this.pending.get(frame.id)
    if (round === undefined || !round.open.has(ws)) return
    if (frame.claimed === true) {
      this.finish(frame.id, 'claimed')
      return
    }
    round.open.delete(ws)
    if (round.open.size === 0) this.finish(frame.id, 'unclaimed')
  }

  /** A view went away: it can no longer answer any in-flight round. */
  private dropSocket(ws: CmdWSocketFace): void {
    for (const [id, round] of this.pending) {
      if (!round.open.delete(ws)) continue
      if (round.open.size === 0) this.finish(id, 'unclaimed')
    }
  }

  /** Settle one round exactly once. */
  private finish(id: string, verdict: DesktopShortcutVerdict): void {
    const round = this.pending.get(id)
    if (round === undefined) return
    this.pending.delete(id)
    clearTimeout(round.timer)
    round.resolve(verdict)
  }
}

/** The ctx slice this side reads (get may be absent in unit tests). */
interface ClaimsCtx {
  get?: (name: string) => unknown
}

/**
 * Claim the shell's ⌘W shortcut on the sidebar's behalf. Feature-detect:
 * without `ctx.desktopShortcuts` (plain browser / shell without the router)
 * this is a strict no-op — the shell never intercepts ⌘W there and the
 * renderer's own binding handles the chord. With the service present, one
 * registration covers the whole desktop runtime (the channel arbitrates
 * across every connected view). Returns the disposer (call through
 * `ctx.effect`).
 */
export function registerDesktopShortcutClaim(ctx: ClaimsCtx, channel: CmdWChannel): () => void {
  const shortcuts = ctx.get?.('desktopShortcuts') as DesktopShortcuts | undefined
  if (shortcuts === undefined || typeof shortcuts.register !== 'function') {
    // One boot-time line settles the runtime-topology question: this plugin
    // host half running where the shell's ShortcutRouter is invisible means
    // ⌘W claiming needs the shell↔renderer preload bridge instead (the WS
    // channel alone cannot reach the router from a separated process).
    console.info('[dsh-better-sidebar] desktopShortcuts absent — ⌘W claiming disabled (browser deployment or separated ctx)')
    return () => { /* service absent: nothing to claim */ }
  }
  console.info('[dsh-better-sidebar] desktopShortcuts available — ⌘W claiming enabled')
  try {
    return shortcuts.register('cmd-w', () => channel.route())
  } catch (error) {
    // A misbehaving shell must never take the plugin down: log and degrade
    // to the no-op (the shell then keeps its own confirm dialog).
    console.error('[dsh-better-sidebar] desktopShortcuts.register failed:', error)
    return () => { /* registration failed: no claiming */ }
  }
}