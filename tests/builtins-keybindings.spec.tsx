/**
 * The built-in view-switching keybindings (⌘⇧E show explorer / ⌘⇧G show
 * source control), registered through the ONE shared runtime with the panel
 * toggles and quick-open. Wired exactly like the client apply does: a real
 * store, the service, and a runtime whose context builder reads the store —
 * then the bindings are exercised through `runtime.dispatch` with bare
 * event-like objects.
 *
 * - ⌘⇧E (docked): expands the panel and reveals the files home window (the
 *   docked "explorer"), the same path ⌘P uses minus the search focus;
 * - ⌘⇧E (vscode layout): expands the panel and the Side Bar explorer drawer;
 * - ⌘⇧G: expands the panel and opens/focuses the git tab (single — a second
 *   press does not mint a second tab);
 * - both yield while a + menu is open (no stealing inside the menu).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerBuiltinKeybindings } from '../src/client/builtins/keybindings.ts'
import { focusTabSurface, hasInteractiveAncestor, tabSurfaceProps } from '../src/client/tab-surface.ts'
import {
  KeybindingRuntime, getFocusedTabId, setFocusedTabId,
  type KeybindingEventLike,
  type SidebarKeybindingContext,
} from '../src/client/keybindings.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import {
  activePaneTabsOf, activeTabOf, allLeaves, createSidebarStore, firstLeaf, moveTab, toggleRightMaximized,
  type SidebarStore, type SidebarTab,
} from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'

/** A bare event-like object for the pure dispatch (no DOM needed). */
function like(overrides: Partial<KeybindingEventLike>): KeybindingEventLike {
  return {
    code: 'KeyE',
    key: 'e',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    ...overrides,
  }
}

afterEach(() => {
  setFocusedTabId(null)
})

/** Wire the builtin bindings exactly like the client apply does. The
 *  context's tab fields resolve live from the store (like the real apply's
 *  context builder); `overrides` pins the rest (focusInSidebar etc.). */
function setup(
  layout: 'docked' | 'vscode' = 'docked',
  overrides: Partial<SidebarKeybindingContext> = {},
): {
  store: SidebarStore
  runtime: KeybindingRuntime
  dispose: () => void
  setMenuOpen: (open: boolean) => void
  ctx: Context
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // The descriptors openTab/activateTab resolve against.
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: tab => tab.path, component: () => null })
  service.registerTab({ id: 'git', title: 'Git', single: true, component: () => null })
  store.setPrefs({ ...store.getPrefs(), sidebarLayout: layout })
  store.setSession('s1')
  const sessionsSnapshot = { byId: { s1: { cwd: '/repo' } }, current: 's1' }
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
  } as unknown as Context
  let menuOpen = false
  const runtime = new KeybindingRuntime((): SidebarKeybindingContext => {
    const state = store.getSnapshot().state ?? null
    const activeTab = state === null ? undefined : activeTabOf(state)
    const base: SidebarKeybindingContext = {
      state,
      narrow: false,
      focusInSidebar: false,
      textEditing: false,
      plusMenuOpen: menuOpen,
      searchActive: false,
      activeTab: activeTab ?? null,
      activeTabType: activeTab?.type ?? '',
      activePaneTabs: state === null ? [] : activePaneTabsOf(state),
    }
    // Live focus resolution (like the real apply's context builder) unless a
    // test pins the flags via overrides.
    if (overrides.focusInSidebar === undefined || overrides.textEditing === undefined) {
      try {
        const activeElement = document.activeElement as HTMLElement | null
        if (activeElement !== null) {
          const inside = activeElement.closest?.('[data-dsh-better-sidebar]') !== null
          if (overrides.focusInSidebar === undefined) base.focusInSidebar = inside
          if (overrides.textEditing === undefined) {
            base.textEditing = !inside
              && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)
          }
        }
      } catch {
        // Degraded focus context: keep the defaults.
      }
    }
    return { ...base, ...overrides }
  })
  const dispose = registerBuiltinKeybindings(runtime, ctx, store)
  return { store, runtime, dispose, setMenuOpen: open => { menuOpen = open }, ctx }
}

describe('builtin view-switch keybindings (⌘⇧E explorer / ⌘⇧G source control)', () => {
  it('⌘⇧E in the docked layout expands the panel and reveals the files home — a second press CLOSES it', () => {
    const { store, runtime, dispose } = setup()
    try {
      // Pin the precondition: the panel closed, the seeded home tab present.
      store.reduce(state => ({ ...state, panelOpen: false }))
      expect(store.getSnapshot().state?.panelOpen).toBe(false)

      expect(runtime.dispatch(like({ code: 'KeyE', metaKey: true, shiftKey: true }))).toBe(true)

      const state = store.getSnapshot().state!
      expect(state.panelOpen).toBe(true)
      // The active tab is the path-less files home — the docked explorer.
      const active = activeTabOf(state)
      expect(active?.type).toBe('editor')
      expect(active?.path === undefined || active?.path === '').toBe(true)

      // In the OPEN state the same key CLOSES the explorer window (the
      // Activity Bar explorer icon's close-on-second-press parity).
      expect(runtime.dispatch(like({ code: 'KeyE', metaKey: true, shiftKey: true }))).toBe(true)
      const homeTabs = allLeaves(store.getSnapshot().state!.splits)
        .flatMap(leaf => leaf.tabs)
        .filter(tab => tab.type === 'editor' && (tab.path === undefined || tab.path === ''))
      expect(homeTabs).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('⌘⇧E in the docked layout TOGGLES the docked tree of the active FILE tab (the keyboard equivalent of the header button)', () => {
    const { store, runtime, dispose, ctx } = setup()
    try {
      // A file tab (path set): the docked tree is its per-tab toggle target.
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'main.ts', path: '/repo/main.ts' })
      let active = activeTabOf(store.getSnapshot().state!)
      expect(active?.type).toBe('editor')
      expect(active?.path).toBe('/repo/main.ts')
      // A file tab defaults to the tree CLOSED (no treeOpen meta yet).
      expect(active?.meta === undefined || (active.meta as Record<string, unknown>).treeOpen !== true).toBe(true)

      // First press: the docked tree OPENS (meta.treeOpen → true); the tab
      // itself survives — ⌘⇧E toggles the tree, not the window.
      expect(runtime.dispatch(like({ code: 'KeyE', metaKey: true, shiftKey: true }))).toBe(true)
      active = activeTabOf(store.getSnapshot().state!)
      expect((active?.meta as Record<string, unknown>).treeOpen).toBe(true)

      // Second press: CLOSES again — a toggle, never a one-way reveal.
      expect(runtime.dispatch(like({ code: 'KeyE', metaKey: true, shiftKey: true }))).toBe(true)
      active = activeTabOf(store.getSnapshot().state!)
      expect((active?.meta as Record<string, unknown>).treeOpen).toBe(false)

      // The file tab is still open (only its tree toggled).
      const fileTabs = allLeaves(store.getSnapshot().state!.splits)
        .flatMap(leaf => leaf.tabs)
        .filter(tab => tab.type === 'editor' && tab.path !== undefined && tab.path !== '')
      expect(fileTabs.map(t => t.path)).toContain('/repo/main.ts')
    } finally {
      dispose()
    }
  })

  it('⌘⇧E in IDE FULLSCREEN (docked layout) TOGGLES the Side Bar drawer — the tree column in IDE mode', () => {
    const { store, runtime, dispose } = setup('docked')
    try {
      // Enter IDE fullscreen: the drawer defaults EXPANDED (the left-edge
      // tree column is part of the IDE window).
      store.reduce(toggleRightMaximized)
      expect(store.getSnapshot().state?.rightMaximized).toBe(true)
      expect(store.getSnapshot().state?.sideBarOpen).toBe(true)

      // Open → closed (the Activity Bar explorer icon's toggle parity).
      expect(runtime.dispatch(like({ code: 'KeyE', metaKey: true, shiftKey: true }))).toBe(true)
      expect(store.getSnapshot().state?.sideBarOpen).toBe(false)

      // Closed → open.
      expect(runtime.dispatch(like({ code: 'KeyE', metaKey: true, shiftKey: true }))).toBe(true)
      expect(store.getSnapshot().state?.sideBarOpen).toBe(true)

      // Exiting the IDE restores the drawer to its pre-IDE value (open).
      store.reduce(toggleRightMaximized)
      expect(store.getSnapshot().state?.rightMaximized).toBe(false)
      expect(store.getSnapshot().state?.sideBarOpen).toBe(true)
    } finally {
      dispose()
    }
  })

  it('⌘⇧E in the vscode layout TOGGLES the Side Bar drawer', () => {
    const { store, runtime, dispose } = setup('vscode')
    try {
      store.reduce(state => ({ ...state, panelOpen: false, sideBarOpen: false }))
      expect(store.getSnapshot().state?.sideBarOpen).toBe(false)

      // Closed → open.
      expect(runtime.dispatch(like({ code: 'KeyE', metaKey: true, shiftKey: true }))).toBe(true)
      let state = store.getSnapshot().state!
      expect(state.panelOpen).toBe(true)
      expect(state.sideBarOpen).toBe(true)

      // Open → closed (the Activity Bar explorer icon's toggle parity).
      expect(runtime.dispatch(like({ code: 'KeyE', metaKey: true, shiftKey: true }))).toBe(true)
      state = store.getSnapshot().state!
      expect(state.sideBarOpen).toBe(false)
    } finally {
      dispose()
    }
  })

  it('⌘⇧E in the vscode layout opens a hidden drawer (panel closed) instead of closing it', () => {
    const { store, runtime, dispose } = setup('vscode')
    try {
      // The drawer state is open but the PANEL is closed — the drawer is
      // not in view, so the shortcut must OPEN, never close.
      store.reduce(state => ({ ...state, panelOpen: false, sideBarOpen: true }))

      expect(runtime.dispatch(like({ code: 'KeyE', metaKey: true, shiftKey: true }))).toBe(true)

      const state = store.getSnapshot().state!
      expect(state.panelOpen).toBe(true)
      expect(state.sideBarOpen).toBe(true)
    } finally {
      dispose()
    }
  })

  it('⌘⇧G opens the git tab (single: a second press focuses, never duplicates)', () => {
    const { store, runtime, dispose } = setup()
    try {
      store.reduce(state => ({ ...state, panelOpen: false }))
      expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs).filter(tab => tab.type === 'git')).toHaveLength(0)

      expect(runtime.dispatch(like({ code: 'KeyG', metaKey: true, shiftKey: true }))).toBe(true)
      expect(store.getSnapshot().state?.panelOpen).toBe(true)
      expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs).filter(tab => tab.type === 'git')).toHaveLength(1)

      // A second press dedupes onto the existing tab.
      expect(runtime.dispatch(like({ code: 'KeyG', metaKey: true, shiftKey: true }))).toBe(true)
      expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs).filter(tab => tab.type === 'git')).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('⌘⇧G opens the git window in the RIGHT panel even when the active pane is the bottom panel', () => {
    const { store, runtime, dispose } = setup()
    try {
      // The user's last interaction was a bottom-panel pane (e.g. a
      // terminal): the shortcut's window must default to the RIGHT box.
      const bottomPane = firstLeaf(store.getSnapshot().state!.bottomSplits).id
      store.reduce(state => ({ ...state, activePane: bottomPane, bottomOpen: true, panelOpen: false }))
      expect(activeTabOf(store.getSnapshot().state!)).toBeUndefined()

      expect(runtime.dispatch(like({ code: 'KeyG', metaKey: true, shiftKey: true }))).toBe(true)

      const state = store.getSnapshot().state!
      // The git window was created in the RIGHT tree — never in a bottom pane.
      expect(allLeaves(state.splits).flatMap(leaf => leaf.tabs).filter(tab => tab.type === 'git')).toHaveLength(1)
      expect(allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs).filter(tab => tab.type === 'git')).toHaveLength(0)
      // …and the landing pane now points into the right tree.
      expect(state.activePane).toBe(firstLeaf(state.splits).id)
      expect(state.activePane).not.toBe(bottomPane)
    } finally {
      dispose()
    }
  })

  it('⌘⇧G pulls a git tab parked in the bottom panel into the right panel', () => {
    const { store, runtime, dispose, ctx } = setup()
    try {
      // Park the single git tab at the bottom (an earlier open that landed
      // in the active pane, or a persisted layout).
      const bottomPane = firstLeaf(store.getSnapshot().state!.bottomSplits).id
      store.reduce(state => ({ ...state, activePane: bottomPane }))
      ctx.betterSidebar?.openTab({ type: 'git' })
      expect(allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs).filter(tab => tab.type === 'git')).toHaveLength(1)

      // The show-view press must not focus it IN PLACE at the bottom: the
      // shortcut's window presents in the right box.
      expect(runtime.dispatch(like({ code: 'KeyG', metaKey: true, shiftKey: true }))).toBe(true)

      const state = store.getSnapshot().state!
      const gitTabs = allLeaves(state.splits).concat(allLeaves(state.bottomSplits))
        .flatMap(leaf => leaf.tabs)
        .filter(tab => tab.type === 'git')
      // Still one instance — the move REPLACED the park, never duplicated.
      expect(gitTabs).toHaveLength(1)
      expect(allLeaves(state.splits).flatMap(leaf => leaf.tabs).some(tab => tab.type === 'git')).toBe(true)
      expect(allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs).some(tab => tab.type === 'git')).toBe(false)
      expect(state.activePane).toBe(firstLeaf(state.splits).id)
    } finally {
      dispose()
    }
  })

  it('⌘P reveals the files home in the RIGHT panel — a home parked in the bottom panel is pulled into the right tree', () => {
    const { store, runtime, dispose } = setup()
    try {
      const isHome = (tab: SidebarTab): boolean =>
        tab.type === 'editor' && (tab.path === undefined || tab.path === '')
      // Park the seeded files home in the bottom tree (a bottom-parked
      // files window); moveTab also points the active pane at the bottom.
      store.reduce(state => {
        const home = allLeaves(state.splits).flatMap(leaf => leaf.tabs).find(isHome)!
        const source = allLeaves(state.splits).find(leaf => leaf.tabs.some(tab => tab.id === home.id))!
        return moveTab(state, source.id, home.id, firstLeaf(state.bottomSplits).id)
      })
      let state = store.getSnapshot().state!
      expect(allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs).some(isHome)).toBe(true)
      expect(allLeaves(state.splits).flatMap(leaf => leaf.tabs).some(isHome)).toBe(false)

      expect(runtime.dispatch(like({ code: 'KeyP', metaKey: true }))).toBe(true)

      state = store.getSnapshot().state!
      // The quick-open window presents in the RIGHT tree, the active pane
      // left the bottom panel.
      expect(allLeaves(state.splits).flatMap(leaf => leaf.tabs).some(isHome)).toBe(true)
      expect(allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs).some(isHome)).toBe(false)
      expect(state.activePane).toBe(firstLeaf(state.splits).id)
    } finally {
      dispose()
    }
  })

  it('⌘⌥⇧B toggles IDE fullscreen (the right panel covers the viewport)', () => {
    const { store, runtime, dispose } = setup()
    try {
      store.reduce(state => ({ ...state, panelOpen: false }))
      expect(store.getSnapshot().state?.rightMaximized).toBe(false)

      // Entering opens a closed panel AND fullscreens it.
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true, altKey: true, shiftKey: true }))).toBe(true)
      let state = store.getSnapshot().state!
      expect(state.panelOpen).toBe(true)
      expect(state.rightMaximized).toBe(true)

      // The same key exits back to the docked layout (the panel stays open).
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true, altKey: true, shiftKey: true }))).toBe(true)
      state = store.getSnapshot().state!
      expect(state.panelOpen).toBe(true)
      expect(state.rightMaximized).toBe(false)
    } finally {
      dispose()
    }
  })

  it('⌘B inside IDE FULLSCREEN toggles the EXPLORER drawer — the host sidebar is never touched', () => {
    const { store, runtime, dispose, ctx } = setup()
    try {
      // Pin the host-toggle spy: the IDE branch must RE-ROUTE ⌘B to the IDE
      // window's own left column instead of the host (which sits behind the
      // fullscreen cover — a host toggle would be invisible).
      const get = vi.fn(() => undefined)
      ;(ctx as unknown as { get: (name: string) => unknown }).get = get
      // Enter IDE fullscreen: the left explorer drawer defaults EXPANDED.
      store.reduce(toggleRightMaximized)
      expect(store.getSnapshot().state?.rightMaximized).toBe(true)
      expect(store.getSnapshot().state?.sideBarOpen).toBe(true)

      // First press COLLAPSES the left column ("左侧 sider 收起" in the IDE)…
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true }))).toBe(true)
      expect(store.getSnapshot().state?.sideBarOpen).toBe(false)
      expect(get).not.toHaveBeenCalled()

      // …a second press EXPANDS it again (a toggle, like the drawer icon /
      // ⌘⇧E — never a one-way collapse).
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true }))).toBe(true)
      expect(store.getSnapshot().state?.sideBarOpen).toBe(true)
    } finally {
      dispose()
    }
  })

  it('⌘⇧B toggles the IDE chat column INSIDE fullscreen and passes through outside it', () => {
    const { store, runtime, dispose } = setup()
    try {
      const chatOpen = (): boolean | undefined => store.getSnapshot().state?.chatOpen
      // Outside IDE mode the chord is unbound: not consumed, no state change.
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true, shiftKey: true }))).toBe(false)
      expect(chatOpen()).toBe(true) // the column defaults expanded

      store.reduce(toggleRightMaximized)
      expect(store.getSnapshot().state?.rightMaximized).toBe(true)
      expect(chatOpen()).toBe(true) // entering defaults the column expanded

      // First press COLLAPSES the right column ("右侧收起" in the IDE)…
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true, shiftKey: true }))).toBe(true)
      expect(chatOpen()).toBe(false)
      // …a second press EXPANDS it again.
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true, shiftKey: true }))).toBe(true)
      expect(chatOpen()).toBe(true)

      // Exiting the IDE restores the passthrough (⌘⇧B is a host/page key
      // outside the mode — the runtime must not swallow it).
      store.reduce(toggleRightMaximized)
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true, shiftKey: true }))).toBe(false)
    } finally {
      dispose()
    }
  })

  it('⌘⇧J inside IDE FULLSCREEN expands the docked bottom box upward (maximize / restore)', () => {
    const { store, runtime, dispose } = setup()
    try {
      // Inside IDE mode the bottom workbench docks BELOW the editor tabs;
      // ⌘⇧J maximizes it — "下侧 box 向上展开".
      store.reduce(toggleRightMaximized)
      expect(store.getSnapshot().state?.bottomMaximized).toBe(false)

      expect(runtime.dispatch(like({ code: 'KeyJ', metaKey: true, shiftKey: true }))).toBe(true)
      let state = store.getSnapshot().state!
      expect(state.bottomOpen).toBe(true)
      expect(state.bottomMaximized).toBe(true)

      // The same key restores the drag height (the panel stays open).
      expect(runtime.dispatch(like({ code: 'KeyJ', metaKey: true, shiftKey: true }))).toBe(true)
      state = store.getSnapshot().state!
      expect(state.bottomOpen).toBe(true)
      expect(state.bottomMaximized).toBe(false)
    } finally {
      dispose()
    }
  })

  it('⌘⌥B inside IDE FULLSCREEN toggles ONLY the Side Chat column — the mode and the panel survive', () => {
    const { store, runtime, dispose } = setup()
    try {
      store.reduce(toggleRightMaximized)
      expect(store.getSnapshot().state?.rightMaximized).toBe(true)
      expect(store.getSnapshot().state?.panelOpen).toBe(true)
      expect(store.getSnapshot().state?.chatOpen).toBe(true)

      // "The right panel" of the IDE window IS its Side Chat column: ⌘⌥B
      // collapses ONLY that ("只收起右侧的 chat 面板") — the fullscreen
      // cover and the mode itself must survive.
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true, altKey: true }))).toBe(true)
      let state = store.getSnapshot().state!
      expect(state.chatOpen).toBe(false)
      expect(state.rightMaximized).toBe(true)
      expect(state.panelOpen).toBe(true)

      // A second press expands the chat column again.
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true, altKey: true }))).toBe(true)
      state = store.getSnapshot().state!
      expect(state.chatOpen).toBe(true)

      // Outside the mode the plain panel open/close toggle applies again.
      store.reduce(toggleRightMaximized)
      expect(runtime.dispatch(like({ code: 'KeyB', metaKey: true, altKey: true }))).toBe(true)
      state = store.getSnapshot().state!
      expect(state.panelOpen).toBe(false)
    } finally {
      dispose()
    }
  })

  it('both view keys yield while a + menu is open', () => {
    const { store, runtime, dispose, setMenuOpen } = setup()
    try {
      store.reduce(state => ({ ...state, panelOpen: false }))
      setMenuOpen(true)
      expect(runtime.dispatch(like({ code: 'KeyE', metaKey: true, shiftKey: true }))).toBe(false)
      expect(runtime.dispatch(like({ code: 'KeyG', metaKey: true, shiftKey: true }))).toBe(false)
      expect(store.getSnapshot().state?.panelOpen).toBe(false)
    } finally {
      dispose()
    }
  })

  it('⌘W closes the active tab while the sidebar is focused — ⌘⇧W / ⌥W are the fallback aliases (shells/browsers swallow the ⌘ chords)', () => {
    const { store, runtime, dispose, ctx } = setup('docked', { focusInSidebar: true })
    try {
      const tabs = (): SidebarTab[] => activePaneTabsOf(store.getSnapshot().state!)
      const active = (): SidebarTab | undefined => activeTabOf(store.getSnapshot().state!)
      // Three file tabs side by side (distinct ids — a bare `type:'editor'`
      // seed would collapse onto the id safety net, since the openTab
      // default id is the TYPE).
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts', id: 'editor:/a.ts' })
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'b.ts', path: '/b.ts', id: 'editor:/b.ts' })
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'c.ts', path: '/c.ts', id: 'editor:/c.ts' })
      expect(tabs().length).toBeGreaterThanOrEqual(3)
      const first = active()!

      // ⌘W consumes the chord and closes ONLY the active tab.
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(true)
      expect(tabs().some(tab => tab.id === first.id)).toBe(false)

      // ⌘⇧W — the alias for Electron shells whose menu claims ⌘W at the
      // main process — closes the active tab exactly the same way.
      const second = active()!
      expect(second.id).not.toBe(first.id)
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true, shiftKey: true }))).toBe(true)
      expect(tabs().some(tab => tab.id === second.id)).toBe(false)

      // ⌘⇧W again closes the next one (the third file tab).
      const third = active()!
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true, shiftKey: true }))).toBe(true)
      expect(tabs().some(tab => tab.id === third.id)).toBe(false)

      // The remaining tab (the seeded files home, path-less) closes too —
      // ⌘W keeps working while ANY tab is active.
      const fourth = active()
      if (fourth !== undefined) {
        expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(true)
      }
      expect(active()).toBeUndefined()

      // With NOTHING active left, both chords yield to the host — never
      // swallowing the chord blindly.
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(false)
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true, shiftKey: true }))).toBe(false)
      // ⌥W is PARKED (the desktop ⌘W claim channel is live) — the alias
      // binding must NOT consume the chord anymore.
      expect(runtime.dispatch(like({ code: 'KeyW', altKey: true }))).toBe(false)
    } finally {
      dispose()
    }
  })

  it('⌘W / ⌘⇧W pass through untouched when the focus is outside the sidebar; parked ⌥W is never consumed', () => {
    const { store, runtime, dispose, ctx } = setup('docked', { focusInSidebar: false })
    try {
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts', id: 'editor:/a.ts' })
      expect(activeTabOf(store.getSnapshot().state!)?.path).toBe('/a.ts')

      // Sidebar focus is the whole gate: outside it the chords are the
      // host's business (Electron's Close Window / the browser's own keys).
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(false)
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true, shiftKey: true }))).toBe(false)
      // ⌥W parked: not registered at all, so it is inert in every context.
      expect(runtime.dispatch(like({ code: 'KeyW', altKey: true }))).toBe(false)
      expect(activeTabOf(store.getSnapshot().state!)?.path).toBe('/a.ts')
    } finally {
      dispose()
    }
  })

  it('⌘W closes the tab the user is actually working in — the focus-pinned tab, not the state-active highlight', () => {
    const { store, runtime, dispose, ctx } = setup('docked', { focusInSidebar: true })
    try {
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts', id: 'editor:/a.ts' })
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'b.ts', path: '/b.ts', id: 'editor:/b.ts' })
      const tabs = (): SidebarTab[] => activePaneTabsOf(store.getSnapshot().state!)
      const stateActive = activeTabOf(store.getSnapshot().state!)!
      // The user's focus sits in ANOTHER tab's content (e.g. the bottom
      // pane's terminal while `activePane` still points at this pane).
      const working = tabs().find(tab => tab.id !== stateActive.id)!
      setFocusedTabId(working.id)
      try {
        expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(true)
        expect(tabs().some(tab => tab.id === working.id)).toBe(false)
        // The state-active tab SURVIVES — only the working surface closed.
        expect(activeTabOf(store.getSnapshot().state!)?.id).toBe(stateActive.id)
      } finally {
        setFocusedTabId(null)
      }

      // A stale pin (tab already closed / another session's tab) falls back
      // to the state-active tab.
      const next = activeTabOf(store.getSnapshot().state!)!
      setFocusedTabId('editor:/ghost')
      try {
        expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(true)
        expect(activeTabOf(store.getSnapshot().state!)?.id).not.toBe(next.id)
      } finally {
        setFocusedTabId(null)
      }
    } finally {
      dispose()
    }
  })

  it('a freshly opened / activated tab is the W-close target WITHOUT any click into its body', () => {
    const { store, runtime, dispose, ctx } = setup('docked', { focusInSidebar: true })
    try {
      // Opening a tab pins it via the service — no content focus needed:
      // the opened tab IS the user's working surface (browser semantics).
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'b.ts', path: '/b.ts', id: 'editor:/b.ts' })
      expect(getFocusedTabId()).toBe('editor:/b.ts')
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(true)
      expect(activePaneTabsOf(store.getSnapshot().state!).some(tab => tab.id === 'editor:/b.ts')).toBe(false)

      // Re-opening the same file creates it again AND pins it (create path).
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'b.ts', path: '/b.ts', id: 'editor:/b.ts' })
      expect(getFocusedTabId()).toBe('editor:/b.ts')
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(true)
      expect(activePaneTabsOf(store.getSnapshot().state!).some(tab => tab.id === 'editor:/b.ts')).toBe(false)

      // Activation (activateTab) pins too — the strip-click / quick-open path.
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts', id: 'editor:/a.ts' })
      ctx.betterSidebar?.activateTab('editor:/a.ts')
      expect(getFocusedTabId()).toBe('editor:/a.ts')
    } finally {
      dispose()
    }
  })

  it('a window created by a SHOW-VIEW key from the conversation becomes the focused working surface', () => {
    const { store, runtime, dispose } = setup('docked')
    try {
      // Mount a strip tab for the focus helper to target (the window ⌘⇧G
      // is about to create). The DOM focus is OUTSIDE the sidebar first.
      const host = document.createElement('div')
      host.setAttribute('data-dsh-better-sidebar', '')
      const strip = document.createElement('div')
      strip.setAttribute('data-dsh-tab-id', 'git')
      strip.setAttribute('tabindex', '0')
      host.appendChild(strip)
      document.body.appendChild(host)
      expect(document.activeElement).not.toBe(strip)

      // ⌘⇧G works globally (its when-clause has no focus gate), and the
      // created window gains the REAL focus…
      expect(runtime.dispatch(like({ code: 'KeyG', metaKey: true, shiftKey: true }))).toBe(true)
      expect(document.activeElement).toBe(strip)
      // …is pinned as the working surface…
      expect(getFocusedTabId()).toBe('git')

      // …so the very next ⌘W targets the created window (the strip lives
      // inside the host, so focusInSidebar resolves true live).
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(true)
      expect(activePaneTabsOf(store.getSnapshot().state!).some(tab => tab.id === 'git')).toBe(false)
    } finally {
      dispose()
      document.body.innerHTML = ''
    }
  })

  it('clicking a NO-FEEDBACK spot inside a tab activates that tab — interactive spots keep their own focus', () => {
    const { store, runtime, dispose, ctx } = setup('docked')
    try {
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts', id: 'editor:/a.ts' })
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'b.ts', path: '/b.ts', id: 'editor:/b.ts' })
      const bId = 'editor:/b.ts'
      const host = document.createElement('div')
      host.setAttribute('data-dsh-better-sidebar', '')
      const wrapper = document.createElement('div')
      wrapper.setAttribute('data-dsh-tab-id', bId)
      wrapper.setAttribute('tabindex', '-1')
      const blank = document.createElement('div') // a spot with no feedback
      wrapper.appendChild(blank)
      host.appendChild(wrapper)
      document.body.appendChild(host)

      // A click on the blank area (no interactive ancestor up to the wrapper)
      // focuses the wrapper — the click activates this tab.
      const props = tabSurfaceProps(bId)
      focusTabSurface({ button: 0, target: blank, currentTarget: wrapper })
      expect(document.activeElement).toBe(wrapper)
      // The tab is now the pinned working surface — ⌘W closes IT, not the
      // previously active tab.
      expect(getFocusedTabId()).toBe(bId)
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(true)
      expect(activePaneTabsOf(store.getSnapshot().state!).some(tab => tab.id === bId)).toBe(false)

      // Clicking an INTERACTIVE spot (an input) must NOT steal its focus:
      // the input keeps native focus, which still pins the same tab.
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      const input = document.createElement('input')
      wrapper.appendChild(input)
      focusTabSurface({ button: 0, target: input, currentTarget: wrapper })
      expect(document.activeElement).not.toBe(wrapper)
      // The interactive carve-out is threshold-tested directly.
      expect(hasInteractiveAncestor(input, wrapper)).toBe(true)
    } finally {
      dispose()
      document.body.innerHTML = ''
    }
  })

  it('closing a tab from a focused sidebar lands the focus on the NEXT tab that takes over', () => {
    const { store, runtime, dispose, ctx } = setup('docked')
    try {
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts', id: 'editor:/a.ts' })
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'b.ts', path: '/b.ts', id: 'editor:/b.ts' })
      const host = document.createElement('div')
      host.setAttribute('data-dsh-better-sidebar', '')
      const mkStrip = (id: string): HTMLDivElement => {
        const el = document.createElement('div')
        el.setAttribute('data-dsh-tab-id', id)
        el.setAttribute('tabindex', '0')
        host.appendChild(el)
        return el
      }
      const stripA = mkStrip('editor:/a.ts')
      const stripB = mkStrip('editor:/b.ts')
      document.body.appendChild(host)
      // The user is "in the sidebar", working on b (jsdom does not fire
      // focusin, so the pin is set explicitly — real browsers do this via
      // the strip focus).
      stripB.focus()
      setFocusedTabId('editor:/b.ts')
      expect(getFocusedTabId()).toBe('editor:/b.ts')

      // Close the ACTIVE tab (b — the last opened). The pane's post-close
      // active pointer is a, so the focus + pin must land on a's strip.
      ctx.betterSidebar?.closeTab('editor:/b.ts')
      expect(document.activeElement).toBe(stripA)
      expect(getFocusedTabId()).toBe('editor:/a.ts')
      // The very next ⌘W closes THAT tab — closing in sequence works.
      expect(runtime.dispatch(like({ code: 'KeyW', metaKey: true }))).toBe(true)
      expect(activePaneTabsOf(store.getSnapshot().state!).some(tab => tab.id === 'editor:/a.ts')).toBe(false)
    } finally {
      dispose()
      document.body.innerHTML = ''
    }
  })

  it('closing a tab from OUTSIDE the sidebar never steals the focus', () => {
    const { store, ctx, dispose } = setup('docked')
    try {
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts', id: 'editor:/a.ts' })
      ctx.betterSidebar?.openTab({ type: 'editor', title: 'b.ts', path: '/b.ts', id: 'editor:/b.ts' })
      const host = document.createElement('div')
      host.setAttribute('data-dsh-better-sidebar', '')
      const strip = document.createElement('div')
      strip.setAttribute('data-dsh-tab-id', 'editor:/a.ts')
      strip.setAttribute('tabindex', '0')
      host.appendChild(strip)
      document.body.appendChild(host)
      const outside = document.createElement('button')
      document.body.appendChild(outside)
      outside.focus() // the user is typing in the conversation

      ctx.betterSidebar?.closeTab('editor:/b.ts')
      expect(document.activeElement).toBe(outside)
    } finally {
      dispose()
      document.body.innerHTML = ''
    }
  })
})
