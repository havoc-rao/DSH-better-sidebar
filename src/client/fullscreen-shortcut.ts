/**
 * The bottom-workbench fullscreen toggle's global shortcut:
 * Cmd+Shift+J on macOS, Ctrl+Shift+J on Windows/Linux. Purity split from
 * the Sidebar shell so the chord semantics are unit-testable without a
 * component render.
 *
 * ENVIRONMENT FIT: DSH is a web app that also runs inside the
 * deepseek-harness Electron shell. In plain browsers the chord is
 * browser-reserved (Chrome opens DevTools, Firefox the console) and the
 * page never receives the press — the injection below simply never fires,
 * which is the documented, conflict-free outcome for that deployment. The
 * Electron shells route only the shortcuts they claim (Cmd+W, see
 * desktop-shortcuts.ts) and leave this chord to the renderer, so the
 * shortcut works there. Platform is resolved from the shell's
 * `dsh-desktop-platform` stamp first (see desktop-env.ts), then from
 * `navigator.platform`, then the user agent.
 */
import { parseDesktopEnv } from './desktop-env.ts'

/** The bare key of the chord, matched case-insensitively ('J' under Shift). */
export const FULLSCREEN_TOGGLE_KEY = 'j' as const

/** The smallest keyboard-event face the matcher needs (KeyboardEvent fits). */
export interface FullscreenToggleKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** Resolve the platform once per chord decision: macOS or not. Desktop shells
 *  stamp the render URL (`dsh-desktop-platform=darwin`); plain browsers fall
 *  back to `navigator.platform` (deprecated but universal) and the user
 *  agent. */
export function isMacPlatform(): boolean {
  const stamp = parseDesktopEnv().platform
  if (stamp !== null) return stamp === 'darwin'
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform
  if (typeof platform === 'string' && platform !== '') return /^mac/i.test(platform)
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

/** Whether the event is the fullscreen-toggle chord: Cmd+Shift+J on macOS,
 *  Ctrl+Shift+J elsewhere, no Alt, no cross-modifier. The platform is
 *  injectable (tests pin it) and defaults to the real platform. */
export function isFullscreenToggleShortcut(
  event: FullscreenToggleKeyEvent,
  isMac: boolean = isMacPlatform(),
): boolean {
  if (event.altKey || !event.shiftKey) return false
  if (event.key.toLowerCase() !== FULLSCREEN_TOGGLE_KEY) return false
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}