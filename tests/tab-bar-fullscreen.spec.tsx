/**
 * Tab-strip fullscreen-toggle tests. The strip's right end (居右) carries a
 * toggle that expands the workbench panel over the chat-box region — a
 * CSS-mode maximize inside the app, NOT the browser Fullscreen API. The
 * expansion itself is the Sidebar shell's job (it measures the
 * conversation view's rect); the strip only renders the affordance:
 * `onToggleFullscreen` wires the click, `fullscreen` drives the enter/exit
 * state. Both are optional — legacy callers without the wiring get no
 * button. The button is a trailing flex child OUTSIDE the scrolling tab
 * list, so it never scrolls with the tabs.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { TabBar } from '../src/client/TabBar.tsx'
import type { SidebarTab } from '../src/client/state.ts'

/** Point the browser-language fallback at Chinese so the labels assert. */
function stubZh(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
  })
}

const ENTER_LABEL = '进入全屏'
const EXIT_LABEL = '退出全屏'

function mountBar(
  tabs: SidebarTab[],
  opts: { fullscreen?: boolean; onToggleFullscreen?: () => void } = {},
): { unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(TabBar, {
      paneId: 'pane:1',
      tabs,
      active: tabs[0]?.id ?? null,
      onActivate: () => {},
      onClose: () => {},
      onNewTab: () => {},
      newTabOptions: [],
      onDropTab: () => {},
      ...(opts.fullscreen !== undefined ? { fullscreen: opts.fullscreen } : {}),
      ...(opts.onToggleFullscreen !== undefined ? { onToggleFullscreen: opts.onToggleFullscreen } : {}),
    }))
  })
  return {
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** The fullscreen toggle button (null when the wiring is absent). */
function fullscreenButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[class*="tabBarFullscreen"]')
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const oneTab = (): SidebarTab[] => [{ id: 't1', type: 'terminal', title: 'Tab 1' }]

describe('TabBar fullscreen toggle (chat-box maximize)', () => {
  it('renders no button when the shell does not wire the toggle', () => {
    stubZh()
    mountBar(oneTab())
    expect(fullscreenButton()).toBeNull()
  })

  it("sits at the strip's right end, outside the scrolling tab list (居右)", () => {
    stubZh()
    const { unmount } = mountBar(oneTab(), { onToggleFullscreen: () => {} })
    const button = fullscreenButton()
    expect(button).not.toBeNull()
    // A direct child of the tab bar — NOT inside the scrollable list, so
    // overflowing tabs can never push it out of view.
    expect(button!.closest('[class*="tabList"]')).toBeNull()
    const bar = button!.parentElement
    expect(bar).not.toBeNull()
    expect(bar!.className).toMatch(/tabBar/)
    // The trailing flex child (居右): the button is the bar's LAST element.
    expect(bar!.lastElementChild).toBe(button!)
    const list = bar!.querySelector<HTMLElement>('[class*="tabList"]')
    expect(list).not.toBeNull()
    expect(list!.compareDocumentPosition(button!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    unmount()
  })

  it('calls onToggleFullscreen on click and shows the enter state', () => {
    stubZh()
    const onToggleFullscreen = vi.fn()
    const { unmount } = mountBar(oneTab(), { onToggleFullscreen })
    const button = fullscreenButton()!
    expect(button.getAttribute('aria-label')).toBe(ENTER_LABEL)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('title')).toBe(ENTER_LABEL)
    act(() => { button.click() })
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('shows the exit state while the panel fills the chat box', () => {
    stubZh()
    const { unmount } = mountBar(oneTab(), { fullscreen: true, onToggleFullscreen: () => {} })
    const button = fullscreenButton()!
    expect(button.getAttribute('aria-label')).toBe(EXIT_LABEL)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('title')).toBe(EXIT_LABEL)
    unmount()
  })
})