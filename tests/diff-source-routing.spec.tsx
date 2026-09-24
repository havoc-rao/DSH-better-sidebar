/**
 * The git data-source routing of the diff surfaces (feature 'gitSource'):
 * DiffPane (the changes tab's preview pane, ctx-based `useGitSource`) and
 * DiffTab (the dedicated diff tab, resolved through the module-level
 * client-ctx seat) route every git READ through the resolved GitDataSource
 * PER METHOD — a matched source shadows the host routes (the host `api`
 * stays untouched while it serves), and a source that lacks a single method
 * falls back to the host route for that method alone (a partial provider
 * never breaks a preview). No provider → host routes byte for byte. Also
 * pins the seat lifecycle (bind/unbind/snapshot, live re-resolution).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DiffTab } from '../src/client/DiffTab.tsx'
import { DiffPane, type ChangesPreview } from '../src/client/changes/DiffPane.tsx'
import {
  bindGitSourceSeat,
  unbindGitSourceSeat,
  useGitSourceSeat,
  type GitDataSource,
  type GitProviderDescriptor,
  type GitOkResult,
} from '../src/client/git-source.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { GitDiffRef, SidebarDiffRef } from '../src/client/state.ts'
import { api, type GitStatusResult } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const REPO = 'C:/repo/main'

// A git-shaped two-hunk patch: the gap between the hunks (old/new lines
// 2..11) is a fold WITHOUT rows — expandable only through resolveFold, which
// is exactly the path that reads both sides through gitShow.
const gapDiff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '@@ -12 +12 @@',
  '-tail',
  '+tail2',
].join('\n')

/** Both fold sides' full contents (lines 1..13 cover the 2..11 gap). */
const LINES = Array.from({ length: 13 }, (_, i) => String(i + 1)).join('\n')

const worktreeRef: SidebarDiffRef = { kind: 'worktree', path: 'src/a.ts', staged: false }
const commitRef: SidebarDiffRef = {
  kind: 'commit',
  hash: 'abc123',
  hashFull: 'a'.repeat(40),
  subject: 'Fix the thing',
}

/** A canned source: method presence + identity is all the resolver deals in. */
const makeSource = (type: 'worktree' | 'commit'): GitDataSource => ({
  gitStatus: async (): Promise<GitStatusResult> => ({ isRepo: false, entries: [] }),
  gitWorktrees: async () => [],
  gitBranch: async () => ({ current: '', names: [] }),
  gitLog: async () => [],
  gitDiff: async () => (type === 'worktree' ? { diff: gapDiff } : { diff: '' }),
  gitCommitDiff: async () => ({ diff: gapDiff }),
  gitShow: async () => ({ content: LINES }),
  gitStage: async (): Promise<GitOkResult> => ({ ok: true }),
  gitUnstage: async (): Promise<GitOkResult> => ({ ok: true }),
  gitCommit: async (): Promise<GitOkResult> => ({ ok: true }),
  gitCheckout: async (): Promise<GitOkResult> => ({ ok: true }),
  gitDiscard: async (): Promise<GitOkResult> => ({ ok: true }),
  gitRevert: async (): Promise<GitOkResult> => ({ ok: true }),
  gitCherryPick: async (): Promise<GitOkResult> => ({ ok: true }),
})

/** A registry service with one canned provider already registered. */
function serviceWith(provider: GitProviderDescriptor): BetterSidebarService {
  const service = createBetterSidebarService(createSidebarStore())
  service.registerGitProvider(provider)
  return service
}

/** The client Context face the seat/useGitSource consume: serves the
 *  registry service and collects the `internal/service` bus. */
function fakeCtx(service: BetterSidebarService): { ctx: Context; emitServiceChange(): void } {
  const listeners = new Set<() => void>()
  const ctx = {
    betterSidebar: service,
    get: (key: string): unknown => (key === 'betterSidebar' ? service : undefined),
    on: (_event: string, listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as unknown as Context
  return {
    ctx,
    emitServiceChange: () => { for (const listener of [...listeners]) listener() },
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

afterEach(() => {
  unbindGitSourceSeat()
  vi.restoreAllMocks()
})

/** One method of the host `api` object as a spy (set to never fire unless
 *  the fallback path is under test). */
function hostSpies(): { gitDiff: ReturnType<typeof vi.spyOn>; gitCommitDiff: ReturnType<typeof vi.spyOn>; gitShow: ReturnType<typeof vi.spyOn> } {
  return {
    gitDiff: vi.spyOn(api, 'gitDiff'),
    gitCommitDiff: vi.spyOn(api, 'gitCommitDiff'),
    gitShow: vi.spyOn(api, 'gitShow'),
  }
}

/** Click the diff's first rows-less gap fold, then flush the gitShow reads. */
async function expandFold(container: HTMLElement): Promise<void> {
  const fold = container.querySelector<HTMLElement>('[data-expandable="true"]')
  expect(fold).not.toBeNull()
  await act(async () => { fold!.click() })
  await flushEffects()
}

describe('DiffTab routing through the gitSource seat', () => {
  it('routes gitDiff + gitShow through a matched provider source (host api untouched)', async () => {
    const gitDiff = vi.fn(async () => ({ diff: gapDiff }))
    const gitShow = vi.fn(async () => ({ content: LINES }))
    const provider: GitProviderDescriptor = {
      id: 'remote',
      match: () => true,
      createSource: () => ({ ...makeSource('worktree'), gitDiff, gitShow }) as GitDataSource,
    }
    const service = serviceWith(provider)
    bindGitSourceSeat(fakeCtx(service).ctx)
    const host = hostSpies()
    vi.spyOn(api, 'fsRead').mockResolvedValue({ kind: 'text', content: LINES, truncated: false })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: REPO, diff: worktreeRef }))
      })
      await flushEffects()
      // The patch is rendered...
      expect(container.textContent).toContain('src/a.ts')
      expect(gitDiff).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), 'src/a.ts', false, undefined)
      // ...entirely through the provider: the host routes were never touched.
      expect(host.gitDiff).not.toHaveBeenCalled()
      expect(host.gitCommitDiff).not.toHaveBeenCalled()
      expect(host.gitShow).not.toHaveBeenCalled()

      // Fold expansion reads the old side (:0) through the provider too.
      await expandFold(container)
      expect(gitShow).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), ':0', 'src/a.ts', undefined)
      expect(host.gitShow).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('routes gitCommitDiff + fold gitShow of a commit through the provider', async () => {
    const gitCommitDiff = vi.fn(async () => ({ diff: gapDiff }))
    const gitShow = vi.fn(async () => ({ content: LINES }))
    const provider: GitProviderDescriptor = {
      id: 'remote',
      match: () => true,
      createSource: () => ({ ...makeSource('commit'), gitCommitDiff, gitShow }) as GitDataSource,
    }
    const service = serviceWith(provider)
    bindGitSourceSeat(fakeCtx(service).ctx)
    const host = hostSpies()

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: REPO, diff: commitRef }))
      })
      await flushEffects()
      expect(container.textContent).toContain('src/a.ts')
      expect(gitCommitDiff).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), commitRef.hashFull, undefined)
      expect(host.gitCommitDiff).not.toHaveBeenCalled()

      // Commit fold sides read the parent (`hash^`) and the commit.
      await expandFold(container)
      expect(gitShow).toHaveBeenCalledWith(expect.anything(), `${commitRef.hashFull}^`, 'src/a.ts', undefined)
      expect(gitShow).toHaveBeenCalledWith(expect.anything(), commitRef.hashFull, 'src/a.ts', undefined)
      expect(host.gitShow).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('falls back PER METHOD: a source lacking gitDiff keeps gitShow on the provider and hops gitDiff to the host', async () => {
    // The provider face is deliberately PARTIAL: it has gitShow but no
    // gitDiff — the diff must still render through the host route for
    // gitDiff alone, and folds must still read through the provider.
    const gitShow = vi.fn(async () => ({ content: LINES }))
    const source = { ...makeSource('worktree'), gitShow } as unknown as GitDataSource
    delete (source as { gitDiff?: unknown }).gitDiff
    const provider: GitProviderDescriptor = {
      id: 'remote',
      match: () => true,
      createSource: () => source,
    }
    const service = serviceWith(provider)
    bindGitSourceSeat(fakeCtx(service).ctx)
    const host = hostSpies()
    host.gitDiff.mockResolvedValue({ diff: gapDiff })
    vi.spyOn(api, 'fsRead').mockResolvedValue({ kind: 'text', content: LINES, truncated: false })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: REPO, diff: worktreeRef }))
      })
      await flushEffects()
      expect(container.textContent).toContain('src/a.ts')
      expect(host.gitDiff).toHaveBeenCalledTimes(1)
      // The provider still owns gitShow on fold expansion.
      await expandFold(container)
      expect(gitShow).toHaveBeenCalledWith(expect.anything(), ':0', 'src/a.ts', undefined)
      expect(host.gitShow).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps the host routes byte for byte with no provider (seat unbound)', async () => {
    const host = hostSpies()
    host.gitDiff.mockResolvedValue({ diff: gapDiff })
    vi.spyOn(api, 'gitShow').mockResolvedValue({ content: LINES })
    vi.spyOn(api, 'fsRead').mockResolvedValue({ kind: 'text', content: LINES, truncated: false })

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: REPO, diff: worktreeRef }))
      })
      await flushEffects()
      expect(host.gitDiff).toHaveBeenCalledTimes(1)
      await expandFold(container)
      expect(host.gitShow).toHaveBeenCalledWith(expect.anything(), ':0', 'src/a.ts', undefined)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})

describe('DiffPane routing through useGitSource (ctx-based)', () => {
  async function mountPane(ctx: Context, target: ChangesPreview): Promise<{ root: Root; container: HTMLDivElement }> {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(DiffPane, {
        ctx,
        target,
        scope: { sessionId: 'session', cwd: REPO },
        height: 300,
        onHeightCommit: () => {},
        onClose: () => {},
        onExpand: () => {},
      }))
    })
    await flushEffects()
    return { root, container }
  }

  it('routes a worktree diff and its fold gitShow through the provider (host api untouched)', async () => {
    const gitDiff = vi.fn(async () => ({ diff: gapDiff }))
    const gitShow = vi.fn(async () => ({ content: LINES }))
    const provider: GitProviderDescriptor = {
      id: 'remote',
      match: () => true,
      createSource: () => ({ ...makeSource('worktree'), gitDiff, gitShow }) as GitDataSource,
    }
    const service = serviceWith(provider)
    vi.spyOn(api, 'fsRead').mockResolvedValue({ kind: 'text', content: LINES, truncated: false })
    const host = hostSpies()

    const { root, container } = await mountPane(fakeCtx(service).ctx, {
      kind: 'git',
      ref: worktreeRef as GitDiffRef,
    })
    try {
      expect(container.textContent).toContain('src/a.ts')
      expect(gitDiff).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), 'src/a.ts', false, undefined)
      expect(host.gitDiff).not.toHaveBeenCalled()
      expect(host.gitCommitDiff).not.toHaveBeenCalled()
      expect(host.gitShow).not.toHaveBeenCalled()

      await expandFold(container)
      expect(gitShow).toHaveBeenCalledWith(expect.anything(), ':0', 'src/a.ts', undefined)
      expect(host.gitShow).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('routes a commit preview through the provider gitCommitDiff + gitShow', async () => {
    const gitCommitDiff = vi.fn(async () => ({ diff: gapDiff }))
    const gitShow = vi.fn(async () => ({ content: LINES }))
    const provider: GitProviderDescriptor = {
      id: 'remote',
      match: () => true,
      createSource: () => ({ ...makeSource('commit'), gitCommitDiff, gitShow }) as GitDataSource,
    }
    const service = serviceWith(provider)
    const host = hostSpies()

    const { root, container } = await mountPane(fakeCtx(service).ctx, {
      kind: 'git',
      ref: commitRef as GitDiffRef,
    })
    try {
      expect(container.textContent).toContain('src/a.ts')
      expect(gitCommitDiff).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), commitRef.hashFull, undefined)
      expect(host.gitCommitDiff).not.toHaveBeenCalled()
      await expandFold(container)
      expect(gitShow).toHaveBeenCalledWith(expect.anything(), `${commitRef.hashFull}^`, 'src/a.ts', undefined)
      expect(host.gitShow).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('keeps the host routes with no provider (ctx without a registry)', async () => {
    const host = hostSpies()
    host.gitDiff.mockResolvedValue({ diff: gapDiff })
    vi.spyOn(api, 'gitShow').mockResolvedValue({ content: LINES })
    vi.spyOn(api, 'fsRead').mockResolvedValue({ kind: 'text', content: LINES, truncated: false })

    const { root, container } = await mountPane(fakeCtx(createBetterSidebarService(createSidebarStore())).ctx, {
      kind: 'git',
      ref: worktreeRef as GitDiffRef,
    })
    try {
      expect(host.gitDiff).toHaveBeenCalledTimes(1)
      await expandFold(container)
      expect(host.gitShow).toHaveBeenCalledWith(expect.anything(), ':0', 'src/a.ts', undefined)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})

describe('git-source client Context seat', () => {
  let observed: readonly GitProviderDescriptor[] | undefined = undefined
  function SeatProbe(): null {
    observed = useGitSourceSeat()
    return null
  }
  async function mountProbe(): Promise<{ root: Root; container: HTMLDivElement }> {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(SeatProbe))
    })
    return { root, container }
  }

  it('unbound seat resolves undefined (host routes stay)', async () => {
    const { root, container } = await mountProbe()
    try {
      expect(observed).toBeUndefined()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('serves the current provider list and re-resolves on register/unregister', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    const { ctx } = fakeCtx(service)
    bindGitSourceSeat(ctx)
    const { root, container } = await mountProbe()
    try {
      expect(observed).toEqual([])
      await act(async () => {
        service.registerGitProvider({ id: 'remote', match: () => true, createSource: () => undefined })
      })
      expect(observed?.map(provider => provider.id)).toEqual(['remote'])
      await act(async () => {
        service.registerGitProvider({ id: 'other', match: () => false, createSource: () => undefined })
      })
      expect(observed?.map(provider => provider.id)).toEqual(['remote', 'other'])
      // Unregister: the snapshot follows (the disposer unregisters).
      let disposer: () => void = () => {}
      await act(async () => {
        disposer = service.registerGitProvider({ id: 'temp', match: () => false, createSource: () => undefined })
      })
      expect(observed?.map(provider => provider.id)).toEqual(['remote', 'other', 'temp'])
      await act(async () => { disposer() })
      expect(observed?.map(provider => provider.id)).toEqual(['remote', 'other'])
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('unbind detaches the seat (a disposed fiber never serves a stale context)', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    const { ctx } = fakeCtx(service)
    bindGitSourceSeat(ctx)
    const first = await mountProbe()
    act(() => { first.root.unmount() })
    first.container.remove()
    await act(async () => { unbindGitSourceSeat() })
    const second = await mountProbe()
    try {
      expect(observed).toBeUndefined()
    } finally {
      act(() => { second.root.unmount() })
      second.container.remove()
    }
  })
})