/**
 * Full-page "Global Workspace" session-bound dismissal tests: the page is a
 * session-bound surface (it occupies the CURRENT session's conversation
 * slot), and opening it CLEARS the current session's activation first
 * (openGlobalPage — the page opens from the no-session hero), so EVERY
 * session click is a real open and dismisses the page (modal semantics).
 * These tests render the REAL Sidebar shell against a minimal fake context
 * (the repo's jsdom pattern) and drive the active session through a
 * controllable sessions feed, asserting the module-level page flag flips
 * closed on a defined-session open while surviving no-session transients.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { isGlobalPageOpen, openGlobalPage, resetGlobalPageForTests, setGlobalPageOpen } from '../src/client/global-page.ts'

/** jsdom has no WebSocket; the agent-terminals push effect constructs one on mount. */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

/**
 * A controllable sessions list feed: getSnapshot returns a stable object per
 * version (useSyncExternalStore contract — the SAME object must not be
 * mutated across calls, or the store sees no change), and setCurrent bumps
 * the version and notifies subscribers like the real sessions service.
 */
function controllableSessions(initial: string) {
  const listeners = new Set<() => void>()
  let snapshot = {
    current: initial as string | undefined,
    byId: { [initial]: { cwd: '/tmp' } },
  } as { current: string | undefined; byId: Record<string, { cwd: string }> }
  return {
    list: {
      subscribe: (fn: () => void): (() => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
      getSnapshot: () => snapshot,
    },
    setCurrent: (id: string | undefined): void => {
      snapshot = {
        current: id,
        byId: id === undefined ? {} : { [id]: { cwd: '/tmp' } },
      }
      for (const listener of [...listeners]) listener()
    },
  }
}

interface MountedSidebar {
  container: HTMLDivElement
  store: SidebarStore
  service: BetterSidebarService
  unmount: () => void
}

/** Mount the real Sidebar shell against a minimal context (real store + service). */
function mountSidebar(current: string): { mounted: MountedSidebar; sessions: ReturnType<typeof controllableSessions> } {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  store.setSession(current)
  const localeSnapshot = { active: 'en' }
  const sessions = controllableSessions(current)
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: sessions.list },
    betterSidebar: service,
  }
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx: ctx as never, store })) })
  return {
    mounted: {
      container,
      store,
      service,
      unmount: () => {
        act(() => { root.unmount() })
        container.remove()
      },
    },
    sessions,
  }
}

afterEach(() => {
  resetGlobalPageForTests()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('openGlobalPage (no-session open contract)', () => {
  it('clears the current session activation first, then opens the page', () => {
    const clear = vi.fn()
    const ctx = { sessions: { clear } } as unknown as Parameters<typeof openGlobalPage>[0]
    openGlobalPage(ctx)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(isGlobalPageOpen()).toBe(true)
  })

  it('still opens when the sessions face is absent or the clear throws', () => {
    const ctx = {} as unknown as Parameters<typeof openGlobalPage>[0]
    openGlobalPage(ctx)
    expect(isGlobalPageOpen()).toBe(true)
    const throwing = { sessions: { clear: () => { throw new Error('boom') } } } as unknown as Parameters<typeof openGlobalPage>[0]
    openGlobalPage(throwing)
    expect(isGlobalPageOpen()).toBe(true)
  })
})

describe('Global Workspace page: session-bound dismissal', () => {
  it('stays open while the session is unchanged', () => {
    const { mounted, sessions } = mountSidebar('s1')
    act(() => { setGlobalPageOpen(true) })
    expect(isGlobalPageOpen()).toBe(true)
    // No session navigation → the page stays open.
    act(() => { sessions.setCurrent('s1') })
    expect(isGlobalPageOpen()).toBe(true)
    mounted.unmount()
  })

  it('closes when switching to another session', () => {
    const { mounted, sessions } = mountSidebar('s1')
    act(() => { setGlobalPageOpen(true) })
    expect(isGlobalPageOpen()).toBe(true)
    act(() => { sessions.setCurrent('s2') })
    expect(isGlobalPageOpen()).toBe(false)
    mounted.unmount()
  })

  it('closes when the first session opens while the page is up', () => {
    const { mounted, sessions } = mountSidebar('s1')
    // Simulate the no-session hero: the page opens with no active session.
    act(() => { sessions.setCurrent(undefined) })
    act(() => { setGlobalPageOpen(true) })
    expect(isGlobalPageOpen()).toBe(true)
    // Opening a session dismisses the page.
    act(() => { sessions.setCurrent('s1') })
    expect(isGlobalPageOpen()).toBe(false)
    mounted.unmount()
  })

  it('a closed page stays closed across session switches', () => {
    const { mounted, sessions } = mountSidebar('s1')
    act(() => { sessions.setCurrent('s2') })
    expect(isGlobalPageOpen()).toBe(false)
    mounted.unmount()
  })

  it('survives a no-op same-session click that blips through the no-session state', () => {
    const { mounted, sessions } = mountSidebar('s1')
    act(() => { setGlobalPageOpen(true) })
    expect(isGlobalPageOpen()).toBe(true)
    // Re-selecting the SAME session (or its workspace) transiently blanks
    // `current` through the no-session state and settles back — a real
    // session switch never happened, so the page must stay open.
    act(() => { sessions.setCurrent(undefined) })
    expect(isGlobalPageOpen()).toBe(true)
    act(() => { sessions.setCurrent('s1') })
    expect(isGlobalPageOpen()).toBe(true)
    mounted.unmount()
  })

  it('stays open when the active session drops to the no-session hero', () => {
    const { mounted, sessions } = mountSidebar('s1')
    act(() => { setGlobalPageOpen(true) })
    expect(isGlobalPageOpen()).toBe(true)
    // The hero is not another session — no dismissal.
    act(() => { sessions.setCurrent(undefined) })
    expect(isGlobalPageOpen()).toBe(true)
    mounted.unmount()
  })
})
