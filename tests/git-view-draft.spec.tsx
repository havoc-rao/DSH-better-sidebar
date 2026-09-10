/**
 * GitView commit-draft persistence: the draft rides the git tab's persisted
 * `meta` (the same slot EditorHost's treeOpen/treeWidth use), so switching
 * sessions — or a reload — restores what the user was typing. The commit box
 * seeds from meta on mount, writes back debounced (400ms), flushes on
 * unmount and on a tab-identity swap (an in-place session switch), and
 * clears after a successful commit so a committed message never resurrects.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { GitView } from '../src/client/GitView.tsx'
import { api, type GitGraphEntry, type GitStatusResult } from '../src/client/api.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarTab } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const STATUS: GitStatusResult = {
  isRepo: true,
  branch: 'main',
  entries: [{ path: 'staged.ts', xy: 'M ' }],
}

function logFor(): GitGraphEntry[] {
  return [{
    hash: 'aaaaaa',
    hashFull: 'a'.repeat(40),
    subject: 'Main commit',
    author: 'Test',
    date: '2026-08-20 00:00:00 +0800',
    refs: 'HEAD -> refs/heads/main',
    parents: [],
  }]
}

/** Deterministic git data plane: one clean repo with one staged file. */
function gitApi(): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
  vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitBranchStatus').mockResolvedValue({ upstream: undefined, ahead: 0, behind: 0, gone: false })
  vi.spyOn(api, 'gitLogGraph').mockImplementation(async (_scope, _count, skip) => (skip === 0 ? logFor() : []))
}

function metaOf(tab: SidebarTab): Record<string, unknown> {
  return tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
}

/** The session's git tab (opened through the service, so it lives in the
 *  session layout exactly like the real app). */
function tabIn(store: ReturnType<typeof createSidebarStore>, sessionId: string): SidebarTab {
  const state = store.getStateOf(sessionId) ?? store.getSnapshot().state!
  return allLeaves(state.splits).flatMap(leaf => leaf.tabs).find(candidate => candidate.type === 'git')!
}

/** A real store + service with a git tab open in one session. */
function setup(sessionId: string, meta?: Record<string, unknown>): {
  store: ReturnType<typeof createSidebarStore>
  ctx: Context
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'git', title: 'Git', single: true, component: () => null })
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

/** Mount GitView for ONE tab (a fresh root: the app mounts a fresh instance
 *  per session). */
function mountGit(
  ctx: Context,
  store: ReturnType<typeof createSidebarStore>,
  tab: () => SidebarTab,
): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(GitView, {
      ctx,
      store,
      scope: { sessionId: store.getSnapshot().sessionId ?? 'session' },
      tab: tab(),
      onOpenFile: () => { /* no-op */ },
      onOpenDiff: () => { /* no-op */ },
      visible: false,
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
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
  expect(textarea).not.toBeNull()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const draftOf = (store: ReturnType<typeof createSidebarStore>, sessionId: string): unknown =>
  metaOf(tabIn(store, sessionId)).commitMsg

/** Let the mocked git routes' promise chains settle (each act round flushes
 *  one microtask cascade of the refresh pipeline). */
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

describe('GitView commit-draft persistence (tab.meta)', () => {
  it('seeds the commit box from the persisted tab.meta', async () => {
    gitApi()
    const { ctx, store } = setup('seed-session', { commitMsg: 'persisted draft' })
    const view = mountGit(ctx, store, () => tabIn(store, 'seed-session'))
    try {
      await flushEffects()
      const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea')
      expect(textarea).not.toBeNull()
      expect(textarea!.value).toBe('persisted draft')
    } finally {
      view.unmount()
    }
  })

  it('persists the typed draft into tab.meta (debounced) and restores it after a remount', async () => {
    vi.useFakeTimers()
    gitApi()
    const { ctx, store } = setup('typing-session')
    const view = mountGit(ctx, store, () => tabIn(store, 'typing-session'))
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

    // A session switch away and back unmounts/remounts the panel with the
    // same tab: the draft comes back from meta.
    const view2 = mountGit(ctx, store, () => tabIn(store, 'typing-session'))
    try {
      await flushEffects()
      const textarea = view2.container.querySelector<HTMLTextAreaElement>('textarea')
      expect(textarea).not.toBeNull()
      expect(textarea!.value).toBe('WIP: fix the thing')
    } finally {
      view2.unmount()
    }
  })

  it('flushes a pending draft to the previous tab when the tab identity swaps in place', async () => {
    gitApi()
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'git', title: 'Git', single: true, component: () => null })
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
    // scope — a session switch changes both props at once.
    const renderTab = (tab: SidebarTab, sessionId: string): void => {
      act(() => {
        root.render(createElement(GitView, {
          ctx,
          store,
          scope: { sessionId },
          tab,
          onOpenFile: () => { /* no-op */ },
          onOpenDiff: () => { /* no-op */ },
          visible: false,
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
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
      expect(textarea).not.toBeNull()
      expect(textarea!.value).toBe('')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('clears the persisted draft after a successful commit', async () => {
    gitApi()
    vi.spyOn(api, 'gitCommit').mockResolvedValue({ ok: true })
    const { ctx, store } = setup('commit-session', { commitMsg: 'stale draft' })
    const view = mountGit(ctx, store, () => tabIn(store, 'commit-session'))
    try {
      await flushEffects()
      setDraftInput(view.container, 'real fix')
      await flushEffects()
      const commitButtons = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
        .filter(button => button.getAttribute('aria-label') === t('commit'))
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
})