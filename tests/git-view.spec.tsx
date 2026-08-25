/**
 * GitView regression: the AI commit-draft integration subscribes to the
 * SidebarStore for the live side-card prefs. `SidebarStore.subscribe` is an
 * unbound class method that reads `this.listeners`, and React's
 * useSyncExternalStore invokes the subscribe function as a bare function —
 * so the subscription must be wrapped in an arrow closure. A raw method
 * reference crashes on mount with "Cannot read properties of undefined
 * (reading 'listeners')". This spec mounts the real component with the real
 * store and asserts it renders without throwing.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createSidebarStore } from '../src/client/state.ts'
import { GitView } from '../src/client/GitView.tsx'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

describe('GitView store subscription', () => {
  it('mounts with the real SidebarStore (subscribe must stay bound)', () => {
    // The mount effect fires api refreshes; make them fail deterministically
    // instead of hitting the network (the refresh handler absorbs errors).
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('no network in tests') }) as unknown as typeof fetch

    const store = createSidebarStore()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      act(() => {
        root.render(createElement(GitView, {
          scope: { sessionId: 'git-regression-session' },
          store,
          onOpenFile: () => { /* no-op */ },
          onOpenDiff: () => { /* no-op */ },
        }))
      })
    } finally {
      act(() => { root.unmount() })
      container.remove()
      globalThis.fetch = originalFetch
    }
    expect(true).toBe(true)
  })
})