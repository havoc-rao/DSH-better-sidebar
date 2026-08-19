/**
 * The sidebar's built-in keybindings (v0.14.0+), registered through the ONE
 * shared keybinding runtime (see keybindings.ts):
 *
 * - panel toggles: ⌘B (host left sidebar) / ⌘⌥B (right panel) / ⌘J (bottom
 *   panel) / ⌘⇧J (maximize bottom) — the historical panel hotkeys, migrated
 *   onto the registry (panelToggleBindings in hotkeys.ts);
 * - ⌘P / Ctrl+P — QUICK OPEN: expands the panel, ensures a files window
 *   (activating an existing path-less editor tab or minting a fresh home),
 *   and focuses its search box (type-ahead file open);
 * - ⌘F / Ctrl+F — focuses the files search box when the active tab IS a
 *   files window (yields to the host otherwise — no blanket stealing);
 * - ⌘Tab / ⌘Shift+Tab — cycle next / previous tab of the active pane;
 * - ⌘1…⌘9 — jump to the nth tab of the active pane;
 * - ⌘W — close the active tab.
 *
 * All tab-strip keys are gated on `focusInSidebar` (the user is actually
 * interacting with the panel) and free of the + menu; the fetch-style keys
 * (⌘P / ⌘F) yield while the user types outside the sidebar. `Cmd` matches
 * the platform command modifier (⌘ on macOS, Ctrl elsewhere).
 */
import type { Context } from '../../context-types.ts'
import { allLeaves, firstLeaf, togglePanel, type SidebarState, type SidebarTab, type SidebarStore } from '../state.ts'
import { KeybindingRuntime, focusSidebarSearchInput, type KeybindingDescriptor, type SidebarKeybindingContext } from '../keybindings.ts'
import { panelToggleBindings } from '../hotkeys.ts'
import { t } from '../locales.ts'

/** The session scope the callbacks ride with ({ sessionId, cwd? }). */
function scopeOf(ctx: Context, store: SidebarStore): { sessionId: string; cwd: string | undefined } | undefined {
  const sessionId = store.getSnapshot().sessionId
  if (sessionId === undefined) return undefined
  let cwd: string | undefined
  try {
    cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
  } catch {
    cwd = undefined
  }
  return { sessionId, cwd }
}

/** A path-less editor tab = the files HOME window (the search + tree). */
function isHomeTab(tab: SidebarTab): boolean {
  return tab.type === 'editor' && (tab.path === undefined || tab.path === '')
}

/** Find the files home tab — the active pane's first, then any. */
function findHomeTab(state: SidebarState): SidebarTab | undefined {
  const leaves = allLeaves(state.splits).concat(allLeaves(state.bottomSplits))
  const activeLeaf = leaves.find(leaf => leaf.id === state.activePane)
  if (activeLeaf !== undefined) {
    const home = activeLeaf.tabs.find(isHomeTab)
    if (home !== undefined) return home
  }
  for (const leaf of leaves) {
    const home = leaf.tabs.find(isHomeTab)
    if (home !== undefined) return home
  }
  return undefined
}

/** Focus the files search with a short retry ladder: after an expansion the
 *  tree panel mounts asynchronously, so the VERY next tick may be too early. */
function focusSearchSoon(): void {
  window.setTimeout(() => { focusSidebarSearchInput() }, 0)
  window.setTimeout(() => { focusSidebarSearchInput() }, 60)
}

/**
 * Register every built-in keybinding on the shared runtime. Returns the
 * disposer (call through `ctx.effect` — HMR-safe). The panel toggles share
 * one definition with the historical registerPanelHotkeys (no behavioral
 * fork); the rest are new.
 */
export function registerBuiltinKeybindings(
  runtime: KeybindingRuntime,
  ctx: Context,
  store: SidebarStore,
): () => void {
  const disposers: Array<() => void> = []

  const toggleLeftSidebar = (): void => {
    try {
      const layout = ctx.get('layout') as { toggleSidebar(): void } | undefined
      if (layout === undefined) {
        console.warn('[dsh-better-sidebar] layout service unavailable — ⌘B left-sidebar toggle skipped')
        return
      }
      layout.toggleSidebar()
    } catch (error) {
      console.warn('[dsh-better-sidebar] left-sidebar toggle failed:', error)
    }
  }
  for (const binding of panelToggleBindings(store, toggleLeftSidebar)) {
    disposers.push(runtime.register(binding))
  }

  /** Activate any open tab by id (the service path — fires onActivate). */
  const activateTabById = (tabId: string): void => {
    const scope = scopeOf(ctx, store)
    if (scope === undefined) return
    ctx.betterSidebar?.activateTab(tabId, scope)
  }

  const bindings: KeybindingDescriptor[] = [
    // ── Quick open / search focus ─────────────────────────────────────────
    {
      id: 'builtin:quick-open',
      title: () => t('hotkeyQuickOpen'),
      key: 'Cmd+P',
      when: context => !context.textEditing && !context.plusMenuOpen,
      run: () => {
        store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
        store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
        const state = store.getSnapshot().state
        if (state !== undefined) {
          const home = findHomeTab(state)
          if (home !== undefined) {
            activateTabById(home.id)
          } else {
            const scope = scopeOf(ctx, store)
            if (scope !== undefined) {
              // A fresh files home (tree docked) — the search box is ready as
              // soon as the tab renders.
              ctx.betterSidebar?.openTab({ type: 'editor', title: t('files'), meta: { treeOpen: true } }, scope)
            }
          }
        }
        focusSearchSoon()
      },
    },
    {
      id: 'builtin:focus-search',
      title: () => t('hotkeyFocusSearch'),
      key: 'Cmd+F',
      when: context => !context.textEditing && !context.plusMenuOpen,
      run: (_event, context) => {
        // ⌘F is scoped to the FILES window: only when the active tab is one
        // (the search box lives there). Anything else yields to the host —
        // a blanket ⌘F steal would break the app's own find.
        if (context.activeTabType !== 'editor') return false
        store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
        store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
        focusSearchSoon()
      },
    },
    // ── Tab-strip keys (active pane, sidebar-focused only) ─────────────────
    {
      id: 'builtin:tab-next',
      title: () => t('hotkeyNextTab'),
      key: 'Cmd+Tab',
      when: context => context.focusInSidebar && !context.plusMenuOpen,
      run: (_event, context) => {
        const tabs = context.activePaneTabs
        if (tabs.length === 0) return false
        const index = cycleIndex(context.activeTab?.id ?? null, tabs, 1)
        activateTabById(tabs[index]!.id)
      },
    },
    {
      id: 'builtin:tab-previous',
      title: () => t('hotkeyPrevTab'),
      key: 'Cmd+Shift+Tab',
      when: context => context.focusInSidebar && !context.plusMenuOpen,
      run: (_event, context) => {
        const tabs = context.activePaneTabs
        if (tabs.length === 0) return false
        const index = cycleIndex(context.activeTab?.id ?? null, tabs, -1)
        activateTabById(tabs[index]!.id)
      },
    },
    {
      id: 'builtin:tab-close-active',
      title: () => t('hotkeyCloseTab'),
      key: 'Cmd+W',
      when: context => context.focusInSidebar && !context.plusMenuOpen,
      run: (_event, context) => {
        const tabId = context.activeTab?.id
        if (tabId === undefined) return false
        const scope = scopeOf(ctx, store)
        if (scope === undefined) return false
        ctx.betterSidebar?.closeTab(tabId, scope)
      },
    },
  ]

  // ⌘1…⌘9 jump to the nth tab of the active pane (VSCode editor-group style).
  for (let digit = 1; digit <= 9; digit += 1) {
    bindings.push({
      id: `builtin:tab-jump-${digit}`,
      title: () => t('hotkeyJumpTab', { n: digit }),
      key: `Cmd+${digit}`,
      when: context => context.focusInSidebar && !context.plusMenuOpen,
      run: (_event, context) => {
        const tabs = context.activePaneTabs
        if (tabs.length < digit) return
        activateTabById(tabs[digit - 1]!.id)
      },
    })
  }

  for (const binding of bindings) disposers.push(runtime.register(binding))
  return () => { for (const dispose of disposers) dispose() }
}

/** Context helper used by the cycle bindings (kept pure for tests). */
export function cycleIndex(current: string | null, tabs: readonly SidebarTab[], delta: number): number {
  if (tabs.length === 0) return -1
  const index = current === null ? -1 : tabs.findIndex(tab => tab.id === current)
  return (index + delta + tabs.length) % tabs.length
}

/** Re-export the context type for tests/consumers. */
export type { SidebarKeybindingContext }