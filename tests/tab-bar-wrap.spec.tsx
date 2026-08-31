/**
 * The tab-strip layout toggle (the "ordinary file opens" surface of the same
 * wrap/scroll feature as the produced-files row): a strip with the store
 * renders the wrap toggle at its right end; the `tabStripWrap` pref flips
 * between single-line horizontal scroll (the default) and wrapping rows.
 * The strip subscribes to the SidebarStore, so the toggle re-renders it
 * immediately without a parent re-render.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import './browser-globals.ts'
import { TabBar } from '../src/client/TabBar.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { api } from '../src/client/api.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** Mount a strip with (optionally) the store; returns container refs. */
function mountBar(store?: SidebarStore): { container: HTMLElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(TabBar, {
      paneId: 'pane:1',
      tabs: [
        { id: 't1', type: 'editor', title: 'a.ts' },
        { id: 't2', type: 'editor', title: 'b.ts' },
      ],
      active: 't1',
      onActivate: () => {},
      onClose: () => {},
      onNewTab: () => {},
      newTabOptions: [],
      onFloatTab: () => {},
      onDropTab: () => {},
      ...(store !== undefined ? { store } : {}),
    }))
  })
  return { container, root }
}

function tabBarOf(container: HTMLElement): HTMLElement {
  // The strip rows may carry extra classes (tabBarWrap); select by prefix.
  const bar = container.querySelector('[class*="tabBar"]') as HTMLElement
  expect(bar).not.toBeNull()
  return bar
}

function toggleOf(container: HTMLElement): HTMLButtonElement {
  const toggle = container.querySelector('button[aria-pressed]') as HTMLButtonElement
  expect(toggle).not.toBeNull()
  return toggle
}

beforeEach(() => { vi.restoreAllMocks() })

describe('TabBar wrap/scroll layout toggle', () => {
  it('renders the plain single-line strip when no store is given (legacy behavior)', () => {
    const { container, root } = mountBar()
    try {
      expect(tabBarOf(container).className).not.toContain('tabBarWrap')
      expect(container.querySelector('button[aria-pressed]')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('renders single-line by default with the toggle showing the wrap mode it can switch to', () => {
    const store = createSidebarStore()
    const { container, root } = mountBar(store)
    try {
      const bar = tabBarOf(container)
      expect(bar.className).not.toContain('tabBarWrap')
      const toggle = toggleOf(container)
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('flips the store pref on toggle and re-renders itself into wrap mode', () => {
    const store = createSidebarStore()
    const { container, root } = mountBar(store)
    try {
      const toggle = toggleOf(container)
      vi.spyOn(api, 'settingsUpdate').mockResolvedValue({
        value: { ...store.getPrefs(), tabStripWrap: true },
        revision: 2,
      })
      act(() => { toggle.click() })
      const bar = tabBarOf(container)
      expect(bar.className).toContain('tabBarWrap')
      expect(container.querySelector('[class*="tabList"]')!.className).toContain('tabListWrap')
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      // And back to the single-line scroll mode.
      act(() => { toggle.click() })
      expect(tabBarOf(container).className).not.toContain('tabBarWrap')
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('mounts already wrapping when the store pref is on', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), tabStripWrap: true })
    const { container, root } = mountBar(store)
    try {
      expect(tabBarOf(container).className).toContain('tabBarWrap')
      expect(toggleOf(container).getAttribute('aria-pressed')).toBe('true')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})