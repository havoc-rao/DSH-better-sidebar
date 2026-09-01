/**
 * GitView sync seams with the REAL git status (regression: the changed-file
 * lists could hold stale rows — or none at all — while the actual working
 * tree had changes).
 *
 * Three seams are pinned here:
 *  1. The shared change bus is bidirectional: `notifyGitStatusChanged` from
 *     ANY surface (the tree's move-to-trash, a mutation elsewhere) refreshes
 *     the visible panel immediately — and the panel's own broadcast never
 *     re-refreshes itself (no loop, no extra fetch).
 *  2. `visible` false→true transition pulls a fresh snapshot at once — a
 *     change made while the tab was hidden appears the moment it is shown,
 *     not two seconds later on the first poll tick.
 *  3. A refresh issued while another is still resolving is QUEUED and
 *     replayed, not swallowed by the in-flight guard — a mutation racing a
 *     slow poll still repaints with the post-mutation status.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitView } from '../src/client/GitView.tsx'
import { api, type GitGraphEntry, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'
import { notifyGitStatusChanged } from '../src/client/git-status.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const REPO = 'C:/repo/main'

const inventory: GitWorktree[] = [
  { path: REPO, branch: 'main', current: true, changes: 0 },
]

function statusWith(paths: Array<{ path: string; xy: string }>): GitStatusResult {
  return { isRepo: true, branch: 'main', entries: paths }
}

function logFor(): GitGraphEntry[] {
  return [{
    hash: 'bbbbbb1',
    hashFull: 'b'.repeat(32) + '1',
    subject: 'Main checkout commit 0',
    author: 'Test',
    date: '2026-08-20 00:00:00 +0800',
    refs: 'HEAD -> refs/heads/main',
    parents: [],
  }]
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

/** Pump enough microtask turns for a refresh chain (mount → notify → replay)
 *  to settle inside one act() so React never sees an un-acted update. */
async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  })
}

function mockApi(latest: () => GitStatusResult, gitStatusImpl?: typeof api.gitStatus): { gitStatus: ReturnType<typeof vi.spyOn> } {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue(inventory)
  const gitStatus = vi.spyOn(api, 'gitStatus').mockImplementation(gitStatusImpl ?? (async () => latest()))
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitBranchStatus').mockResolvedValue({ upstream: undefined, ahead: 0, behind: 0, gone: false })
  vi.spyOn(api, 'gitLogGraph').mockImplementation(async () => logFor())
  return { gitStatus }
}

function mountGitView(visible: boolean): { container: HTMLDivElement; root: Root; rerender: (visible: boolean) => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (atVisible: boolean): void => {
    act(() => {
      root.render(createElement(GitView, {
        scope: { sessionId: 'sync-session', cwd: REPO },
        onOpenFile: () => {},
        onOpenDiff: () => {},
        visible: atVisible,
      }))
    })
  }
  render(visible)
  return {
    container,
    root,
    rerender: (atVisible: boolean) => {
      render(atVisible)
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('GitView real-status sync (changed-file lists reflect the actual working tree)', () => {
  it('refreshes from the change bus: an external notification repaints the lists without a poll tick', async () => {
    let latest = statusWith([{ path: 'a.ts', xy: ' M' }])
    const { gitStatus, ...mounted } = mockApi(() => latest)
    const view = mountGitView(false)
    try {
      await flushEffects()
      // Mount refresh only — the panel's OWN broadcast must not re-refresh
      // itself (one fetch, no loop).
      expect(gitStatus).toHaveBeenCalledTimes(1)
      expect(view.container.textContent).toContain('a.ts')

      // The REAL working tree gains a file (e.g. the tree trashed something,
      // the agent created a file): bump the bus exactly as the other surface
      // would — the visible panel must repaint immediately.
      latest = statusWith([{ path: 'a.ts', xy: ' M' }, { path: 'b.ts', xy: '??' }])
      await act(async () => { notifyGitStatusChanged() })
      await flushEffects()

      expect(gitStatus).toHaveBeenCalledTimes(2)
      expect(view.container.textContent).toContain('b.ts')
      expect(view.container.textContent).toContain('a.ts')
    } finally {
      act(() => { view.root.unmount() })
      view.container.remove()
    }
  })

  it('pulls a fresh snapshot the moment the tab becomes visible again', async () => {
    let latest = statusWith([{ path: 'a.ts', xy: ' M' }])
    const { gitStatus, ...mounted } = mockApi(() => latest)
    const view = mountGitView(false)
    try {
      await flushEffects()
      expect(gitStatus).toHaveBeenCalledTimes(1)
      expect(view.container.textContent).toContain('a.ts')

      // While HIDDEN the working tree changes... (no poll while hidden: no
      // interval fires, so the panel still shows the old snapshot)
      latest = statusWith([{ path: 'a.ts', xy: ' M' }, { path: 'hidden.ts', xy: ' M' }])
      expect(view.container.textContent).not.toContain('hidden.ts')

      // ...and the tab becomes visible: the false→true TRANSITION must pull
      // the fresh status immediately — no two-second wait for a poll tick.
      view.rerender(true)
      await flushEffects()

      expect(gitStatus).toHaveBeenCalledTimes(2)
      expect(view.container.textContent).toContain('hidden.ts')
    } finally {
      act(() => { view.root.unmount() })
      view.container.remove()
    }
  })

  it('queues a refresh issued while another is in flight instead of dropping it', async () => {
    const gate = deferred<GitStatusResult>()
    const initial = statusWith([{ path: 'a.ts', xy: ' M' }])
    let latest = statusWith([{ path: 'a.ts', xy: ' M' }, { path: 'raced.ts', xy: ' M' }])
    let calls = 0
    const { gitStatus } = mockApi(() => latest, async () => {
      calls += 1
      if (calls === 1) return gate.promise
      return latest
    })
    const view = mountGitView(false)
    try {
      // Mount refresh #1 is now hung on the gate (the poll's git status is
      // slow). The working tree changes while it is in flight...
      await flushEffects()
      expect(calls).toBe(1)

      // ...and a mutation/bus bump racing it calls refresh (#2) — the old
      // guard would have swallowed it silently.
      await act(async () => { notifyGitStatusChanged() })
      await flushEffects()
      expect(calls).toBe(1) // #2 is queued, not started, while #1 is in flight

      // The slow poll settles with the PRE-mutation status; the queued
      // refresh then replays and must land the POST-mutation rows.
      await act(async () => { gate.resolve(initial) })
      await flushEffects()

      expect(calls).toBe(2)
      expect(view.container.textContent).toContain('raced.ts')
    } finally {
      act(() => { view.root.unmount() })
      view.container.remove()
    }
  })
})