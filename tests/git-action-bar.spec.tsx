// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { api } from '../src/client/api.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import type { GitDataSource } from '../src/client/git-source.ts'
import type { Context } from '../src/context-types.ts'
import { t } from '../src/client/locales.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()
const MAIN = 'C:/action-bar/main'
const LINKED = 'C:/action-bar/linked'
let session = 0
const mounted: { root: Root; container: HTMLElement }[] = []

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await act(async () => { await Promise.resolve() })
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function mockApi(staged = true): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([
    { path: MAIN, branch: 'main', current: true, changes: 0 },
    { path: LINKED, branch: 'topic', current: false, changes: 1 },
  ])
  vi.spyOn(api, 'gitStatus').mockImplementation(async (_scope, worktree) => ({
    isRepo: true, branch: worktree === LINKED ? 'topic' : 'main', root: worktree ?? MAIN,
    entries: [{ path: 'change.ts', xy: staged ? 'M ' : ' M' }],
  }))
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'topic', names: ['topic'] })
  vi.spyOn(api, 'gitLog').mockResolvedValue([])
}
async function mount(service?: BetterSidebarService, committed = vi.fn(), ctx?: Context): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  const sessionId = `action-bar-${++session}`
  function Harness(): ReturnType<typeof createElement> {
    const [draft, setDraft] = useState('  test commit  ')
    return createElement(GitLens, {
      scope: { sessionId, cwd: MAIN }, store: createSidebarStore(), service, ctx,
      commitMsg: draft, onCommitMsgChange: setDraft, onCommitMsgCommitted: committed,
      onOpenFile: () => {}, onPreview: () => {}, selectedRef: null, visible: true,
    })
  }
  await act(async () => { root.render(createElement(Harness)) })
  await flush()
  return container
}
function button(container: ParentNode, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === label)
  expect(result, `button ${label}`).toBeDefined()
  return result!
}
async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click() })
  await flush()
}
async function commitAndPush(container: HTMLElement): Promise<void> {
  await click(button(container, t('gitMoreActions')))
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(node => node.textContent?.trim() === t('gitCommitAndPush'))
  expect(item).toBeDefined()
  expect(container.contains(item!)).toBe(false)
  await click(item!)
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => { root.unmount() })
    container.remove()
  }
  vi.restoreAllMocks()
})

describe('Git action bar common mutations and overflow', () => {
  it('Push uses the selected linked checkout and the live session scope', async () => {
    mockApi()
    const push = vi.spyOn(api, 'gitPush').mockResolvedValue({ ok: true })
    const commit = vi.spyOn(api, 'gitCommit').mockResolvedValue({ ok: true })
    const container = await mount()
    expect(container.querySelector<HTMLButtonElement>('[data-git-selector="worktree"]')?.value).toBe(LINKED)
    await click(button(container, t('gitMoreActions')))
    const pushItem = button(document.body, t('gitPush'))
    expect(container.contains(pushItem)).toBe(false)
    await click(pushItem)
    expect(push).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: MAIN, sessionId: expect.stringMatching(/^action-bar-/) }), LINKED)
    expect(commit).not.toHaveBeenCalled()
  })

  it('disables Push for a matched provider without gitPush instead of falling back to local Git', async () => {
    const localPush = vi.spyOn(api, 'gitPush').mockResolvedValue({ ok: true })
    const localStatus = vi.spyOn(api, 'gitStatus')
    const localWorktrees = vi.spyOn(api, 'gitWorktrees')
    const source: GitDataSource = {
      gitStatus: async () => ({ isRepo: true, branch: 'main', root: MAIN, entries: [{ path: 'provider.ts', xy: 'M ' }] }),
      gitWorktrees: async () => [{ path: MAIN, branch: 'main', current: true, changes: 1 }],
      gitBranch: async () => ({ current: 'main', names: ['main'] }),
      gitLog: async () => [],
      gitDiff: async () => ({ diff: '' }),
      gitCommitDiff: async () => ({ diff: '' }),
      gitShow: async () => ({ content: null }),
      gitStage: async () => ({ ok: true }),
      gitUnstage: async () => ({ ok: true }),
      gitCommit: async () => ({ ok: true }),
      gitCheckout: async () => ({ ok: true }),
      gitDiscard: async () => ({ ok: true }),
      gitRevert: async () => ({ ok: true }),
      gitCherryPick: async () => ({ ok: true }),
    }
    const service = createBetterSidebarService(createSidebarStore())
    service.registerGitProvider({ id: 'without-push', match: () => true, createSource: () => source })
    const ctx = {
      betterSidebar: service,
      get: (key: string): unknown => key === 'betterSidebar' ? service : undefined,
    } as unknown as Context
    const container = await mount(service, vi.fn(), ctx)
    expect(container.textContent).toContain('provider.ts')
    await click(button(container, t('gitMoreActions')))
    const pushButton = button(document.body, t('gitPush'))
    expect(container.contains(pushButton)).toBe(false)
    expect(pushButton.disabled).toBe(true)
    await click(pushButton)
    const combined = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(node => node.textContent?.trim() === t('gitCommitAndPush'))
    expect(combined).toBeDefined()
    expect((combined as HTMLButtonElement).disabled).toBe(true)
    await click(combined!)
    expect(localPush).not.toHaveBeenCalled()
    expect(localStatus).not.toHaveBeenCalled()
    expect(localWorktrees).not.toHaveBeenCalled()
  })

  it('does not commit on Ctrl+Enter or Meta+Enter without staged files', async () => {
    mockApi(false)
    const commit = vi.spyOn(api, 'gitCommit').mockResolvedValue({ ok: true })
    const container = await mount()
    expect(button(container, t('commit')).disabled).toBe(true)
    const input = container.querySelector<HTMLInputElement>('[data-git-action-bar] input')!
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    })
    expect(commit).not.toHaveBeenCalled()
  })

  it('Commit and Push waits for commit success and clears the durable draft even if push fails', async () => {
    mockApi()
    const pending = deferred<{ ok: true }>()
    const order: string[] = []
    const commit = vi.spyOn(api, 'gitCommit').mockImplementation(() => { order.push('commit'); return pending.promise })
    const push = vi.spyOn(api, 'gitPush').mockImplementation(async () => { order.push('push'); throw new Error('remote rejected') })
    const committed = vi.fn()
    const container = await mount(undefined, committed)
    await commitAndPush(container)
    expect(commit).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'test commit', LINKED)
    expect(push).not.toHaveBeenCalled()
    await act(async () => { pending.resolve({ ok: true }) })
    await flush()
    expect(order).toEqual(['commit', 'push'])
    expect(push).toHaveBeenCalledExactlyOnceWith(commit.mock.calls[0]![0], LINKED)
    expect(container.querySelector<HTMLInputElement>('[data-git-action-bar] input')!.value).toBe('')
    expect(committed).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('remote rejected')
  })

  it('does not push or clear the draft if the preceding commit fails', async () => {
    mockApi()
    vi.spyOn(api, 'gitCommit').mockRejectedValue(new Error('commit rejected'))
    const push = vi.spyOn(api, 'gitPush').mockResolvedValue({ ok: true })
    const committed = vi.fn()
    const container = await mount(undefined, committed)
    await commitAndPush(container)
    expect(push).not.toHaveBeenCalled()
    expect(committed).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLInputElement>('[data-git-action-bar] input')!.value).toBe('  test commit  ')
    expect(container.textContent).toContain('commit rejected')
  })

  it('locks mutations against double clicks while Push is pending', async () => {
    mockApi()
    const pending = deferred<{ ok: true }>()
    const push = vi.spyOn(api, 'gitPush').mockReturnValue(pending.promise)
    const commit = vi.spyOn(api, 'gitCommit').mockResolvedValue({ ok: true })
    const container = await mount()
    await click(button(container, t('gitMoreActions')))
    const pushButton = button(document.body, t('gitPush'))
    // Dispatch both clicks in one act: after the menu closes this node is
    // detached, so later assertions must query the live row/menu again.
    await act(async () => { pushButton.click(); pushButton.click(); button(container, t('commit')).click() })
    expect(push).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
    expect(pushButton.isConnected).toBe(false)
    expect(document.body.querySelector('[role="menuitem"]')).toBeNull()
    expect(button(container, t('commit')).disabled).toBe(true)
    expect(button(container, t('gitMoreActions')).disabled).toBe(true)
    expect(container.querySelector<HTMLInputElement>('[data-git-action-bar] input')!.disabled).toBe(true)
    await act(async () => { pending.resolve({ ok: true }) })
    await flush()
    expect(button(container, t('gitMoreActions')).disabled).toBe(false)
    await click(button(container, t('gitMoreActions')))
    expect(button(document.body, t('gitPush')).disabled).toBe(false)
  })

  it('defaults to exactly Commit and More and puts all whole legacy components in the More portal', async () => {
    mockApi()
    const service = createBetterSidebarService(createSidebarStore())
    const action = vi.fn()
    for (let index = 0; index < 4; index += 1) service.registerGitCommitAction({
      id: `legacy-${index}`, order: index,
      component: () => createElement('button', { 'data-testid': `legacy-${index}`, onClick: action }, `legacy ${index}`),
    })
    const container = await mount(service)
    const actionBar = container.querySelector('[data-git-action-bar]')!
    expect([...actionBar.querySelectorAll('button')].map(node => node.getAttribute('aria-label') ?? node.textContent?.trim()))
      .toEqual([t('commit'), t('gitMoreActions')])
    const more = button(actionBar, t('gitMoreActions'))
    expect(more.textContent?.trim()).toBe('')
    expect(more.querySelector('svg')).not.toBeNull()
    expect([...actionBar.querySelectorAll('button')].some(node => node.textContent?.trim() === t('gitPush'))).toBe(false)
    expect(actionBar.querySelector('[data-testid^="legacy-"]')).toBeNull()
    expect(document.body.querySelector('[data-testid^="legacy-"]')).toBeNull()
    await click(button(container, t('gitMoreActions')))
    expect(container.contains(button(document.body, t('gitPush')))).toBe(false)
    for (const index of [0, 1, 2, 3]) {
      const overflow = document.body.querySelector<HTMLElement>(`[data-testid="legacy-${index}"]`)
      expect(overflow).not.toBeNull()
      expect(container.contains(overflow)).toBe(false)
    }
    await click(document.body.querySelector<HTMLElement>('[data-testid="legacy-2"]')!)
    expect(action).toHaveBeenCalledTimes(1)
  })
})
