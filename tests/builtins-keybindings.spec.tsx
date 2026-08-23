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
import { describe, expect, it } from 'vitest'
import { registerBuiltinKeybindings } from '../src/client/builtins/keybindings.ts'
import {
  KeybindingRuntime,
  type KeybindingEventLike,
  type SidebarKeybindingContext,
} from '../src/client/keybindings.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import {
  activeTabOf, allLeaves, createSidebarStore,
  type SidebarStore,
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

/** Wire the builtin bindings exactly like the client apply does. */
function setup(layout: 'docked' | 'vscode' = 'docked'): {
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
  const runtime = new KeybindingRuntime((): SidebarKeybindingContext => ({
    state: store.getSnapshot().state ?? null,
    narrow: false,
    focusInSidebar: false,
    textEditing: false,
    plusMenuOpen: menuOpen,
    searchActive: false,
    activeTab: null,
    activeTabType: '',
    activePaneTabs: [],
  }))
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
})
