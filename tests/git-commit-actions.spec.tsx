/**
 * The Git commit-action seam (feature `gitCommitActions`): registered actions
 * render inside the Git lens' portaled More menu, receive the LIVE Git target
 * (source session, selected repo/worktree, staged rows), are ordered by `order`,
 * gated by `available`, and survive a crashing sibling. The default operation
 * row always contains exactly Commit and More, never Push or legacy actions.
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
import { t } from '../src/client/locales.ts'

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
      visible: true,
    }))
  })
  await flushEffects()
  return { root, container }
}

function expectDefaultRow(container: HTMLElement): void {
  const row = container.querySelector('[data-git-action-bar]')!
  expect([...row.querySelectorAll('button')].map(button => button.textContent?.trim()))
    .toEqual([t('commit'), t('gitMoreActions')])
  expect(row.textContent).not.toContain(t('gitPush'))
  expect(row.querySelector('[data-testid]')).toBeNull()
}

async function openMore(container: HTMLElement): Promise<void> {
  const more = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === t('gitMoreActions'))!
  await act(async () => { more.click() })
  await flushEffects()
  expect(more.getAttribute('aria-expanded')).toBe('true')
  const push = [...document.body.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === t('gitPush'))
  expect(push).toBeDefined()
  expect(container.contains(push!)).toBe(false)
}

describe('GitLens More-menu actions (feature gitCommitActions)', () => {
  it('renders a registered action in the More portal with the live Git target', async () => {
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
      expectDefaultRow(container)
      expect(document.body.querySelector('[data-testid="agent-action"]')).toBeNull()
      await openMore(container)
      const action = document.body.querySelector('[data-testid="agent-action"]')!
      expect(action).not.toBeNull()
      expect(container.contains(action)).toBe(false)

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
      id: 'early-tie',
      order: 10,
      component: () => createElement('button', { type: 'button', 'data-testid': 'early-tie' }, 'early tie'),
    })
    service.registerGitCommitAction({
      id: 'hidden',
      available: (target) => target.staged.length > 99,
      component: () => createElement('button', { type: 'button', 'data-testid': 'hidden' }, 'hidden'),
    })

    const { root, container } = await mountLens(service)
    try {
      expectDefaultRow(container)
      await openMore(container)
      expect(document.body.querySelector('[data-testid="hidden"]')).toBeNull()
      const ids = [...document.body.querySelectorAll('[data-testid]')].map(node => node.getAttribute('data-testid'))
      expect(ids).toEqual(['early', 'early-tie', 'late'])
      expectDefaultRow(container)
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
      expectDefaultRow(container)
      await openMore(container)
      expect(document.body.querySelector('[data-testid="late-action"]')).toBeNull()
      let dispose = (): void => {}
      await act(async () => {
        dispose = service.registerGitCommitAction({
          id: 'late-registration',
          component: () => createElement('button', { type: 'button', 'data-testid': 'late-action' }, 'late'),
        })
      })
      await flushEffects()
      const action = document.body.querySelector('[data-testid="late-action"]')
      expect(action).not.toBeNull()
      expect(container.contains(action)).toBe(false)
      expectDefaultRow(container)

      await act(async () => { dispose() })
      await flushEffects()
      expect(document.body.querySelector('[data-testid="late-action"]')).toBeNull()
      expect(container.querySelector('[aria-expanded="true"]')).not.toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('defaults to exactly Commit and More without a service or registered actions', async () => {
    mockApi()
    for (const service of [undefined, createBetterSidebarService(createSidebarStore())]) {
      const { root, container } = await mountLens(service)
      try {
        expectDefaultRow(container)
        expect(container.textContent).not.toContain('dsh-better-sidebar:')
        expect(document.body.querySelector('[role="menuitem"]')).toBeNull()
      } finally {
        act(() => { root.unmount() })
        container.remove()
      }
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
    service.registerGitCommitAction({
      id: 'survivor',
      component: () => createElement('button', { type: 'button', 'data-testid': 'survivor' }, 'survivor'),
    })

    const { root, container } = await mountLens(service)
    try {
      expectDefaultRow(container)
      expect(errors).not.toHaveBeenCalled()
      await openMore(container)
      // The boundary catches errors only when the action mounts in More.
      expect(document.body.textContent).toContain('action exploded')
      expect(container.textContent).not.toContain('action exploded')
      expect(document.body.querySelector('[data-testid="survivor"]')).not.toBeNull()
      expectDefaultRow(container)
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
