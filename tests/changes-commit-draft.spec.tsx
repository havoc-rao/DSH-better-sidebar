/**
 * The changes tab's commit-draft persistence: the draft is owned by
 * ChangesTab (so a lens switch — which unmounts the Git lens — cannot
 * evaporate the typing) and mirrored to the durable slot of whichever world
 * the tab lives in. In the bottom workbench that is the tab's own `meta`
 * (the per-session persisted layout): the box seeds from meta on mount,
 * writes back debounced (400ms), flushes on unmount and on a tab-identity
 * swap, and clears after a successful commit so a committed message never
 * resurrects. For native right-Sidebar tabs (memory-only records) the mirror
 * is the git card's `pluginSettings` blob keyed by session — the same route
 * the seeded store round-trips — and seeds a synthetic tab that carries no
 * meta of its own.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ChangesTab } from '../src/client/changes/ChangesTab.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'
import { api, type GitStatusResult } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const STATUS: GitStatusResult = {
  isRepo: true,
  branch: 'main',
  entries: [{ path: 'staged.ts', xy: 'M ' }],
}

/** Deterministic data plane: one clean repo with one staged file, no
 *  session events (the session-lens poll is not what these cases assert). */
function gitApi(): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
  vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitLog').mockResolvedValue([])
  vi.spyOn(api, 'changesOps').mockResolvedValue({ events: [], lastSeq: 0 })
}

function metaOf(tab: SidebarTab): Record<string, unknown> {
  return tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
}

/** The session's git tab (opened through the service, so it lives in the
 *  session layout exactly like the real app). */
function tabIn(store: ReturnType<typeof createSidebarStore>, sessionId: string): SidebarTab {
  const state = store.getSessionStates().get(sessionId)
  expect(state).toBeDefined()
  return allLeaves(state!.bottomSplits).flatMap(leaf => leaf.tabs).find(tab => tab.type === 'git')!
}

/** A real store + service with a git tab open in one session (the bottom
 *  workbench world — no native surface is installed in these tests). */
function setup(sessionId: string, meta?: Record<string, unknown>): {
  store: ReturnType<typeof createSidebarStore>
  ctx: Context
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'git', title: 'Changes', single: true, component: () => null })
  store.setSession(sessionId)
  service.openTab({ type: 'git', ...(meta !== undefined ? { meta } : {}) })
  return {
    store,
    ctx: {
      betterSidebar: service,
      get: (name: string) => name === 'betterSidebar' ? service : undefined,
    } as unknown as Context,
  }
}

/** Mount ChangesTab for one tab (a fresh root: the app mounts a fresh
 *  instance per session). */
function mountChanges(
  ctx: Context,
  store: ReturnType<typeof createSidebarStore>,
  tab: () => SidebarTab,
  sessionId: string,
): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(ChangesTab, {
      ctx,
      store,
      scope: { sessionId },
      tab: tab(),
      visible: false,
      onOpenFile: () => { /* no-op */ },
      onOpenDiff: () => { /* no-op */ },
    }))
  })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Type into the controlled commit box (native setter + input event). */
function setDraftInput(container: HTMLElement, value: string): void {
  const input = container.querySelector<HTMLInputElement>('input')
  expect(input).not.toBeNull()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const draftOf = (store: ReturnType<typeof createSidebarStore>, sessionId: string): unknown =>
  metaOf(tabIn(store, sessionId)).commitMsg

/** Let the mocked routes' promise chains settle (each act round flushes one
 *  microtask cascade of the refresh / poll pipelines). */
async function flushEffects(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

describe('ChangesTab commit-draft persistence (bottom workbench: tab.meta)', () => {
  it('seeds the commit box from the persisted tab.meta', async () => {
    gitApi()
    const { ctx, store } = setup('seed-session', { commitMsg: 'persisted draft' })
    const view = mountChanges(ctx, store, () => tabIn(store, 'seed-session'), 'seed-session')
    try {
      await flushEffects()
      const input = view.container.querySelector<HTMLInputElement>('input')
      expect(input).not.toBeNull()
      expect(input!.value).toBe('persisted draft')
    } finally {
      view.unmount()
    }
  })

  it('persists the typed draft into tab.meta (debounced) and restores it after a remount', async () => {
    vi.useFakeTimers()
    gitApi()
    const { ctx, store } = setup('typing-session')
    const view = mountChanges(ctx, store, () => tabIn(store, 'typing-session'), 'typing-session')
    try {
      await flushEffects()
      setDraftInput(view.container, 'WIP: fix the thing')
      // Inside the debounce window the layout must not carry the draft yet.
      expect(draftOf(store, 'typing-session')).toBeUndefined()
      await act(async () => { vi.advanceTimersByTime(400) })
      expect(draftOf(store, 'typing-session')).toBe('WIP: fix the thing')
    } finally {
      view.unmount()
    }

    // A session switch away and back unmounts/remounts the tab: the draft
    // comes back from meta.
    const view2 = mountChanges(ctx, store, () => tabIn(store, 'typing-session'), 'typing-session')
    try {
      await flushEffects()
      const input = view2.container.querySelector<HTMLInputElement>('input')
      expect(input).not.toBeNull()
      expect(input!.value).toBe('WIP: fix the thing')
    } finally {
      view2.unmount()
    }
  })

  it('flushes a pending draft on unmount when the debounce never fired', async () => {
    gitApi()
    const { ctx, store } = setup('unmount-session')
    const view = mountChanges(ctx, store, () => tabIn(store, 'unmount-session'), 'unmount-session')
    await flushEffects()
    setDraftInput(view.container, 'last keystrokes')
    expect(draftOf(store, 'unmount-session')).toBeUndefined()
    // Unmount inside the debounce window: the cleanup flush writes the draft
    // synchronously, so the pending keystrokes survive.
    view.unmount()
    expect(draftOf(store, 'unmount-session')).toBe('last keystrokes')
  })

  it('flushes a pending draft to the previous tab when the tab identity swaps in place', async () => {
    gitApi()
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'git', title: 'Changes', single: true, component: () => null })
    store.setSession('swap-a')
    service.openTab({ type: 'git', meta: { commitMsg: 'draft a' } })
    store.setSession('swap-b')
    service.openTab({ type: 'git' })
    const ctx = {
      betterSidebar: service,
      get: (name: string) => name === 'betterSidebar' ? service : undefined,
    } as unknown as Context

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    // The real pane renders the ACTIVE session's tabs with that session's
    // scope — a session switch changes the store, then the pane re-renders
    // with both props swapped at once.
    const renderTab = (tab: SidebarTab, sessionId: string): void => {
      store.setSession(sessionId)
      act(() => {
        root.render(createElement(ChangesTab, {
          ctx,
          store,
          scope: { sessionId },
          tab,
          visible: false,
          onOpenFile: () => { /* no-op */ },
          onOpenDiff: () => { /* no-op */ },
        }))
      })
    }
    try {
      renderTab(tabIn(store, 'swap-a'), 'swap-a')
      await flushEffects()
      setDraftInput(container, 'typing to a')
      // Still seeded on A: the debounce has not fired.
      expect(draftOf(store, 'swap-a')).toBe('draft a')
      // The pane swaps to session B's git tab WITHOUT unmounting: the
      // pending draft must flush to A immediately and B must re-seed from
      // its own (empty) meta.
      renderTab(tabIn(store, 'swap-b'), 'swap-b')
      expect(draftOf(store, 'swap-a')).toBe('typing to a')
      expect(draftOf(store, 'swap-b')).toBeUndefined()
      const input = container.querySelector<HTMLInputElement>('input')
      expect(input).not.toBeNull()
      expect(input!.value).toBe('')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('clears the persisted draft after a successful commit', async () => {
    gitApi()
    vi.spyOn(api, 'gitCommit').mockResolvedValue({ ok: true })
    const { ctx, store } = setup('commit-session', { commitMsg: 'stale draft' })
    const view = mountChanges(ctx, store, () => tabIn(store, 'commit-session'), 'commit-session')
    try {
      await flushEffects()
      setDraftInput(view.container, 'real fix')
      await flushEffects()
      const commitButtons = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
        .filter(button => button.textContent === 'Commit' || button.textContent === '提交')
      expect(commitButtons.length).toBe(1)
      await act(async () => {
        commitButtons[0]!.click()
        await Promise.resolve()
      })
      await flushEffects(4)
      expect(draftOf(store, 'commit-session')).toBe('')
    } finally {
      view.unmount()
    }
  })

  it('keeps the draft across a lens round-trip and merges into concurrent meta writes', async () => {
    vi.useFakeTimers()
    gitApi()
    const { ctx, store } = setup('lens-session')
    const view = mountChanges(ctx, store, () => tabIn(store, 'lens-session'), 'lens-session')
    try {
      await flushEffects()
      setDraftInput(view.container, 'WIP: lens round-trip')
      // Switch to the session lens (unmounts the Git lens, NOT the tab) and
      // back: the draft is owned by the tab, so it survives without any
      // meta round-trip.
      const group = view.container.querySelector('[role="group"]')
      const sessionButton = [...group!.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.getAttribute('aria-pressed') === 'false')
      expect(sessionButton).toBeDefined()
      await act(async () => { sessionButton!.click() })
      await act(async () => { vi.advanceTimersByTime(1) })
      const gitButton = [...group!.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.getAttribute('aria-pressed') === 'false')
      await act(async () => { gitButton!.click() })
      const input = view.container.querySelector<HTMLInputElement>('input')
      expect(input).not.toBeNull()
      expect(input!.value).toBe('WIP: lens round-trip')
      // The debounced write eventually lands — MERGED into the lens keys the
      // round-trip persisted, not clobbering them.
      await act(async () => { vi.advanceTimersByTime(400) })
      const meta = metaOf(tabIn(store, 'lens-session'))
      expect(meta.commitMsg).toBe('WIP: lens round-trip')
      expect(meta.lens).toBe('git')
    } finally {
      view.unmount()
    }
  })
})

describe('ChangesTab commit-draft persistence (native right Sidebar: pluginSettings)', () => {
  it('seeds a meta-less tab from the git card\'s per-session settings draft', async () => {
    gitApi()
    const store = createSidebarStore()
    const prefs = store.getPrefs()
    store.setPrefs({
      ...prefs,
      pluginSettings: { ...prefs.pluginSettings, git: { commitDrafts: { 'native-session': 'persisted draft' } } },
    })
    const ctx = { get: () => undefined } as unknown as Context
    // A synthetic record (what the native tab adapter hands the tab): it is
    // not in the store's bottom layout, so the settings blob is its mirror.
    const view = mountChanges(ctx, store, () => ({ id: 'git', type: 'git', title: 'Changes' }), 'native-session')
    try {
      await flushEffects()
      const input = view.container.querySelector<HTMLInputElement>('input')
      expect(input).not.toBeNull()
      expect(input!.value).toBe('persisted draft')
    } finally {
      view.unmount()
    }
  })

  it('mirrors the typed draft into the git card\'s settings blob (debounced)', async () => {
    vi.useFakeTimers()
    gitApi()
    const store = createSidebarStore()
    const settingsUpdate = vi.spyOn(api, 'settingsUpdate').mockImplementation(async (patch: Record<string, unknown>) => {
      // Round-trip the written pluginSettings back (what the host route does).
      return { value: { pluginSettings: (patch as { pluginSettings?: Record<string, Record<string, unknown>> }).pluginSettings ?? {} } }
    })
    const ctx = { get: () => undefined } as unknown as Context
    const view = mountChanges(ctx, store, () => ({ id: 'git', type: 'git', title: 'Changes' }), 'native-session')
    try {
      await flushEffects()
      setDraftInput(view.container, 'WIP: native mirror')
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      await flushEffects()
      // The settings route received the git card's blob with the draft keyed
      // by the tab's session, and the store adopted the returned document.
      expect(settingsUpdate).toHaveBeenCalled()
      const written = settingsUpdate.mock.calls.at(-1)![0] as { pluginSettings: Record<string, { commitDrafts?: Record<string, string> }> }
      expect(written.pluginSettings['git']?.commitDrafts?.['native-session']).toBe('WIP: native mirror')
      const adopted = store.getPrefs().pluginSettings['git'] as { commitDrafts?: Record<string, string> } | undefined
      expect(adopted?.commitDrafts?.['native-session']).toBe('WIP: native mirror')
    } finally {
      view.unmount()
    }
  })
})
