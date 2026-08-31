/**
 * The intercepted produced-files row's layout modes: auto-wrap (the default,
 * chips flow onto multiple lines) vs. single-line horizontal scroll (chips
 * never shrink; the row scrolls sideways when they overflow). The toggle is
 * a store-driven control — the row subscribes to the SidebarStore via
 * useSyncExternalStore, so a flip re-renders it immediately (a bare chat
 * chain render would never see the pref change until the next event).
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import './browser-globals.ts'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { SidebarProducedFiles } from '../src/client/intercept.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** Mount the row into a detached container; returns the row div. */
function mountRow(store: SidebarStore, onReview = vi.fn()): HTMLDivElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(SidebarProducedFiles, {
      matched: ['a.ts', 'b.ts'],
      openInSidebar: () => { /* no-op */ },
      onShowInFolder: () => { /* no-op */ },
      onReview,
      onToggleWrap: () => {
        const next = !(store.getPrefs().producedFilesWrap !== false)
        store.setPrefs({ ...store.getPrefs(), producedFilesWrap: next })
      },
      store,
    }))
  })
  const row = container.firstElementChild! as HTMLDivElement
  // Keep the container alive for the test's lifetime.
  return row
}

beforeEach(() => { vi.restoreAllMocks() })

describe('SidebarProducedFiles layout modes', () => {
  it('renders wrapping by default (the producedFilesWrap default)', () => {
    const store = createSidebarStore()
    const row = mountRow(store)
    expect(row.className).toContain('producedRow')
    expect(row.className).not.toContain('producedRowNowrap')
    // The toggle is present with the current mode's glyph + aria-pressed.
    const toggle = row.querySelector('button[aria-pressed]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('flips to single-line horizontal scroll when the wrap pref turns off', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), producedFilesWrap: false })
    const row = mountRow(store)
    expect(row.className).toContain('producedRow')
    expect(row.className).toContain('producedRowNowrap')
    const toggle = row.querySelector('button[aria-pressed]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })

  it('re-renders itself when the store pref flips (no chat re-render needed)', () => {
    const store = createSidebarStore()
    const row = mountRow(store)
    const toggle = row.querySelector('button[aria-pressed]') as HTMLButtonElement
    expect(row.className).not.toContain('producedRowNowrap')
    act(() => { toggle.click() })
    // The optimistic store write re-renders the row through the subscription.
    expect(row.className).toContain('producedRowNowrap')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    // And back again.
    act(() => { toggle.click() })
    expect(row.className).not.toContain('producedRowNowrap')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('routes the review button to the onReview seat with the produced set', () => {
    const store = createSidebarStore()
    const onReview = vi.fn()
    const row = mountRow(store, onReview)
    const review = Array.from(row.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Review')) as HTMLButtonElement
    expect(review).toBeTruthy()
    act(() => { review.click() })
    expect(onReview).toHaveBeenCalledWith(['a.ts', 'b.ts'])
  })
})