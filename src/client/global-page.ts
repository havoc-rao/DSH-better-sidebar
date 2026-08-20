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
