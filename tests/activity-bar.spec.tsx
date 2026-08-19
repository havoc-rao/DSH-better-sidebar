/**
 * ActivityBar: the VSCode-style icon strip that iconizes the + menu. It
 * derives its icons from the tab registry (non-hidden, enabled, sorted by
 * `order` — the same filter as the + menu), disables rows whose `available`
 * predicate is false, marks the active tab's type, and routes clicks through
 * the caller's `onOpen` (the same path the + menu takes). It carries no
 * state of its own, so the assertions are all about derivation + wiring.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { ActivityBar } from '../src/client/ActivityBar.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore, makeDefaultState, type SidebarState } from '../src/client/state.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** A minimal icon so the descriptor's icon resolves to a real node. */
const Icon = (): React.ReactNode => createElement('svg', { 'data-testid': 'ic' })

function setup(): {
  ctx: Context
  store: ReturnType<typeof createSidebarStore>
  state: SidebarState
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // Registered in non-sorted order; the bar must order them ascending. The
  // files window uses the BUILT-IN id 'editor' (the explorer-drawer toggle
  // special-cases that id), so register it under 'editor' with title "Files".
  service.registerTab({ id: 'terminal', title: 'Terminal', order: 40, icon: Icon, component: () => null })
  service.registerTab({ id: 'editor', title: 'Files', order: 10, icon: Icon, component: () => null })
  service.registerTab({ id: 'git', title: 'Git', order: 20, icon: Icon, component: () => null })
  // A hidden tab never appears in the bar (nor the + menu).
  service.registerTab({ id: 'diff', title: 'Diff', order: -1, hidden: true, icon: Icon, component: () => null })
  // A tab disabled in the side card settings is filtered out entirely.
  service.registerTab({ id: 'browser', title: 'Browser', order: 50, icon: Icon, component: () => null })
  store.setPrefs({ ...store.getPrefs(), tabsEnabled: { browser: false } })
  store.setSession('activity-bar-session')
  const ctx = { betterSidebar: service } as unknown as Context
  const state = store.getSnapshot().state ?? makeDefaultState()
  return { ctx, store, state }
}

/** Mount the bar; returns the container, the buttons by aria-label, unmount. */
function mountBar(ctx: Context, state: SidebarState, onOpen: (type: string) => void) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(ActivityBar, {
      ctx, state, scope: { sessionId: 'activity-bar-session' }, onOpen,
    }))
  })
  const buttons = (): HTMLButtonElement[] =>
    Array.from(container.querySelectorAll('button[aria-label]'))
  return {
    container,
    buttons,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

describe('ActivityBar', () => {
  it('iconizes the non-hidden, enabled tabs in order (the + menu filter)', () => {
    const { ctx, state } = setup()
    const { buttons, unmount } = mountBar(ctx, state, () => {})
    try {
      // files(10), git(20), terminal(40) — sorted ascending; diff hidden,
      // browser disabled in settings → both absent.
      expect(buttons().map(b => b.getAttribute('aria-label'))).toEqual(['Files', 'Git', 'Terminal'])
    } finally {
      unmount()
    }
  })

  it('routes a click through onOpen with the tab type (the + menu path)', () => {
    const { ctx, state } = setup()
    const onOpen = vi.fn()
    const { buttons, unmount } = mountBar(ctx, state, onOpen)
    try {
      act(() => { buttons().find(b => b.getAttribute('aria-label') === 'Git')!.click() })
      expect(onOpen).toHaveBeenCalledWith('git')
    } finally {
      unmount()
    }
  })

  it('marks the active tab type with aria-current', () => {
    const { ctx, store, state } = setup()
    // Open a git tab so it becomes the active tab of the pane.
    ;(ctx.betterSidebar as unknown as { openTab: (seed: { type: string }) => void }).openTab({ type: 'git' })
    const activeState = store.getSnapshot().state ?? state
    const { buttons, unmount } = mountBar(ctx, activeState, () => {})
    try {
      const git = buttons().find(b => b.getAttribute('aria-label') === 'Git')!
      const files = buttons().find(b => b.getAttribute('aria-label') === 'Files')!
      expect(git.getAttribute('aria-current')).toBe('true')
      expect(files.getAttribute('aria-current')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('disables a row whose available predicate is false (quota, etc.)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'terminal', title: 'Terminal', order: 40, icon: Icon,
      available: () => false, component: () => null,
    })
    store.setSession('q-session')
    const ctx = { betterSidebar: service } as unknown as Context
    const state = store.getSnapshot().state ?? makeDefaultState()
    const { buttons, unmount } = mountBar(ctx, state, () => {})
    try {
      const terminal = buttons().find(b => b.getAttribute('aria-label') === 'Terminal')!
      expect(terminal.disabled).toBe(true)
    } finally {
      unmount()
    }
  })

  it('with the explorer-drawer props, the files icon becomes the drawer toggle (label, highlight, click)', () => {
    const { ctx, state } = setup()
    const onOpen = vi.fn()
    const onToggleSideBar = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const buttons = (): HTMLButtonElement[] =>
      Array.from(container.querySelectorAll('button[aria-label]'))
    // Mount with sideBarOpen=true → the files icon is "Explorer" and active.
    act(() => {
      root.render(createElement(ActivityBar, {
        ctx, state, scope: { sessionId: 'activity-bar-session' }, onOpen,
        sideBarOpen: true, onToggleSideBar,
      }))
    })
    try {
      const explorer = buttons().find(b => b.getAttribute('aria-label') === 'Explorer')!
      // The editor descriptor (title "Files") is relabeled to the explorer
      // drawer toggle and highlighted while expanded.
      expect(explorer.getAttribute('aria-current')).toBe('true')
      // Other launchers keep their plain behavior (Git still opens a tab).
      const git = buttons().find(b => b.getAttribute('aria-label') === 'Git')!
      expect(git.getAttribute('aria-current')).toBeNull()
      act(() => { explorer.click() })
      expect(onToggleSideBar).toHaveBeenCalledTimes(1)
      expect(onOpen).not.toHaveBeenCalled()
      act(() => { git.click() })
      expect(onOpen).toHaveBeenCalledWith('git')
      // Collapsed → the explorer icon loses its highlight (same root).
      act(() => {
        root.render(createElement(ActivityBar, {
          ctx, state, scope: { sessionId: 'activity-bar-session' }, onOpen,
          sideBarOpen: false, onToggleSideBar,
        }))
      })
      const explorer2 = buttons().find(b => b.getAttribute('aria-label') === 'Explorer')!
      expect(explorer2.getAttribute('aria-current')).toBeNull()
    } finally {
      act(() => { root.unmount() }); container.remove()
    }
  })

  it('pins the Side Bar position toggle to the bar bottom and mirrors it when flipped', () => {
    const { ctx, state } = setup()
    const onToggleSideBarSide = vi.fn()
    const mount = (flipped: boolean) => {
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      act(() => {
        root.render(createElement(ActivityBar, {
          ctx, state, scope: { sessionId: 'activity-bar-session' }, onOpen: () => {},
          flipped, onToggleSideBarSide,
        }))
      })
      return { container, root, unmount: () => { act(() => { root.unmount() }); container.remove() } }
    }
    // Normal (bar at the right): the toggle button renders (the last
    // aria-label button) and clicking flips.
    const normal = mount(false)
    try {
      const toggle = [...normal.container.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
        .find(b => b.getAttribute('aria-label') === '切换文件树列位置')
        ?? [...normal.container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].at(-1)!
      act(() => { toggle.click() })
      expect(onToggleSideBarSide).toHaveBeenCalledTimes(1)
    } finally {
      normal.unmount()
    }
    // Flipped: the bar's root carries the flipped class (border/indicator
    // mirror) and the toggle still renders.
    const flipped = mount(true)
    try {
      expect(flipped.container.querySelector('[class*="activityBar"]')?.className)
        .toContain('activityBarFlipped')
      expect(flipped.container.querySelectorAll('button[aria-label]').length).toBeGreaterThanOrEqual(4)
    } finally {
      flipped.unmount()
    }
  })
})
