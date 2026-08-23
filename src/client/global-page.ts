/**
 * The full-page "Global info" controller: a tiny module-level uSES source
 * for whether the complete-page view (GlobalPage) is open. Module-level
 * (not a store instance) because it is TRANSIENT UI state, the same pattern
 * as keybindings.ts's transient markers — it resets naturally on HMR
 * re-evaluation and never persists.
 *
 * The official left sidebar's injected footer button (outside the plugin's
 * React tree) opens the page through {@link setGlobalPageOpen}; the plugin's
 * Sidebar shell subscribes via {@link subscribeGlobalPage} and renders
 * <GlobalPage/> while it is open.
 */
import type { Context } from '../context-types.ts'

let open = false
const listeners = new Set<() => void>()

/** Whether the full-page global info view is currently open. */
export function isGlobalPageOpen(): boolean {
  return open
}

/** Open (true) or close (false) the full-page global info view. */
export function setGlobalPageOpen(value: boolean): void {
  if (open === value) return
  open = value
  for (const listener of [...listeners]) listener()
}

/**
 * Open the full-page global info from an entry point that holds the app
 * context (the official left sidebar's footer button, the panel tab's
 * "expand to full page" affordance). The page is a NO-SESSION surface:
 * opening it clears the current session's activation FIRST (the app falls
 * to the hero behind it), so from the page's perspective EVERY session
 * click is "opening a session" — the sidebar's close-on-session-open guard
 * then dismisses it naturally, with no "same session" ambiguity (the user
 * can click the session they came from and the page still closes, because
 * nothing was active while the page was up). A failed or absent clear
 * (sessions face missing) degrades to opening without clearing; the page
 * still opens, and the narrow guard keeps protecting same-session clicks.
 */
export function openGlobalPage(ctx: Context): void {
  try {
    ctx.sessions.clear?.()
  } catch {
    // Never let the open fail because the session clear threw.
  }
  setGlobalPageOpen(true)
}

/** Subscribe to the open state; returns the disposer. */
export function subscribeGlobalPage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Reset for tests (and HMR re-evaluation leaves the page closed). */
export function resetGlobalPageForTests(): void {
  setGlobalPageOpen(false)
  listeners.clear()
}
