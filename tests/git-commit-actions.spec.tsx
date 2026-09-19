/**
 * The Git commit-action seam (feature `gitCommitActions`): registered actions
 * render inside the Git lens' commit row, receive the LIVE Git target (source
 * session, selected repo/worktree, staged rows), are ordered by `order`, are
 * gated by `available`, survive a crashing sibling, and leave the row
 * untouched when nothing registers.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createBetterSidebarService, type BetterSidebarService, type GitCommitActionProps, type GitCommitTarget } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { api, type GitStatusResult } from '../src/client/api.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const REPO = 'C:/repo/main'

const STATUS: GitStatusResult = {
  isRepo: true,
  branch: 'main',
  root: REPO,
  entries: [
    { path: 'staged.ts', xy: 'M ' },
    { path: 'loose.ts', xy: ' M' },
  ],
}

/** Mock the Git lens' data sources with one current checkout. */
function mockApi(): { status: ReturnType<typeof vi.spyOn> } {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: REPO, branch: 'main', current: true, changes: 2 }])
  const status = vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitLog').mockResolvedValue([])
  return { status }
}

async function flushEffects(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

afterEach(() => { vi.restoreAllMocks() })

/** Mount the lens against a service and return the root/container pair. */
async function mountLens(service: BetterSidebarService | undefined): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(GitLens, {
      scope: { sessionId: 'session', cwd: REPO },
      store: createSidebarStore(),
      ...(service === undefined ? {} : { service }),
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
  return { root, container }
}

function commitButtonIndex(container: HTMLElement): number {
  return [...container.querySelectorAll('button')].findIndex(button => button.textContent === 'Commit')
}

describe('GitLens commit-row actions (feature gitCommitActions)', () => {
  it('renders a registered action after the Commit button with the live Git target', async () => {
    mockApi()
    const service = createBetterSidebarService(createSidebarStore())
    const seen: GitCommitActionProps[] = []
    service.registerGitCommitAction({
      id: 'agent:commit',
      component: (props) => {
        seen.push(props)
        return createElement('button', { type: 'button', 'data-testid': 'agent-action' }, 'Agent')
      },
    })

    const { root, container } = await mountLens(service)
    try {
      const action = container.querySelector('[data-testid="agent-action"]')!
      const buttons = [...container.querySelectorAll('button')]
      expect(action).not.toBeNull()
      expect(buttons.indexOf(action as HTMLButtonElement)).toBeGreaterThan(commitButtonIndex(container))

      const props = seen.at(-1)!
      // The live target: source session, resolved repo root, selected
      // checkout, branch and EXACTLY the rows the Commit button gates on.
      expect(props.scope.sessionId).toBe('session')
      expect(props.repoRoot).toBe(REPO)
      expect(props.worktree).toBe(REPO)
      expect(props.branch).toBe('main')
      expect(props.staged.map(entry => entry.path)).toEqual(['staged.ts'])
      expect(props.service).toBe(service)
      expect(typeof props.refresh).toBe('function')

      // The same target is readable off the service (point-in-time read).
      const published: GitCommitTarget | undefined = service.getGitCommitTarget({ sessionId: 'session' })
      expect(published?.scope.sessionId).toBe('session')
      expect(published?.staged.map(entry => entry.path)).toEqual(['staged.ts'])
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('orders actions by order (then registration) and skips unavailable ones', async () => {
    mockApi()
    const service = createBetterSidebarService(createSidebarStore())
    service.registerGitCommitAction({
      id: 'late',
      order: 200,
      component: () => createElement('button', { type: 'button', 'data-testid': 'late' }, 'late'),
    })
    service.registerGitCommitAction({
      id: 'early',
      order: 10,
      component: () => createElement('button', { type: 'button', 'data-testid': 'early' }, 'early'),
    })
    service.registerGitCommitAction({
      id: 'hidden',
      available: (target) => target.staged.length > 99,
      component: () => createElement('button', { type: 'button', 'data-testid': 'hidden' }, 'hidden'),
    })

    const { root, container } = await mountLens(service)
    try {
      expect(container.querySelector('[data-testid="hidden"]')).toBeNull()
      const ids = [...container.querySelectorAll('[data-testid]')].map(node => node.getAttribute('data-testid'))
      expect(ids.indexOf('early')).toBeLessThan(ids.indexOf('late'))
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('renders actions registered AFTER mount (registry subscription) and drops disposed ones', async () => {
    mockApi()
    const service = createBetterSidebarService(createSidebarStore())
    const { root, container } = await mountLens(service)
    try {
      expect(container.querySelector('[data-testid="late-action"]')).toBeNull()
      let dispose = (): void => {}
      await act(async () => {
        dispose = service.registerGitCommitAction({
          id: 'late-registration',
          component: () => createElement('button', { type: 'button', 'data-testid': 'late-action' }, 'late'),
        })
      })
      await flushEffects()
      expect(container.querySelector('[data-testid="late-action"]')).not.toBeNull()

      await act(async () => { dispose() })
      await flushEffects()
      expect(container.querySelector('[data-testid="late-action"]')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('leaves the commit row untouched when no service or no action is registered', async () => {
    mockApi()
    const withoutService = await mountLens(undefined)
    try {
      // The built-in commit row is intact and no action group exists.
      expect(commitButtonIndex(withoutService.container)).toBeGreaterThan(-1)
      expect(withoutService.container.textContent).not.toContain('dsh-better-sidebar:')
    } finally {
      act(() => { withoutService.root.unmount() })
      withoutService.container.remove()
    }
  })

  it('isolates a crashing action without breaking the commit row', async () => {
    mockApi()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    // React DEV re-reports a boundary-caught render error to the window; keep
    // jsdom's virtual console quiet while we assert the containment.
    const swallow = (event: ErrorEvent): void => { event.preventDefault() }
    window.addEventListener('error', swallow)
    const service = createBetterSidebarService(createSidebarStore())
    service.registerGitCommitAction({
      id: 'kaboom',
      component: () => { throw new Error('action exploded') },
    })

    const { root, container } = await mountLens(service)
    try {
      // The boundary caught it and the built-in commit row still rendered.
      expect(container.textContent).toContain('action exploded')
      expect(commitButtonIndex(container)).toBeGreaterThan(-1)
      expect(errors).toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
      window.removeEventListener('error', swallow)
    }
  })

  it('clears the published target on unmount so consumers never see a stale checkout', async () => {
    mockApi()
    const service = createBetterSidebarService(createSidebarStore())
    const { root, container } = await mountLens(service)
    expect(service.getGitCommitTarget({ sessionId: 'session' })).toBeDefined()
    act(() => { root.unmount() })
    container.remove()
    expect(service.getGitCommitTarget({ sessionId: 'session' })).toBeUndefined()
  })
})
