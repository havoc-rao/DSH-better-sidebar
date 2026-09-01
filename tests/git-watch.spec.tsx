/**
 * The watched-branch (重点关注) markers in GitView's history: a watched
 * branch's tip relative to the checkout HEAD drives three surfaces —
 * 1. AHEAD of HEAD (commits not in HEAD's history, no row in the graph):
 *    the sticky TOP bubble shows the gap count.
 * 2. BEHIND HEAD with the tip row inside the loaded page: the row's graph
 *    dot gets the watched ring + a star mark next to the subject.
 * 3. BEHIND HEAD with the tip below the loaded page: the sticky BOTTOM
 *    bubble shows the gap; clicking it pages the history down to the tip.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitView } from '../src/client/GitView.tsx'
import {
  api, type GitBranchTip, type GitGraphEntry, type GitStatusResult, type GitWorktree,
} from '../src/client/api.ts'
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../src/prefs-shared.ts'
import type { SidebarStore } from '../src/client/state.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const REPO = 'C:/repo/main'

function entry(hash: string, subject: string): GitGraphEntry {
  return {
    hash: hash.slice(0, 7),
    hashFull: hash,
    subject,
    author: 'Test',
    date: '2026-08-20 00:00:00 +0800',
    refs: '',
    parents: [],
  }
}

/** A minimal store: prefs drive the watch list (persisted pluginSettings). */
function fakeStore(prefs: SidebarPrefs): SidebarStore {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ prefs }),
    getPrefs: () => prefs,
    setPrefs: () => {},
    reduce: () => {},
  } as unknown as SidebarStore
}

function prefsWithWatched(names: string[]): SidebarPrefs {
  return { ...SIDEBAR_PREFS_DEFAULTS, pluginSettings: { git: { watchedBranches: names } } }
}

/** Mock the whole git api; `pages` maps log skip → returned page. */
function mockApi(pages: Record<number, GitGraphEntry[]>, tips: GitBranchTip[]): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: REPO, branch: 'main', current: true, changes: 0 }] as GitWorktree[])
  vi.spyOn(api, 'gitStatus').mockResolvedValue({ isRepo: true, branch: 'main', entries: [] } as GitStatusResult)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main', 'feature'] })
  vi.spyOn(api, 'gitBranchStatus').mockResolvedValue({ upstream: undefined, ahead: 0, behind: 0, gone: false })
  vi.spyOn(api, 'gitLogGraph').mockImplementation(async (_scope, _count, skip) => pages[skip ?? 0] ?? [])
  vi.spyOn(api, 'gitBranchTips').mockImplementation(async (_scope, branches) => ({
    tips: tips.filter(tip => branches.includes(tip.name)),
  }))
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  })
}

function mountView(prefs: SidebarPrefs): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(GitView, {
      scope: { sessionId: 'watch-session', cwd: REPO },
      store: fakeStore(prefs),
      onOpenFile: () => {},
      onOpenDiff: () => {},
      visible: true,
    }))
  })
  return { container, root }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('GitView watched-branch markers', () => {
  it('pins a TOP bubble with the gap when the watched branch is ahead of HEAD', async () => {
    mockApi({ 0: [entry('a'.repeat(40), 'main commit')] }, [
      { name: 'feature', hash: 'f'.repeat(40), ahead: 3, behind: 0 },
    ])
    const view = mountView(prefsWithWatched(['feature']))
    try {
      await flushEffects()
      expect(view.container.querySelector('[class*="gitLogWatchTop"]')).not.toBeNull()
      expect(view.container.textContent).toContain('3 commits ahead')
      expect(view.container.textContent).toContain('feature')
      // No row of the graph is the feature tip → no watched row mark.
      expect(view.container.querySelector('[class*="gitLogWatchRowMark"]')).toBeNull()
    } finally {
      act(() => { view.root.unmount() })
      view.container.remove()
    }
  })

  it('marks the row whose commit IS the watched tip (dot ring + star)', async () => {
    const tipHash = 'a'.repeat(40)
    mockApi({ 0: [entry(tipHash, 'feature tip commit')] }, [
      { name: 'feature', hash: tipHash, ahead: 0, behind: 0 },
    ])
    const view = mountView(prefsWithWatched(['feature']))
    try {
      await flushEffects()
      expect(view.container.textContent).toContain('feature tip commit')
      expect(view.container.querySelector('[class*="gitLogWatchRowMark"]')).not.toBeNull()
      // In sync → no bubble at all.
      expect(view.container.querySelector('[class*="gitLogWatchBubble"]')).toBeNull()
    } finally {
      act(() => { view.root.unmount() })
      view.container.remove()
    }
  })

  it('pins a BOTTOM bubble while the behind tip is below the loaded page, and reveals it on click', async () => {
    const deepHash = 'd'.repeat(40)
    // A FULL first page (LOG_BATCH rows): the reveal exists only while the
    // history is still paged (logEnded would mean no deeper row at all).
    mockApi({
      0: Array.from({ length: 20 }, (_value, i) => entry(`${i}${'b'.repeat(39)}`, `visible commit ${i}`)),
      20: [entry(deepHash, 'deep feature tip')],
    }, [
      { name: 'feature', hash: deepHash, ahead: 0, behind: 37 },
    ])
    const view = mountView(prefsWithWatched(['feature']))
    try {
      await flushEffects()
      expect(view.container.querySelector('[class*="gitLogWatchBottom"]')).not.toBeNull()
      expect(view.container.textContent).toContain('37 commits behind')

      await act(async () => {
        view.container.querySelector<HTMLElement>('[class*="gitLogWatchBottom"]')!.click()
      })
      await flushEffects()
      // The tip row is now loaded: the bubble disappears, the row is marked.
      expect(view.container.textContent).toContain('deep feature tip')
      expect(view.container.querySelector('[class*="gitLogWatchBottom"]')).toBeNull()
      expect(view.container.querySelector('[class*="gitLogWatchRowMark"]')).not.toBeNull()
    } finally {
      act(() => { view.root.unmount() })
      view.container.remove()
    }
  })
})