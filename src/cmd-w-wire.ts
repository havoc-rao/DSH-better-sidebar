/**
 * Wire contract of the ⌘W desktop-shortcut claim channel (shared by the
 * host's CmdWChannel and the client's claim link — the two halves of the
 * plugin must always speak the same frames).
 *
 * Why this channel exists: DSH Desktop's Electron main process re-routes
 * the app menu's ⌘W ("Close Window") accelerator through a Cordis service
 * (`ctx.desktopShortcuts`, see src/desktop-cmdw.ts) BEFORE the renderer
 * ever sees the keydown. The plugin claims the chord on the sidebar's
 * behalf: the host broadcasts a request frame to every connected view, the
 * view replies with whether IT would have consumed the key (focus in the
 * sidebar + a closeable active tab), and the host resolves the shortcut
 * route from the first claim — window stays open, tab closed. The
 * transport is the plugin's own fenced WebSocket, so no shell preload
 * surface is involved.
 */
export const CMD_W_CHANNEL_PATH = '/sidebar/ws/cmd-w'

/** Host → view: "the shell's ⌘W fired — would the sidebar take it?" */
export interface CmdWRequestFrame {
  type: 'cmd-w'
  /** One arbitration round's nonce (replies echo it; stale replies drop). */
  id: string
}

/** View → host: the verdict of one arbitration round. The view ALWAYS
 *  replies (claimed or not) — the host resolves when the first claim
 *  arrives or every view has answered. */
export interface CmdWReplyFrame {
  type: 'cmd-w-reply'
  /** The request nonce this verdict answers. */
  id: string
  claimed: boolean
}

/** Any frame on the channel, after validation. */
export type CmdWFrame = CmdWRequestFrame | CmdWReplyFrame

/** Parse one wire payload: the matching frame, or null for anything that is
 *  not a well-formed frame of this channel (malformed pushes are dropped —
 *  each transport side ignores what it cannot validate). */
export function parseCmdWFrame(raw: unknown): CmdWFrame | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as { type?: unknown; id?: unknown; claimed?: unknown }
  if (record.type === 'cmd-w' && typeof record.id === 'string' && record.id !== '') {
    return { type: 'cmd-w', id: record.id }
  }
  if (record.type === 'cmd-w-reply' && typeof record.id === 'string' && record.id !== '') {
    return { type: 'cmd-w-reply', id: record.id, claimed: record.claimed === true }
  }
  return null
}