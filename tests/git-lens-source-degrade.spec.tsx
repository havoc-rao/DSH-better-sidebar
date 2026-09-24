/**
 * The Git lens' read resilience under a PARTIAL provider source (feature
 * 'gitSource'): the refresh's reads are deferred into microtasks, so a
 * matched source that LACKS a method (e.g. the old dsh-remote method face:
 * gitLogGraph instead of gitLog) must degrade per surface — empty history —
 * while status and branch choices still render through the provider. Before
 * the deferral, the synchronous TypeError while the Promise.all array was
 * being built aborted the WHOLE refresh: status/branch/log all lost, only
 * the error banner.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { GitDataSource, GitOkResult, GitProviderDescriptor } from '../src/client/git-source.ts'
import { api, type GitStatusResult } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const REPO = 'C:/repo/main'

const STATUS: GitStatusResult = {
  isRepo: true,
  branch: 'main',
  root: REPO,
  entries: [{ path: 'staged.ts', xy: 'M ' }],
}

/** A complete provider source; tests then DELETE the method under test. */
function makeSource(): GitDataSource {
  return {
    gitStatus: async (): Promise<GitStatusResult> => STATUS,
    gitWorktrees: async () => [{ path: REPO, branch: 'main', current: true, changes: 1 }],
    gitBranch: async () => ({ current: 'main', names: ['main'] }),
    gitLog: async () => [],
    gitDiff: async () => ({ diff: '' }),
    gitCommitDiff: async () => ({ diff: '' }),
    gitShow: async () => ({ content: null }),
    gitStage: async (): Promise<GitOkResult> => ({ ok: true }),
    gitUnstage: async (): Promise<GitOkResult> => ({ ok: true }),
    gitCommit: async (): Promise<GitOkResult> => ({ ok: true }),
    gitCheckout: async (): Promise<GitOkResult> => ({ ok: true }),
    gitDiscard: async (): Promise<GitOkResult> => ({ ok: true }),
    gitRevert: async (): Promise<GitOkResult> => ({ ok: true }),
    gitCherryPick: async (): Promise<GitOkResult> => ({ ok: true }),
  }
}

/** A registry service with one provider whose source lacks `missing`. */
function serviceWithout(missing: 'gitLog' | 'gitBranch'): BetterSidebarService {
  const source = makeSource()
  delete (source as { gitLog?: unknown; gitBranch?: unknown })[missing]
  const provider: GitProviderDescriptor = {
    id: 'remote',
    match: () => true,
    createSource: () => source as unknown as GitDataSource,
  }
  const service = createBetterSidebarService(createSidebarStore())
  service.registerGitProvider(provider)
  return service
}

/** The client Context face useGitSource consumes (the betterSidebar service
 *  is a direct property + reachable through get). */
function fakeCtx(service: BetterSidebarService): Context {
  return {
    betterSidebar: service,
    get: (key: string): unknown => (key === 'betterSidebar' ? service : undefined),
  } as unknown as Context
}

async function flushEffects(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

afterEach(() => { vi.restoreAllMocks() })

describe('GitLens resilience with a partial provider source', () => {
  it('a source lacking gitLog renders status + branch and degrades history to empty (host api untouched)', async () => {
    const hostLog = vi.spyOn(api, 'gitLog')
    const hostStatus = vi.spyOn(api, 'gitStatus')
    const hostBranch = vi.spyOn(api, 'gitBranch')
    const hostWorktrees = vi.spyOn(api, 'gitWorktrees')

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(GitLens, {
          ctx: fakeCtx(serviceWithout('gitLog')),
          scope: { sessionId: 'session', cwd: REPO },
          store: createSidebarStore(),
          commitMsg: '',
          onCommitMsgChange: () => {},
          onCommitMsgCommitted: () => {},
          onOpenFile: () => {},
          onPreview: () => {},
          selectedRef: null,
          visible: false,
        }))
      })
      await flushEffects()

      // Status and branch render through the provider...
      expect(container.textContent).toContain('staged.ts')
      const select = container.querySelector<HTMLSelectElement>('select')
      expect(select?.value).toBe('main')
      // ...the history section is EMPTY (no log rows) instead of an error...
      expect(container.textContent).toContain('History')
      expect(container.textContent).not.toContain('not a function')
      // ...and everything came from the provider: the host routes were never
      // touched (the debacle this pins: the sync TypeError used to abort the
      // whole refresh and drop status/branch with it).
      expect(hostLog).not.toHaveBeenCalled()
      expect(hostStatus).not.toHaveBeenCalled()
      expect(hostBranch).not.toHaveBeenCalled()
      expect(hostWorktrees).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('a source lacking gitBranch still renders status and history (empty branch names)', async () => {
    const hostBranch = vi.spyOn(api, 'gitBranch')

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(GitLens, {
          ctx: fakeCtx(serviceWithout('gitBranch')),
          scope: { sessionId: 'session', cwd: REPO },
          store: createSidebarStore(),
          commitMsg: '',
          onCommitMsgChange: () => {},
          onCommitMsgCommitted: () => {},
          onOpenFile: () => {},
          onPreview: () => {},
          selectedRef: null,
          visible: false,
        }))
      })
      await flushEffects()

      // The status list survives; the branch select still shows the CURRENT
      // branch from the status result (names fell back to empty).
      expect(container.textContent).toContain('staged.ts')
      const select = container.querySelector<HTMLSelectElement>('select')
      expect(select?.value).toBe('main')
      expect(container.textContent).not.toContain('not a function')
      // The provider owns the surface: the host branch route was never hit.
      expect(hostBranch).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})