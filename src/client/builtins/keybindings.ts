/**
 * The sidebar's built-in keybindings (v0.14.0+), registered through the ONE
 * shared keybinding runtime (see keybindings.ts):
 *
 * - panel toggles: ⌘B (host left sidebar — inside IDE FULLSCREEN the IDE
 *   window's own explorer drawer) / ⌘⌥B (right panel) / ⌘J (bottom panel)
 *   / ⌘⇧J (maximize bottom) / ⌘⇧B (IDE FULLSCREEN only: the Side Chat
 *   column) — the historical panel hotkeys, migrated onto the registry
 *   (panelToggleBindings in hotkeys.ts);
 * - ⌘P / Ctrl+P — QUICK OPEN: expands the panel, ensures a files window
 *   (activating an existing path-less editor tab or minting a fresh home),
 *   and focuses its search box (type-ahead file open);
 * - ⌘⇧E / Ctrl+Shift+E — TOGGLE EXPLORER (VSCode's `workbench.view.explorer`,
 *   with the Activity Bar explorer icon's close-on-second-press parity): in
 *   the vscode layout this toggles the Side Bar drawer (the tree column —
 *   IDE fullscreen pins it to the left edge and uses the same toggle); in
 *   the docked layout a FILE tab (with a path) toggles its own docked tree
 *   (the keyboard equivalent of the editor header's folder-icon button), and
 *   the files home window reveals — or closes on a second press when it is
 *   the one in view (the same path quick-open uses, minus the search focus);
 * - ⌘⇧G / Ctrl+Shift+G — SHOW SOURCE CONTROL (VSCode's
 *   `workbench.view.scm`): expands the panel and opens/focuses the git tab;
 * - ⌘⌥⇧B / Ctrl+Alt+Shift+B — TOGGLE IDE FULLSCREEN: the right panel covers
 *   the whole viewport (a standalone VSCode-window-like state); entering
 *   opens the panel, the exit button / same key restores the docked size.
 *   This is THE enter/exit hotkey of the mode — the other panel keys keep
 *   their ordinary meanings inside it: ⌘B toggles the IDE's left explorer
 *   drawer, ⌘⇧B toggles its right Side Chat column, ⌘⇧J maximizes the
 *   docked bottom box;
 * - ⌘F / Ctrl+F — focuses the files search box when the active tab IS a
 *   files window (yields to the host otherwise — no blanket stealing);
 * - ⌘Tab / ⌘Shift+Tab — cycle next / previous tab of the active pane;
 * - ⌘1…⌘9 — jump to the nth tab of the active pane;
 * - ⌘W — close the active tab (⌘⇧W is a fallback alias: desktop shells
 *   whose Electron menu claims ⌘W ("Close Window") consume the chord at the
 *   MAIN PROCESS before the page ever sees the keydown — no renderer
 *   listener can intercept it — so the alias offers the same
 *   close-active-tab action on a chord the shell leaves alone. ⌥W was the
 *   browser-safe member of the set (browsers reserve BOTH ⌘W and ⌘⇧W, so a
 *   page never sees either) but is PARKED (commented out below) while the
 *   desktop ⌘W claim channel is live — re-enable it only if a plain-browser
 *   deployment needs the close chord again. Once the shell drops the ⌘W
 *   accelerator, the ⌘W binding takes over with identical semantics).
 *
 * All tab-strip keys are gated on `focusInSidebar` (the user is actually
 * interacting with the panel) and free of the + menu; the fetch-style keys
 * (⌘P / ⌘F) yield while the user types outside the sidebar. `Cmd` matches
 * the platform command modifier (⌘ on macOS, Ctrl elsewhere). The show-view
 * keys (⌘⇧E / ⌘⇧G) are global like the panel toggles — VSCode's view
 * switching works from anywhere.
 */
import type { Context } from '../../context-types.ts'
import {
  activeTabOf, allLeaves, firstLeaf, moveTab, paneInArea, setSideBarOpen, togglePanel, toggleRightMaximized,
  type SidebarState, type SidebarTab, type SidebarStore,
} from '../state.ts'
import { KeybindingRuntime, focusSidebarSearchInput, sessionScopeOf, workingTabIdOf, type KeybindingDescriptor, type SidebarKeybindingContext } from '../keybindings.ts'
import { focusTabStripElement } from '../tab-surface.ts'
import { panelToggleBindings } from '../hotkeys.ts'
import { t } from '../locales.ts'

/** A path-less editor tab = the files HOME window (the search + tree). */
function isHomeTab(tab: SidebarTab): boolean {
  return tab.type === 'editor' && (tab.path === undefined || tab.path === '')
}

/**
 * The close-active-tab action shared by ⌘W / ⌘⇧W / ⌥W and the desktop ⌘W
 * claim. The target is the tab the user is actually WORKING in — the
 * focus-pinned tab (the one whose content holds the DOM focus), falling
 * back to the state's active tab (see `workingTabIdOf`): the state's active
 * pointer is a UI highlight that does not follow the focus across panes
 * (typing in the bottom pane's terminal while `activePane` points at the
 * right pane must close the BOTTOM tab).
 * Nothing to close (no target / no session) returns false — the chord is
 * explicitly handed back to the next binding / the host.
 */
function closeActiveTab(ctx: Context, store: SidebarStore, context: SidebarKeybindingContext): boolean {
  const tabId = workingTabIdOf(context.state)
  if (tabId === undefined) return false
  const scope = sessionScopeOf(ctx, store)
  if (scope === undefined) return false
  ctx.betterSidebar?.closeTab(tabId, scope)
  return true
}

/** The tab's persisted meta object (a malformed meta reads as empty) — the
 *  same rule EditorHost's `metaOf` uses for the docked tree flag. */
function tabMetaOf(tab: SidebarTab): Record<string, unknown> {
  return tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
}

/** Read the persisted docked-tree flag: an explicit meta wins; otherwise a
 *  path-less home tab defaults OPEN and a file tab defaults closed (the
 *  exact rule EditorHost's `treeOpenOf` applies). */
function treeOpenOf(tab: SidebarTab): boolean {
  const treeOpen = tabMetaOf(tab).treeOpen
  return typeof treeOpen === 'boolean' ? treeOpen : (tab.path === undefined || tab.path === '')
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

/**
 * The shortcut's default box: a window a show-view / quick-open key opens
 * presents in the RIGHT panel, never in a bottom-panel pane the global
 * `activePane` happened to point at (e.g. ⌘⇧G pressed while a bottom
 * terminal held the pane focus). Two steps in one reducer:
 *
 *  1. PIN — the landing pane becomes the right panel's receiving pane
 *     (`paneInArea('right')`: the last pane the user touched inside the
 *     right tree, else its first leaf), so a NEWLY created window lands in
 *     the right box;
 *  2. PULL — a matching window already PARKED in the bottom tree (an
 *     earlier open landed there, or a persisted layout carries it) is
 *     moved into that pane: the shortcut must not present its window in a
 *     bottom pane — and since the pulled types are single-instance (git)
 *     or dedupe by key (the files home), a window that ever got stuck at
 *     the bottom would otherwise keep being focused there on every press.
 *
 * A target already inside the right tree stays where the user arranged it
 * (splits within the right panel survive); only the pane pin applies then.
 */
function pullToRightPanel(store: SidebarStore, matches: (tab: SidebarTab) => boolean): void {
  store.reduce(state => {
    const target = paneInArea(state, 'right')
    for (const leaf of allLeaves(state.bottomSplits)) {
      const parked = leaf.tabs.find(matches)
      if (parked !== undefined) return moveTab(state, leaf.id, parked.id, target)
    }
    return state.activePane === target ? state : { ...state, activePane: target }
  })
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
    const scope = sessionScopeOf(ctx, store)
    if (scope === undefined) return
    ctx.betterSidebar?.activateTab(tabId, scope)
  }

  /**
   * Reveal the files home window (the docked-mode "explorer"): expand the
   * panel, point the active pane at the right panel's first leaf, and
   * activate an existing path-less files window — or mint a fresh one (tree
   * docked, the search box ready). Shared by quick-open (⌘P — which then
   * focuses the search) and show-explorer (⌘⇧E). Returns the home tab id
   * after the reveal (undefined when no session is current).
   */
  const revealFilesHome = (ctx: Context, store: SidebarStore): string | undefined => {
    store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
    // The shortcut's default box for the opened window is the RIGHT panel:
    // pin the landing pane there and pull a files home parked in the bottom
    // tree into it — the reveal must never present the window at the bottom
    // (findHomeTab below then finds it in the right tree and activates it).
    pullToRightPanel(store, isHomeTab)
    const state = store.getSnapshot().state
    if (state === undefined) return undefined
    const home = findHomeTab(state)
    if (home !== undefined) {
      activateTabById(home.id)
    } else {
      const scope = sessionScopeOf(ctx, store)
      if (scope !== undefined) {
        // A fresh files home (tree docked) — the search box is ready as
        // soon as the tab renders.
        ctx.betterSidebar?.openTab({ type: 'editor', title: t('files'), meta: { treeOpen: true } }, scope)
      }
    }
    return findHomeTab(store.getSnapshot().state!)?.id
  }

  const bindings: KeybindingDescriptor[] = [
    // ── Quick open / search focus ─────────────────────────────────────────
    {
      id: 'builtin:quick-open',
      title: () => t('hotkeyQuickOpen'),
      key: 'Cmd+P',
      when: context => !context.textEditing && !context.plusMenuOpen,
      run: () => {
        revealFilesHome(ctx, store)
        focusSearchSoon()
      },
    },
    {
      id: 'builtin:show-explorer',
      title: () => t('hotkeyShowExplorer'),
      key: 'Cmd+Shift+E',
      when: context => !context.plusMenuOpen,
      run: (_event, context) => {
        // ⌘⇧E TOGGLES the explorer (VSCode's "Show Explorer", but with the
        // Activity Bar explorer icon's close-on-second-press parity — in the
        // OPEN state the shortcut closes, so the keyboard and the icon never
        // disagree). In the vscode layout the explorer IS the Side Bar
        // drawer (open only while the panel is open too — a closed panel
        // hides it); IDE FULLSCREEN pins that drawer to the left edge and
        // uses the same toggle. In the docked layout it is the files home
        // window, which the shortcut closes when it is the one in view.
        const before = store.getSnapshot().state
        if (before !== undefined && !context.narrow
            && (store.getPrefs().sidebarLayout === 'vscode' || before.rightMaximized === true)) {
          const visible = before.panelOpen && before.sideBarOpen
          if (visible) {
            store.reduce(s => setSideBarOpen(s, false))
          } else {
            store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
            store.reduce(s => setSideBarOpen(s, true))
          }
          return
        }
        const active = before === undefined ? undefined : activeTabOf(before)
        // Docked layout, a FILE tab (with a path) in view: ⌘⇧E toggles THAT
        // tab's own docked tree — the keyboard equivalent of the editor
        // header's folder-icon button (persisted as meta.treeOpen, so the
        // header's highlight and the shortcut never disagree). The files
        // HOME window keeps its close-on-second-press semantics below.
        if (before?.panelOpen === true && active !== undefined
            && active.type === 'editor' && active.path !== undefined && active.path !== '') {
          ctx.betterSidebar?.updateTab(active.id, { meta: { ...tabMetaOf(active), treeOpen: !treeOpenOf(active) } })
          return
        }
        if (before?.panelOpen === true && active !== undefined && isHomeTab(active)) {
          const scope = sessionScopeOf(ctx, store)
          if (scope !== undefined) ctx.betterSidebar?.closeTab(active.id, scope)
          return
        }
        // The reveal CREATED/ACTIVATED a window: bring the REAL focus to its
        // strip tab so the created window is the working surface even when
        // ⌘⇧E came from the conversation area (VSCode view-switch parity).
        const homeId = revealFilesHome(ctx, store)
        if (homeId !== undefined) focusTabStripElement(homeId)
      },
    },
    {
      id: 'builtin:show-git',
      title: () => t('hotkeyShowGit'),
      key: 'Cmd+Shift+G',
      when: context => !context.plusMenuOpen,
      run: () => {
        // VSCode's "Show Source Control": the git tab is single (dedupe by
        // id), so an existing one focuses; a type-only open does not
        // auto-expand the panel, hence the explicit expand above. The
        // shortcut's window presents in the RIGHT panel by default (the
        // right box — never a bottom pane the activePane happened to point
        // at): pullToRightPanel pins the landing pane there AND pulls a git
        // tab parked in the bottom tree into it, so a git window stuck at
        // the bottom (an earlier open that landed in the active pane, or a
        // persisted layout) is not focused in place on every press. The
        // created/activated window then gets the REAL focus (its strip tab)
        // — a ⌘⇧G from the conversation leaves the user IN the sidebar, so
        // the next ⌘W targets the git tab, not the shell's close flow.
        store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
        pullToRightPanel(store, tab => tab.type === 'git')
        const scope = sessionScopeOf(ctx, store)
        if (scope === undefined) return
        ctx.betterSidebar?.openTab({ type: 'git' }, scope)
        focusTabStripElement('git')
      },
    },
    {
      id: 'builtin:toggle-ide',
      title: () => t('hotkeyIdeMode'),
      key: 'Cmd+Alt+Shift+B',
      when: context => !context.plusMenuOpen,
      run: () => {
        // ⌘⌥⇧B toggles the IDE fullscreen: the right panel covers the whole
        // viewport like a standalone VSCode window. Entering opens the panel
        // (a closed panel would otherwise show an empty fullscreen).
        store.reduce(toggleRightMaximized)
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
      run: (_event, context) => closeActiveTab(ctx, store, context),
    },
    {
      // The ⌘W fallback alias — shells whose Electron menu claims ⌘W never
      // deliver the chord to the page (see the header), so ⌘⇧W offers the
      // same action on a chord the shell leaves to the web contents. The
      // browser-only ⌥W member is PARKED while the desktop ⌘W claim channel
      // is live; uncomment to restore a close chord in plain browsers
      // (Edge/Chrome/Safari reserve BOTH ⌘W and ⌘⇧W at the browser layer).
      id: 'builtin:tab-close-active-alt',
      title: () => t('hotkeyCloseTab'),
      key: [
        'Cmd+Shift+W',
        // 'Alt+W', // parked 2026-08-28: desktop ⌘W claim is live; browsers
        // have no W-close chord while this stays disabled.
      ],
      when: context => context.focusInSidebar && !context.plusMenuOpen,
      run: (_event, context) => closeActiveTab(ctx, store, context),
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