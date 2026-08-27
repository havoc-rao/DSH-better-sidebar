/**
 * VSCode-like panel-toggle keyboard shortcuts (macOS ⌘, elsewhere Ctrl):
 *
 *   ⌘B      toggle the host app shell's LEFT sidebar (ui-layout's
 *           `ctx.layout.toggleSidebar()`) — VSCode's "View: Toggle Side Bar
 *           Visibility"; inside IDE FULLSCREEN (⌘⌥⇧B) the host sidebar sits
 *           BEHIND the fullscreen cover, so ⌘B then toggles the IDE window's
 *           own left column (the explorer drawer, `sideBarOpen`) instead;
 *   ⌘J      toggle the bottom panel — VSCode's "View: Toggle Panel";
 *   ⌘⇧J     toggle the bottom panel MAXIMIZED (fullscreen over the center
 *           column; closed opens fullscreen, fullscreen restores the drag
 *           height) — VSCode's "View: Toggle Maximized Panel". Inside IDE
 *           FULLSCREEN the docked bottom box expands UPWARD the same way;
 *   ⌘⌥B     toggle the right sidebar — the plugin's own panel, Option held
 *           so the plain ⌘B stays the host sidebar's binding. Inside IDE
 *           FULLSCREEN "the right panel" is the IDE window's Side Chat
 *           column, so ⌘⌥B collapses/expands ONLY that (same as ⌘⇧B) — the
 *           fullscreen cover and the mode itself survive;
 *   ⌘⇧B     INSIDE IDE FULLSCREEN ONLY: toggle the IDE window's right column
 *           (the Side Chat column, `chatOpen`). Outside IDE mode the chord
 *           is unbound and passes through to the page untouched (the shift
 *           guard below) — only ⌘⇧J carries Shift outside the mode.
 *
 * The listener is document-CAPTURE (like the IME guard), so it wins against
 * React's delegated handlers and any inlined third-party keydown code; a
 * matched combo is fully consumed (preventDefault + stopPropagation) — the
 * shortcut belongs to the sidebar, never to the focused editor / terminal /
 * composer, matching VSCode where ⌘B/⌘J work even while typing.
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
 *  - shift: ONLY ⌘⇧J is a shift binding — ⌘⇧B / ⌘⌥⇧B / ⌘⌥⇧J pass through;
 *  - narrow viewports: the bottom panel does not exist there (its tabs are
 *    merged into the right drawer), so the bottom toggles are no-ops there,
 *    mirroring the hidden bottom-panel toggle button. The left sidebar
 *    keeps its own semantics (the host's toggle flips the narrow
 *    re-expand override).
 */
import { isImeComposition } from './ime-guard.ts'
import { isNarrowWidth } from './breakpoints.ts'
import {
  KeybindingRuntime,
  type KeybindingDescriptor,
  type SidebarKeybindingContext,
} from './keybindings.ts'
import { activeTabOf, setChatOpen, setSideBarOpen, toggleBottomMaximized, toggleBottomPanel, togglePanel, type SidebarStore } from './state.ts'
import { t } from './locales.ts'

/** The panel a matched shortcut toggles. */
export type PanelHotkeyTarget = 'left' | 'right' | 'bottom' | 'maximize' | 'ide' | 'chat'

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
 * `'left'` for ⌘/Ctrl+B (the host sidebar), `'right'` for ⌘/Ctrl+⌥/Alt+B,
 * `'bottom'` for ⌘/Ctrl+J, `'maximize'` for ⌘/Ctrl+⇧/Shift+J, null
 * otherwise.
 */
export function matchPanelHotkey(event: HotkeyEventLike): PanelHotkeyTarget | null {
  if (event.repeat) return null
  if (isImeComposition(event)) return null
  if (!(event.metaKey || event.ctrlKey)) return null
  // AltGr = Ctrl+Alt on Windows: a character-producing AltGr chord is not
  // this shortcut (getModifierState is absent only in exotic engines, in
  // which case there is no AltGraph signal to misread).
  if (event.getModifierState?.('AltGraph') === true) return null
  // Shift is a binding ONLY as ⌘⇧J (maximize the bottom panel); every other
  // shift chord (⌘⇧B, ⌘⌥⇧B, ⌘⌥⇧J, …) passes through untouched.
  if (event.shiftKey) return !event.altKey && event.code === 'KeyJ' ? 'maximize' : null
  if (event.altKey) return event.code === 'KeyB' ? 'right' : null
  // Exact keys without Option: ⌘B = the host left sidebar, ⌘J = the bottom
  // panel — nothing else.
  if (event.code === 'KeyB') return 'left'
  if (event.code === 'KeyJ') return 'bottom'
  return null
}

/** The transient keybinding context the panel toggles read (per-event). */
function panelKeybindingContext(store: SidebarStore): SidebarKeybindingContext {
  const snapshot = store.getSnapshot()
  const state = snapshot.state ?? null
  return {
    state,
    narrow: typeof window !== 'undefined' && isNarrowWidth(window.innerWidth),
    focusInSidebar: false,
    textEditing: false,
    plusMenuOpen: false,
    searchActive: false,
    activeTab: state === null ? null : activeTabOf(state) ?? null,
    activeTabType: '',
    activePaneTabs: [],
  }
}

/**
 * The four panel-toggle bindings as registry descriptors (shared by the
 * production runtime and `registerPanelHotkeys` — one definition, no
 * behavioral fork). The bottom toggles gate on `!narrow`: the bottom panel
 * does not exist there (its tabs are merged into the right drawer), so the
 * keys pass through untouched, mirroring the hidden bottom-panel toggle
 * button. The left sidebar keeps its own semantics (the host's toggle
 * flips the narrow re-expand override).
 */
export function panelToggleBindings(store: SidebarStore, toggleLeftSidebar: () => void): KeybindingDescriptor[] {
  return [
    {
      id: 'builtin:toggle-left-sidebar',
      title: () => t('hotkeyToggleLeftSidebar'),
      key: 'Cmd+B',
      run: (event, context) => {
        // IDE FULLSCREEN: the host's left sidebar sits BEHIND the fullscreen
        // cover (toggling it would be invisible), so ⌘B operates on the IDE
        // window's own left column — the explorer drawer (`sideBarOpen`, the
        // same toggle the Activity Bar icon / ⌘⇧E use). Outside the mode the
        // host app shell's sidebar transition applies as always.
        if (context.state?.rightMaximized === true) {
          store.reduce(s => setSideBarOpen(s, !s.sideBarOpen))
          return
        }
        toggleLeftSidebar()
      },
    },
    {
      id: 'builtin:toggle-right-panel',
      title: () => t('hotkeyToggleRightPanel'),
      key: 'Cmd+Alt+B',
      run: (event, context) => {
        // IDE FULLSCREEN: "the right panel" of the IDE window IS its Side
        // Chat column — ⌘⌥B collapses/expands ONLY that (same toggle as
        // ⌘⇧B). The fullscreen cover itself never closes and the mode
        // survives: the user's muscle memory ("collapse the right side")
        // must not tear the whole IDE panel down. Outside the mode the
        // plain panel open/close toggle applies.
        if (context.state?.rightMaximized === true) {
          store.reduce(s => setChatOpen(s, !s.chatOpen))
          return
        }
        store.reduce(togglePanel)
      },
    },
    {
      // IDE FULLSCREEN ONLY: ⌘⇧B toggles the right column of the IDE window
      // (the Side Chat column). Outside the mode the chord is deliberately
      // left unbound — it passes through to the page (the historical shift
      // guard: only ⌘⇧J carries Shift) instead of stealing a host key.
      id: 'builtin:toggle-ide-chat',
      title: () => t('hotkeyToggleChatColumn'),
      key: 'Cmd+Shift+B',
      when: context => context.state?.rightMaximized === true,
      run: () => { store.reduce(s => setChatOpen(s, !s.chatOpen)) },
    },
    {
      id: 'builtin:toggle-bottom-panel',
      title: () => t('hotkeyToggleBottomPanel'),
      key: 'Cmd+J',
      when: context => !context.narrow,
      run: () => { store.reduce(toggleBottomPanel) },
    },
    {
      id: 'builtin:toggle-bottom-maximized',
      title: () => t('hotkeyToggleBottomMaximized'),
      key: 'Cmd+Shift+J',
      when: context => !context.narrow,
      run: () => { store.reduce(toggleBottomMaximized) },
    },
  ]
}

/**
 * Register the document-level panel-toggle shortcuts through the shared
 * keybinding runtime. Returns the disposer (HMR-safe; call through
 * `ctx.effect`). `toggleLeftSidebar` is the host app shell's sidebar
 * transition (ui-layout's `ctx.layout.toggleSidebar`), wired by the caller
 * so this module stays DOM-free. Without a current session the store's
 * `reduce` is a strict no-op, so the shortcuts are harmless before the
 * first conversation is selected.
 */
export function registerPanelHotkeys(store: SidebarStore, toggleLeftSidebar: () => void): () => void {
  const runtime = new KeybindingRuntime(() => panelKeybindingContext(store))
  for (const binding of panelToggleBindings(store, toggleLeftSidebar)) runtime.register(binding)
  return runtime.attach()
}

/**
 * The display hint for one toggle shortcut (tooltip suffix). macOS spells
 * ⌘B / ⌘J / ⌘⇧J / ⌘⌥B / ⌘⌥⇧B / ⌘⇧B; other platforms Ctrl+B / Ctrl+J /
 * Ctrl+Shift+J / Ctrl+Alt+B / Ctrl+Alt+Shift+B / Ctrl+Shift+B — all
 * accepted by {@link matchPanelHotkey} / the keybinding runtime.
 */
export function panelHotkeyHint(target: PanelHotkeyTarget): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  if (target === 'left') return mac ? '⌘B' : 'Ctrl+B'
  if (target === 'bottom') return mac ? '⌘J' : 'Ctrl+J'
  if (target === 'maximize') return mac ? '⌘⇧J' : 'Ctrl+Shift+J'
  if (target === 'chat') return mac ? '⌘⇧B' : 'Ctrl+Shift+B'
  if (target === 'ide') return mac ? '⌘⌥⇧B' : 'Ctrl+Alt+Shift+B'
  return mac ? '⌘⌥B' : 'Ctrl+Alt+B'
}
