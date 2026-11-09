// @vitest-environment jsdom
/** Run is click-only, session-owned, isolated, and rejects unfinished/non-shell fences. */
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { CodeBlockRunAction, isRunnableShellBlock } from '../src/client/code-block-run.tsx'
import { api, type WorkspaceTerminalInfo } from '../src/client/api.ts'
import { allLeaves, createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()
afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })
it('accepts completed shell source only, not prompts, console transcripts or other code', () => {
  expect(isRunnableShellBlock('bash', 'printf hello\nprintf world', false)).toBe(true)
  for (const [lang, source, streaming] of [
    ['bash', 'echo hi', true], ['js', 'alert(1)', false], ['console', 'output', false],
    ['sh', '$ echo hi', false], ['sh', '', false], ['sh', 'echo\0x', false],
  ] as const) expect(isRunnableShellBlock(lang, source, streaming)).toBe(false)
})
it('starts once on click and opens its captured session even after navigation', async () => {
  const store = createSidebarStore(); store.setSession('A')
  const service = createBetterSidebarService(store)
  let finish!: (info: WorkspaceTerminalInfo) => void
  const run = vi.spyOn(api, 'workspaceTerminalRun').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const root = renderRoot(createElement(CodeBlockRunAction, {
    source: 'echo hello', lang: 'bash', streaming: false, sessionId: 'A', store,
    ctx: { betterSidebar: service } as Context,
  }))
  expect(run).not.toHaveBeenCalled()
  await act(async () => { root.container.querySelector('button')!.click(); root.container.querySelector('button')!.click() })
  expect(run).toHaveBeenCalledExactlyOnceWith('A', 'echo hello', undefined, expect.any(String))
  act(() => { store.setSession('B') })
  await act(async () => { finish({ terminalId: 'terminal:run', title: 'Run', cwd: '/a', createdBySessionId: 'A', createdAt: 1, exited: false }) })
  expect(store.getSnapshot().sessionId).toBe('B')
  expect(allLeaves(store.getSessionState('B')!.bottomSplits).flatMap(leaf => leaf.tabs)).toHaveLength(0)
  expect(allLeaves(store.getSessionState('A')!.bottomSplits).flatMap(leaf => leaf.tabs).some(tab => (tab.meta as { workspaceTerminalId?: string } | undefined)?.workspaceTerminalId === 'terminal:run')).toBe(true)
  expect(store.getSessionState('A')!.bottomOpen).toBe(true)
  root.unmount()
})
it('hides the action for streaming source and disabled terminals', () => {
  const store = createSidebarStore(); store.setSession('A')
  const service = createBetterSidebarService(store)
  const props = { source: 'echo hello', lang: 'sh', streaming: true, sessionId: 'A', store, ctx: { betterSidebar: service } as Context }
  const root = renderRoot(createElement(CodeBlockRunAction, props))
  expect(root.container.querySelector('button')).toBeNull()
  act(() => { store.setPrefs({ ...store.getPrefs(), tabsEnabled: { ...store.getPrefs().tabsEnabled, terminal: false } }) })
  root.rerender(createElement(CodeBlockRunAction, { ...props, streaming: false }))
  expect(root.container.querySelector('button')).toBeNull()
  root.unmount()
})
it('reports launch failure without opening an unrelated terminal', async () => {
  const store = createSidebarStore(); store.setSession('A')
  const service = createBetterSidebarService(store)
  vi.spyOn(api, 'workspaceTerminalRun').mockRejectedValue(new Error('workspace quota reached'))
  const root = renderRoot(createElement(CodeBlockRunAction, {
    source: 'echo hello', lang: 'sh', streaming: false, sessionId: 'A', store, ctx: { betterSidebar: service } as Context,
  }))
  await act(async () => { root.container.querySelector('button')!.click() })
  expect(root.container.querySelector('[role="alert"]')?.textContent).toBe('workspace quota reached')
  expect(store.getSessionState('A')!.workspaceTerminalError).toBe('workspace quota reached')
  expect(root.container.querySelector('button')!.disabled).toBe(false)
  root.unmount()
})
it('reuses the operation identity after an ambiguous network failure', async () => {
  const store = createSidebarStore(); store.setSession('A')
  const service = createBetterSidebarService(store)
  const run = vi.spyOn(api, 'workspaceTerminalRun').mockRejectedValue(new Error('connection lost'))
  const root = renderRoot(createElement(CodeBlockRunAction, {
    source: 'echo hello', lang: 'sh', streaming: false, sessionId: 'A', store, ctx: { betterSidebar: service } as Context,
  }))
  await act(async () => { root.container.querySelector('button')!.click() })
  await act(async () => { root.container.querySelector('button')!.click() })
  expect(run).toHaveBeenCalledTimes(2)
  expect(run.mock.calls[0]![3]).toBeTruthy()
  expect(run.mock.calls[1]![3]).toBe(run.mock.calls[0]![3])
  root.unmount()
})
it('never falls through a remote terminal provider to local execution', async () => {
  const store = createSidebarStore(); store.setSession('A')
  const service = createBetterSidebarService(store)
  service.registerTerminalProvider({ id: 'remote', match: () => true, createTransport: () => undefined })
  const run = vi.spyOn(api, 'workspaceTerminalRun')
  const root = renderRoot(createElement(CodeBlockRunAction, {
    source: 'echo hello', lang: 'sh', streaming: false, sessionId: 'A', store,
    ctx: { betterSidebar: service } as Context,
  }))
  await act(async () => { root.container.querySelector('button')!.click() })
  expect(run).not.toHaveBeenCalled()
  expect(root.container.querySelector('[role="alert"]')).not.toBeNull()
  root.unmount()
})
