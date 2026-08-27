/**
 * The IDE-FULLSCREEN chat column (SideChatPane): mirrors the active pane's
 * side-chat tab (or the hero when none), collapses to width 0, drags to
 * resize, and — through the REAL Sidebar shell in IDE mode — suppresses the
 * chat tab's workbench cell (no double-mount) while the docked bottom panel
 * ends at the column's left edge.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const sidechatInfo = vi.fn()
const sidechatStart = vi.fn()
const historyEvents = vi.fn()
const sessionCwd = vi.fn()
const fsTree = vi.fn()
const gitStatus = vi.fn()
vi.mock('../src/client/api.ts', () => ({
  api: {
    sessionCwd: (...args: unknown[]) => sessionCwd(...args),
    sidechatInfo: (...args: unknown[]) => sidechatInfo(...args),
    sidechatStart: (...args: unknown[]) => sidechatStart(...args),
    fsTree: (...args: unknown[]) => fsTree(...args),
    gitStatus: (...args: unknown[]) => gitStatus(...args),
  },
  mediaUrl: () => '',
}))

import { SideChatPane } from '../src/client/SideChatPane.tsx'
import { Sidebar } from '../src/client/Sidebar.tsx'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import {
  createSidebarStore, makeDefaultState, openTabInActivePane, setChatOpen, toggleRightMaximized,
  type SidebarStore, type SidebarTab,
} from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'

/** jsdom has no WebSocket; the Sidebar's push effects construct one on mount. */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

/** A stably-snapshotted sessions-list fixture (uSES requires stability). */
function ctxFor(
  store: SidebarStore,
  service: BetterSidebarService,
  sessionId: string,
  byId: Record<string, unknown>,
): never {
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = { current: sessionId, byId }
  return {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    connection: {
      api: {
        sessions: {
          history: (...args: unknown[]) => historyEvents(...args),
        },
      },
    },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as never
}

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

interface PaneHandles {
  container: HTMLDivElement
  unmount: () => void
  onToggleChat: ReturnType<typeof vi.fn>
  onNewThread: ReturnType<typeof vi.fn>
}

/** Render only the chat column (no shell), a real store behind it. The host
 *  mirrors the real Sidebar shell: it subscribes to the store and hands the
 *  pane a FRESH state on every change (the pane is controlled via props). */
function mountPane(tab: SidebarTab | null, chatOpen = true): PaneHandles {
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  store.setSession('chat-pane-session')
  if (!chatOpen) store.reduce(s => setChatOpen(s, false))
  const ctx = ctxFor(store, createBetterSidebarService(store), 'chat-pane-session', {})
  const onToggleChat = vi.fn()
  const onNewThread = vi.fn()
  const root: Root = createRoot(container)
  function Host() {
    const snapshot = useSyncExternalStore(
      (listener: () => void) => store.subscribe(listener),
      () => store.getSnapshot(),
    )
    const state = snapshot.state ?? makeDefaultState()
    return createElement(SideChatPane, {
      ctx,
      store,
      state,
      scope: { sessionId: 'chat-pane-session', cwd: '/tmp' },
      tab,
      onToggleChat,
      onNewThread,
    })
  }
  act(() => { root.render(createElement(Host)) })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
    onToggleChat,
    onNewThread,
  }
}

describe('SideChatPane (IDE-fullscreen chat column)', () => {
  it('renders the Side Chat hero with NO tab and routes its start button through onNewThread', () => {
    const { container, onNewThread, unmount } = mountPane(null)
    try {
      expect(container.textContent).toContain(t('sideChatEmpty'))
      const start = [...container.querySelectorAll('button')]
        .find(button => button.textContent?.includes(t('sideChatNew')))
      expect(start, 'hero start button').toBeDefined()
      act(() => { start!.click() })
      expect(onNewThread).toHaveBeenCalledTimes(1)
      // The hero must never call the internal thread-start (it owns no tab).
      expect(sidechatStart).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('mirrors a bound chat tab: renders its thread view (composer + agent badge)', async () => {
    const threadId = 'session-child-1'
    sidechatInfo.mockResolvedValue({ preset: 'pro', model: 'x', running: false })
    historyEvents.mockResolvedValue({ result: { ok: true, value: { events: [] } } })
    const tab: SidebarTab = { id: 'sidechat:t1', type: 'sidechat', title: 'Chat', meta: { threadId } }
    const { container, unmount } = mountPane(tab)
    try {
      // A bound thread shows the composer with the first-question placeholder
      // (an empty transcript is a FRESH thread) and the agent badge.
      await vi.waitFor(() => {
        const composer = container.querySelector('textarea') as HTMLTextAreaElement | null
        expect(composer?.placeholder).toBe(t('sideChatFirstPlaceholder'))
      })
      await vi.waitFor(() => {
        expect(container.textContent).toContain('pro · x')
      })
      // The column header carries the section title.
      expect(container.textContent).toContain(t('sideChat'))
    } finally {
      unmount()
    }
  })

  it('the collapse button toggles, and a collapsed column renders at width 0 (mounted)', () => {
    const { container, onToggleChat, unmount } = mountPane(null)
    try {
      const pane = container.querySelector('[data-dsh-ide-chat]') as HTMLElement
      expect(pane).not.toBeNull()
      expect(pane.style.width).toBe('360px')
      const collapse = [...container.querySelectorAll('button')]
        .find(button => button.getAttribute('aria-label') === t('sideChatCollapse'))
      expect(collapse, 'collapse button').toBeDefined()
      act(() => { collapse!.click() })
      expect(onToggleChat).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
    }

    const collapsed = mountPane(null, false)
    try {
      const pane = collapsed.container.querySelector('[data-dsh-ide-chat]') as HTMLElement
      expect(pane.style.width).toBe('0px')
    } finally {
      collapsed.unmount()
    }
  })

  it('the left-edge resize handle drags the width and commits it to the store', () => {
    const { container, unmount } = mountPane(null)
    try {
      const handle = container.querySelector('[role="separator"]') as HTMLElement
      expect(handle).not.toBeNull()
      const pane = container.querySelector('[data-dsh-ide-chat]') as HTMLElement
      // Handle on the LEFT edge: dragging RIGHT widens the chat column
      // (360 default + 50px of drag).
      act(() => {
        handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100 }))
        handle.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 150 }))
        handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 150 }))
      })
      expect(pane.style.width).toBe('410px')
    } finally {
      unmount()
    }
  })
})

describe('Sidebar shell in IDE FULLSCREEN (⌘⌥⇧B) with the chat column', () => {
  /** Mount the real shell: IDE mode on, a bound sidechat tab seeded in the
   *  right workbench. */
  function mountIde(): { container: HTMLDivElement; store: SidebarStore; unmount: () => void } {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const container = document.createElement('div')
    document.body.append(container)
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    // The sidechat type (title/icon for the header strip and the activity bar).
    service.registerTab({
      id: 'sidechat',
      title: () => t('sideChat'),
      component: () => null,
    })
    store.setSession('ide-chat-session')
    store.reduce(toggleRightMaximized)
    store.reduce(s => openTabInActivePane(s, {
      id: 'sidechat:t1',
      type: 'sidechat',
      title: 'My thread',
      meta: { threadId: 'session-child-1' },
    }))
    sidechatInfo.mockResolvedValue({ preset: 'pro', model: 'x', running: false })
    historyEvents.mockResolvedValue({ result: { ok: true, value: { events: [] } } })
    fsTree.mockResolvedValue({ entries: [] })
    gitStatus.mockResolvedValue({ isRepo: false, entries: [] })
    const ctx = ctxFor(store, service, 'ide-chat-session', {
      'ide-chat-session': { cwd: '/tmp' },
      'session-child-1': { running: false, displayTitle: 'Side: My thread' },
    })
    const root: Root = createRoot(container)
    act(() => { root.render(createElement(Sidebar, { ctx, store })) })
    return {
      container,
      store,
      unmount: () => { act(() => { root.unmount() }); container.remove() },
    }
  }

  it('docks the chat column at the panel\'s right edge and mirrors the seeded chat tab', async () => {
    const { container, unmount } = mountIde()
    try {
      const pane = container.querySelector('[data-dsh-ide-chat]') as HTMLElement | null
      expect(pane, 'IDE chat column').not.toBeNull()
      expect(pane!.style.width).toBe('360px')
      // The mirrored thread renders exactly ONCE (the workbench cell is
      // suppressed — a second mount would double-fire thread work).
      await vi.waitFor(() => {
        const composer = container.querySelector('textarea') as HTMLTextAreaElement | null
        expect(composer?.placeholder).toBe(t('sideChatFirstPlaceholder'))
      })
      await vi.waitFor(() => {
        expect(container.textContent).toContain('pro · x')
      })
      const occurrences = container.innerHTML.split(t('sideChatFirstPlaceholder')).length - 1
      expect(occurrences).toBe(1)
    } finally {
      unmount()
    }
  })

  it('the docked bottom panel ends at the chat column\'s left edge', () => {
    const { container, unmount } = mountIde()
    try {
      const bottom = container.querySelector('[data-dsh-bottom-panel]') as HTMLElement | null
      expect(bottom, 'bottom panel').not.toBeNull()
      // IDE mode: right = chatWidth (the panel spans explorer → chat column),
      // left = activity bar (48) + the explorer drawer (240, default open).
      expect(bottom!.style.right).toBe('360px')
      expect(bottom!.style.left).toBe('288px')
    } finally {
      unmount()
    }
  })

  it('collapsing the chat column returns the bottom panel to the panel\'s right edge', () => {
    const { container, store, unmount } = mountIde()
    try {
      const bottom = container.querySelector('[data-dsh-bottom-panel]') as HTMLElement | null
      expect(bottom!.style.right).toBe('360px')
      act(() => { store.reduce(s => setChatOpen(s, false)) })
      const pane = container.querySelector('[data-dsh-ide-chat]') as HTMLElement | null
      expect(pane!.style.width).toBe('0px')
      expect(bottom!.style.right).toBe('0px')
    } finally {
      unmount()
    }
  })

  it('the top-right ✕ exits IDE fullscreen (mouse way out, not only the key combo)', () => {
    const { container, store, unmount } = mountIde()
    try {
      expect(store.getSnapshot().state?.rightMaximized).toBe(true)
      const exit = [...container.querySelectorAll('button')]
        .find(button => button.getAttribute('aria-label') === t('ideModeExit'))
      expect(exit, 'exit-IDE button').toBeDefined()
      act(() => { exit!.click() })
      expect(store.getSnapshot().state?.rightMaximized).toBe(false)
      // Exiting un-docks the chat column (it renders only inside IDE mode).
      expect(container.querySelector('[data-dsh-ide-chat]')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('the measure chain (ResizeObserver path) keeps the IDE dock — the bottom panel never slides under the chat column', () => {
    // Regression: entering IDE fullscreen RELEASES the layout push, the app's
    // center column (behind the cover) expands, and the ResizeObserver-driven
    // measureCenter used to overwrite the docked bottom panel's edges with
    // the column's near-full-width rect — the terminal box then covered the
    // chat column's transcript/composer (z-index 1001 over the panel's 1000),
    // and React never re-asserted the inline edges (unchanged values skip
    // the style diff). The other tests mount without #root, so the locate/
    // measure chain never runs there; this test engages it for real: the
    // #root + slot markup gives locate() a column, the stubbed observer
    // stands in for jsdom's missing ResizeObserver, and the mocked rect
    // (left 260 / right 824) makes an IDE-unaware write observable
    // (it would set left:260px / right:200px instead of the IDE dock).
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    const rootEl = document.createElement('div')
    rootEl.id = 'root'
    const frame = document.createElement('div')
    frame.setAttribute('data-dsh-frame', '')
    const center = document.createElement('div')
    center.setAttribute('data-pane', 'conversation')
    const slot = document.createElement('div')
    slot.setAttribute('data-slot', 'conversation')
    center.getBoundingClientRect = () => ({ left: 260, right: 824, top: 0, bottom: 0, width: 564, height: 0, x: 260, y: 0, toJSON: () => ({}) }) as DOMRect
    center.append(slot)
    frame.append(center)
    rootEl.append(frame)
    document.body.append(rootEl)
    const { container, unmount } = mountIde()
    try {
      const bottom = container.querySelector('[data-dsh-bottom-panel]') as HTMLElement | null
      expect(bottom, 'bottom panel').not.toBeNull()
      // measureCenter ran (locate found the column through #root — the
      // visibility gate clearing proves it) and must have taken the IDE
      // branch: the docked edges stay at the React inline values.
      expect(bottom!.style.visibility).not.toBe('hidden')
      expect(bottom!.style.left).toBe('288px')
      expect(bottom!.style.right).toBe('360px')
    } finally {
      unmount()
      rootEl.remove()
    }
  })

  it('opening a new chat tab switches the column\'s mirrored thread (the active sidechat tab)', async () => {
    const { container, store, unmount } = mountIde()
    try {
      sidechatInfo.mockClear()
      // A second chat tab: openTabInActivePane appends it AND makes it
      // active — the column must follow to the new tab's view.
      store.reduce(s => openTabInActivePane(s, {
        id: 'sidechat:t2',
        type: 'sidechat',
        title: 'Chat 2',
        meta: { threadId: 'session-child-2' },
      }))
      // The mirrored view fetches the NEW thread's info — proof the column
      // re-bound to the active tab.
      await vi.waitFor(() => {
        expect(sidechatInfo).toHaveBeenCalledWith('session-child-2')
      })
      // Its tab sits in the header strip alongside the first.
      expect(container.textContent).toContain('Chat 2')
    } finally {
      unmount()
    }
  })
})