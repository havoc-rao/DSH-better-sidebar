/**
 * VSCode-like panel-toggle keyboard shortcuts (⌘J / ⌘⌥B on macOS, Ctrl+J /
 * Ctrl+Alt+B elsewhere):
 *
 *   ⌘J     toggle the bottom panel — VSCode's "View: Toggle Panel";
 *   ⌘⌥B    toggle the right sidebar — VSCode's "View: Toggle Side Bar
 *          Visibility", with Option held so the plain ⌘B stays free for
 *          the app shell.
 *
 * The listener is document-CAPTURE (like the IME guard), so it wins against
 * React's delegated handlers and any inlined third-party keydown code; a
 * matched combo is fully consumed (preventDefault + stopPropagation) — the
 * shortcut belongs to the sidebar, never to the focused editor / terminal /
 * composer, matching VSCode where ⌘J works even while typing.
 *
 * Matching is PHYSICAL (`event.code`), not layout-dependent (`event.key`):
 * on the US layout Option+B reports the key value "∫", and non-Latin
 * layouts remap key values entirely — `code` stays the key the user
 * pressed everywhere.
 *
 * Guards:
 *  - IME composition (reuses {@link isImeComposition}): during
 *    Chinese/Japanese input every pressed key belongs to the input method;
 *  - AltGraph (Windows): AltGr reports ctrlKey+altKey, so typing AltGr+B on
 *    layouts that use it must not toggle the sidebar;
 *  - key repeat: a held combo toggles once, never per auto-repeat;
 *  - shift: exact modifier sets only, so ⌘⇧J / ⌘⌥⇧B are never hijacked;
 *  - narrow viewports: the bottom panel does not exist there (its tabs are
 *    merged into the right drawer), so the bottom toggle is a no-op there,
 *    mirroring the hidden bottom-panel toggle button.
 */
import { isImeComposition } from './ime-guard.ts'
import { isNarrowWidth } from './breakpoints.ts'
import { toggleBottomPanel, togglePanel, type SidebarStore } from './state.ts'

/** The panel a matched shortcut toggles. */
export type PanelHotkeyTarget = 'right' | 'bottom'

/** The subset of KeyboardEvent the matcher reads (pure: testable without DOM). */
export interface HotkeyEventLike {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  isComposing: boolean
  keyCode: number
  getModifierState?: (name: string) => boolean
}

/**
 * The pure decision: which panel (if any) this keydown toggles.
 * `'right'` for ⌘/Ctrl+⌥/Alt+B, `'bottom'` for ⌘/Ctrl+J, null otherwise.
 */
export function matchPanelHotkey(event: HotkeyEventLike): PanelHotkeyTarget | null {
  if (event.repeat) return null
  if (isImeComposition(event)) return null
  if (!(event.metaKey || event.ctrlKey)) return null
  if (event.shiftKey) return null
  // AltGr = Ctrl+Alt on Windows: a character-producing AltGr chord is not
  // this shortcut (getModifierState is absent only in exotic engines, in
  // which case there is no AltGraph signal to misread).
  if (event.getModifierState?.('AltGraph') === true) return null
  if (event.altKey) return event.code === 'KeyB' ? 'right' : null
  return event.code === 'KeyJ' ? 'bottom' : null
}

/**
 * Register the document-level panel-toggle shortcuts. Returns the disposer
 * (HMR-safe; call through `ctx.effect`). Without a current session the
 * store's `reduce` is a strict no-op, so the shortcuts are harmless before
 * the first conversation is selected.
 */
export function registerPanelHotkeys(store: SidebarStore): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = matchPanelHotkey(event)
    if (target === null) return
    // The bottom panel does not exist on narrow viewports: leave the key to
    // the page instead of flipping a dormant flag that would only surface
    // (uninvited) after the window widens.
    if (target === 'bottom' && isNarrowWidth(window.innerWidth)) return
    event.preventDefault()
    event.stopPropagation()
    store.reduce(target === 'right' ? togglePanel : toggleBottomPanel)
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
  }
}

/**
 * The display hint for one toggle shortcut (tooltip suffix). macOS spells
 * ⌘J / ⌘⌥B; other platforms Ctrl+J / Ctrl+Alt+B — both accepted by
 * {@link matchPanelHotkey}.
 */
export function panelHotkeyHint(target: PanelHotkeyTarget): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  if (target === 'bottom') return mac ? '⌘J' : 'Ctrl+J'
  return mac ? '⌘⌥B' : 'Ctrl+Alt+B'
}
