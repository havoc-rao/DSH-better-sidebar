/**
 * DOM-level Cmd+W / Ctrl+W claim for the bottom workbench — the counterpart
 * of the desktop-shell bridge path (desktop-shortcuts.ts) for every
 * environment where the press actually reaches the page: plain browsers and
 * any shell without the `window.dshDesktopShell` bridge (the harness Electron
 * shell swallows Cmd+W main-process-side, so there the bridge path runs and
 * this listener never sees the key).
 *
 * WHY: the host's own right Sidebar claims the same chord for ITS tabs
 * (`page.close`, ui-sidebar-right shortcuts.ts). Focusing the PLUGIN's bottom
 * workbench is not the sidebar's territory, so that claim falls through to
 * "close the whole app" — the host's desktop fallback calls `closeWindow()`,
 * and a plain browser just closes the tab. This module claims the chord while
 * the focused element is inside the bottom workbench
 * ([data-dsh-bottom-panel]) and closes the focused pane's active tab instead
 * — the right box's Cmd+W closes the tab; the bottom box now does the same
 * instead of taking dsh itself down (one press closes one term).
 *
 * Claim rules (mirroring the host's page.close where its semantics matter):
 * - Chord: `primary`+`KeyW` (the host's desktop binding) and
 *   `primary`+`alt`+`KeyW` (the host's web binding — plain browsers reserve
 *   Cmd+W, so the host routes web close through the alt chord). No Shift, no
 *   Ctrl+Cmd mixes.
 * - Only claimed while the workbench is OPEN and focus is verifiably inside
 *   it; anything else keeps the host/browser behavior exactly as before.
 * - Pure Ctrl+W (Windows/Linux, no Cmd, no Alt) inside a terminal (`.xterm`)
 *   is left alone: it is the shell's own chord (readline delete-word), and
 *   the host's web runtime leaves it to terminals too. macOS Cmd+W is never
 *   a shell chord, so it is always claimed inside the workbench.
 * - Repeated keydowns (holding the key) are claimed (the browser must not
 *   get its own idea on the second repeat) but do not re-close — the host's
 *   dispatch runs commands on the first press only.
 * - A claimed press with nothing to close (an empty pane) collapses the
 *   workbench through the injected callback — the same "nothing more to
 *   close" feedback the desktop claim uses.
 */
import type { BetterSidebarService } from './service.ts'
import { closeBottomActiveTab } from './desktop-shortcuts.ts'

/** The plugin's bottom workbench panel host (see Sidebar.tsx). */
const BOTTOM_PANEL_SELECTOR = '[data-dsh-bottom-panel]'
/** One pane of the split workbench (see split-pane.tsx). */
const PANE_SELECTOR = '[data-dsh-pane]'

/** Whether the event is one of the close chords (desktop or web binding). */
function isCloseChord(event: KeyboardEvent): boolean {
  if (event.shiftKey) return false
  const primary = event.metaKey || event.ctrlKey
  if (!primary || event.code !== 'KeyW') return false
  // primary+KeyW (desktop) and primary+alt+KeyW (web): anything with more
  // modifiers than the alt variant is not ours (e.g. Ctrl+Cmd, Cmd+Shift).
  return !(event.metaKey && event.ctrlKey)
}

/**
 * The element that owns the press, IF it lives inside the bottom workbench.
 * The focused element is the primary witness (a keydown targets the focused
 * node — xterm's textarea, an editor, a tree row); the event's composed path
 * covers targets that never take focus (a focused <body> with the event still
 * carrying the real target).
 */
function bottomAnchorOf(event: KeyboardEvent): Element | null {
  const active = document.activeElement
  if (active instanceof Element && active.closest(BOTTOM_PANEL_SELECTOR) !== null) return active
  const target = event.composedPath().find((value): value is Element => value instanceof Element)
  if (target !== undefined && target.closest(BOTTOM_PANEL_SELECTOR) !== null) return target
  return null
}

/** The pane the anchor sits in, when it is inside one. */
function paneIdOf(anchor: Element): string | undefined {
  return anchor.closest(PANE_SELECTOR)?.getAttribute('data-dsh-pane') ?? undefined
}

/**
 * Install the bottom-workbench Cmd+W claim: a window CAPTURE-phase keydown
 * listener. Capture runs before the host shortcuts' window BUBBLE dispatch,
 * so `preventDefault()` makes its registry skip the press entirely
 * (registry.dispatch returns `pass` on a defaultPrevented gesture) — the
 * "close the app" fallback never runs — and `stopPropagation()` keeps the
 * terminal/editor from seeing a claimed chord.
 * @param service - the plugin's own service (active-tab close path).
 * @param collapseBottom - the mount point's collapse callback (only called
 *   while the workbench is open with nothing to close).
 * @returns the disposer (fiber-effect cleanup, HMR-safe).
 */
export function installBottomCloseShortcut(
  service: BetterSidebarService,
  collapseBottom: () => boolean,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !isCloseChord(event)) return
    const anchor = bottomAnchorOf(event)
    if (anchor === null) return
    // Pure Ctrl+W inside a terminal: the shell's chord, and the host's web
    // runtime deliberately passes it through — so do we.
    if (!event.metaKey && !event.altKey && anchor.closest('.xterm') !== null) return
    if (service.getSnapshot().state?.bottomOpen !== true) return
    event.preventDefault()
    event.stopPropagation()
    // Repeats (holding the key) are claimed — the browser must not pick up
    // its own close on the next repeat — but not re-run: one press closes
    // one tab, mirroring the host's dispatch.
    if (!event.repeat) closeBottomActiveTab(service, collapseBottom, paneIdOf(anchor))
  }
  window.addEventListener('keydown', onKeyDown, true)
  return () => { window.removeEventListener('keydown', onKeyDown, true) }
}