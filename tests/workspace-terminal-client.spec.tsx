// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { t } from '../src/client/locales.ts'
import { createElement, useSyncExternalStore } from 'react'
import type { Context } from '../src/context-types.ts'
import { builtinTabs } from '../src/client/builtins/tabs.tsx'
import { TabBar } from '../src/client/TabBar.tsx'
import { buildNewTabOptions, TabContent } from '../src/client/sidebar/TabContent.tsx'
import { act } from 'react-dom/test-utils'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore, allLeaves, closeTab, sanitizeState } from '../src/client/state.ts'
import { api, type WorkspaceTerminalInfo } from '../src/client/api.ts'
import { openWorkspaceTerminal, restartWorkspaceTerminal, workspaceTerminalIdOf } from '../src/client/workspace-terminals.ts'
import { WorkspaceTerminals } from '../src/client/WorkspaceTerminals.tsx'
import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()
const info: WorkspaceTerminalInfo = { terminalId: 'terminal:abc', title: 'shared', cwd: '/work', createdBySessionId: 'A', createdAt: 1, exited: false }
const tabs = (store: ReturnType<typeof createSidebarStore>) => allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })
function fixture() {
  const store = createSidebarStore(); store.setSession('A')
  const service = createBetterSidebarService(store, undefined, () => '/work')
  service.registerTab({ id: 'terminal', title: 'Terminal', component: () => null,
    createTab: () => ({ tab: { id: 'terminal:legacy', type: 'terminal', title: 'legacy' } }) })
  return { store, service }
}
describe('workspace terminal client', () => {
  it('opens the inline manager from the real TabBar + menu', async () => {
    const { store, service } = fixture()
    const ctx = { get: (name: string) => name === 'betterSidebar' ? service : undefined } as Context
    const manager = builtinTabs(ctx).find(tab => tab.id === 'workspace-terminals')!
    service.registerTab(manager)
    const list = vi.spyOn(api, 'workspaceTerminalList').mockResolvedValue({ terminals: [info] })
    function Harness() {
      const snapshot = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
      const leaf = allLeaves(snapshot.state!.bottomSplits)[0]!
      return createElement('div', null,
        createElement(TabBar, { paneId: leaf.id, tabs: leaf.tabs, active: leaf.active,
          newTabOptions: buildNewTabOptions(snapshot.state!, ctx, { sessionId: 'A' }),
          onNewTab: id => service.openTab({ type: id, target: 'bottom' }),
          onActivate: () => {}, onClose: () => {}, onDropTab: () => {} }),
        ...leaf.tabs.map(tab => createElement(TabContent, { key: tab.id, tab, paneId: leaf.id,
          sessionId: 'A', cwd: '/work', ctx, store, expanded: [], revealed: [], visible: true,
          onToggleDir: () => {}, onReferenceFile: () => {}, onSubagentJump: () => {}, onOpenDiff: () => {},
          localeRevision: 'en', tabsVersion: 0 })),
      )
    }
    const root = renderRoot(createElement(Harness))
    expect(list).not.toHaveBeenCalled()
    await act(async () => { root.container.querySelector<HTMLButtonElement>('button[aria-label]')!.click() })
    const title = typeof manager.title === 'function' ? manager.title() : manager.title
    const entry = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.includes(title)) as HTMLElement
    expect(entry).toBeDefined()
    await act(async () => { entry.click() })
    expect(tabs(store).map(tab => tab.type)).toEqual(['workspace-terminals'])
    expect(list).toHaveBeenCalledWith('A', expect.any(AbortSignal))
    expect(root.container.querySelector('section')?.textContent).toContain('shared')
    root.unmount()
  })

  it('subscribes to errors and reads only the specified session', async () => {
    const { store } = fixture()
    vi.spyOn(api, 'workspaceTerminalList').mockRejectedValue(new Error('list failed'))
    const root = renderRoot(createElement(WorkspaceTerminals, { sessionId: 'A', store }))
    await act(async () => {})
    expect(root.container.querySelector('[role="alert"]')?.textContent).toBe('list failed')
    act(() => { store.reduce(state => ({ ...state, workspaceTerminalError: 'updated' })) })
    expect(root.container.querySelector('[role="alert"]')?.textContent).toBe('updated')
    act(() => { store.setSession('B'); store.reduce(state => ({ ...state, workspaceTerminalError: 'B error' })) })
    expect(root.container.querySelector('[role="alert"]')?.textContent).toBe('updated')
    root.unmount()
  })

  it('aborts the mounted list when hidden or unmounted', async () => {
    const { store } = fixture()
    const list = vi.spyOn(api, 'workspaceTerminalList').mockImplementation(() => new Promise(() => {}))
    const root = renderRoot(createElement(WorkspaceTerminals, { sessionId: 'A', store, visible: false }))
    expect(list).not.toHaveBeenCalled()
    root.rerender(createElement(WorkspaceTerminals, { sessionId: 'A', store, visible: true }))
    const signal = list.mock.calls[0]![1]!
    root.rerender(createElement(WorkspaceTerminals, { sessionId: 'A', store, visible: false }))
    expect(signal.aborted).toBe(true)
    root.rerender(createElement(WorkspaceTerminals, { sessionId: 'A', store, visible: true }))
    const nextSignal = list.mock.calls[1]![1]!
    root.unmount()
    expect(nextSignal.aborted).toBe(true)
  })
  it('keeps rows during refresh and on failure, with accurate status counts and source titles', async () => {
    const { store } = fixture()
    const sourceId = 'abcdefgh-1234-5678-9012-source'
    const running = { ...info, createdBySessionId: sourceId }
    const exited = { ...info, terminalId: 'terminal:exited', title: 'finished', exited: true, exitCode: 7 }
    let reject!: (reason: Error) => void
    const list = vi.spyOn(api, 'workspaceTerminalList').mockResolvedValueOnce({ terminals: [running, exited] })
      .mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail }))
    let snapshot = { byId: { [sourceId]: { id: sourceId, displayTitle: 'Build source', cwd: '/work' } } }
    let notify!: () => void
    const ctx = { sessions: { list: { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { notify = listener; return () => {} } } } } as unknown as Context
    const root = renderRoot(createElement(WorkspaceTerminals, { sessionId: 'A', store, ctx }))
    await act(async () => {})
    const section = root.container.querySelector('section')!
    const header = section.querySelector('header')!
    expect(header.textContent).toContain(`1 ${t('workspaceTerminalRunning')}`)
    expect(header.textContent).toContain(`1 ${t('workspaceTerminalExited')}`)
    expect(section.querySelectorAll('[role="listitem"]')).toHaveLength(2)
    expect(section.querySelector('[title="/work"]')?.textContent).toBe('/work')
    expect(section.querySelector(`[title="Build source · ${sourceId}"]`)?.textContent).toBe('Build source')
    expect(section.textContent).not.toContain(sourceId)
    act(() => { snapshot = { byId: { [sourceId]: { id: sourceId, displayTitle: 'Renamed source', cwd: '/work' } } }; notify() })
    expect(section.querySelector(`[title="Renamed source · ${sourceId}"]`)?.textContent).toBe('Renamed source')
    expect(list).toHaveBeenCalledTimes(1)
    expect(section.textContent).toContain(`${t('workspaceTerminalExited')} (7)`)
    const refresh = section.querySelector<HTMLButtonElement>(`button[title="${t('refresh')}"]`)!
    expect(refresh.getAttribute('aria-label')).toBe(t('refresh'))
    expect(refresh.querySelector('svg')).not.toBeNull()
    await act(async () => { refresh.click() })
    expect(list).toHaveBeenCalledTimes(2)
    expect(section.getAttribute('aria-busy')).toBe('true')
    expect(refresh.disabled).toBe(true)
    expect(section.querySelectorAll('[role="listitem"]')).toHaveLength(2)
    expect(section.querySelector('[role="status"]')).toBeNull()
    await act(async () => { reject(new Error('refresh failed')) })
    expect(section.querySelector('[role="alert"]')?.textContent).toBe('refresh failed')
    expect(section.querySelectorAll('[role="listitem"]')).toHaveLength(2)
    expect(refresh.disabled).toBe(false)
    root.unmount()
  })
  it('cancels inline confirmation by button or Escape and locks refresh and mutations while terminating', async () => {
    const { store } = fixture()
    let resolve!: (value: { ok: true }) => void
    const list = vi.spyOn(api, 'workspaceTerminalList').mockResolvedValue({ terminals: [info, { ...info, terminalId: 'terminal:other', title: 'other' }] })
    const terminate = vi.spyOn(api, 'workspaceTerminalTerminate').mockImplementation(() => new Promise(done => { resolve = done }))
    const root = renderRoot(createElement(WorkspaceTerminals, { sessionId: 'A', store }))
    await act(async () => {})
    const section = root.container.querySelector('section')!
    const stop = section.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    act(() => stop.click())
    const group = section.querySelector('[role="group"]')!
    const cancel = [...group.querySelectorAll('button')].find(button => button.textContent === t('cancel'))!
    expect(document.activeElement).toBe(cancel)
    act(() => cancel.click())
    expect(document.activeElement).toBe(stop)
    expect(section.querySelector('[role="group"]')).toBeNull()
    expect(terminate).not.toHaveBeenCalled()
    act(() => stop.click())
    act(() => section.querySelector('[role="group"] button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(section.querySelector('[role="group"]')).toBeNull()
    act(() => stop.click())
    act(() => section.querySelector<HTMLButtonElement>('[role="group"] button')!.click())
    expect(terminate).toHaveBeenCalledExactlyOnceWith('A', info.terminalId)
    expect(section.querySelector('[data-terminal-id="terminal:abc"]')?.getAttribute('aria-busy')).toBe('true')
    expect([...section.querySelectorAll('[role="listitem"] button, header button[data-loading]')].every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    act(() => { section.querySelector<HTMLButtonElement>('header button[data-loading]')!.click(); stop.click() })
    expect(list).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ ok: true }) })
    expect(list).toHaveBeenCalledTimes(2)
    expect(section.getAttribute('aria-busy')).toBe('false')
    root.unmount()
  })
  it('clears loaded rows when hidden and renders an accessible initial skeleton', async () => {
    const { store } = fixture()
    const list = vi.spyOn(api, 'workspaceTerminalList').mockResolvedValueOnce({ terminals: [info] }).mockImplementation(() => new Promise(() => {}))
    const root = renderRoot(createElement(WorkspaceTerminals, { sessionId: 'A', store }))
    await act(async () => {})
    expect(root.container.querySelectorAll('[role="listitem"]')).toHaveLength(1)
    root.rerender(createElement(WorkspaceTerminals, { sessionId: 'A', store, visible: false }))
    expect(root.container.textContent).not.toContain('shared')
    root.rerender(createElement(WorkspaceTerminals, { sessionId: 'A', store, visible: true }))
    expect(root.container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(t('loading'))
    expect(root.container.querySelectorAll('[role="listitem"]')).toHaveLength(0)
    expect(list).toHaveBeenCalledTimes(2)
    root.unmount()
  })
  it('keeps compact actions beside the title and provides keyboard focus and reduced motion styles', () => {
    const css = readFileSync('src/client/WorkspaceTerminals.module.css', 'utf8')
    expect(css).toContain('container-type: inline-size')
    const narrow = css.slice(css.indexOf('@container (max-width: 420px)'), css.indexOf('@media (prefers-reduced-motion'))
    expect(css).toContain('grid-template-columns: 22px minmax(0, 1fr) auto')
    expect(css).toContain('.actions { grid-column: 3; grid-row: 1; flex-wrap: nowrap; gap: 4px; }')
    expect(css).toContain('min-height: 22px; height: 22px')
    expect(narrow).not.toContain('.actions')
    expect(css).toContain('button:focus-visible')
    expect(css).toContain('outline: 2px solid var(--dsw-alias-label-primary)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('animation: none')
  })
  it('creates once and commits a delayed create to its source session', async () => {
    const { store, service } = fixture()
    let resolve!: (value: WorkspaceTerminalInfo) => void
    vi.spyOn(api, 'workspaceTerminalCreate').mockImplementation(() => new Promise(done => { resolve = done }))
    service.openTab({ type: 'terminal', target: 'bottom' })
    store.setSession('B'); resolve(info); await Promise.resolve(); await Promise.resolve()
    expect(tabs(store)).toHaveLength(0)
    store.setSession('A'); expect(workspaceTerminalIdOf(tabs(store)[0]!)).toBe(info.terminalId)
    const restored = sanitizeState(store.getSnapshot().state)!
    expect(workspaceTerminalIdOf(allLeaves(restored.bottomSplits)[0]!.tabs[0]!)).toBe(info.terminalId)
  })
  it('does not create local shells for provider-owned remote sessions', () => {
    const { store, service } = fixture()
    const create = vi.spyOn(api, 'workspaceTerminalCreate')
    const match = vi.fn((_sessionId: string, _cwd: string | undefined, _tabId: string) => true)
    service.registerTerminalProvider({ id: 'remote', match, createTransport: () => undefined })
    service.openTab({ type: 'terminal' })
    expect(match).toHaveBeenCalledWith('A', '/work', expect.stringContaining('terminal:'))
    expect(create).not.toHaveBeenCalled(); expect(tabs(store)[0]!.id).toBe(match.mock.calls[0]![2])
  })
  it('shows create errors in their source session only', async () => {
    const { store, service } = fixture()
    vi.spyOn(api, 'workspaceTerminalCreate').mockRejectedValue(new Error('quota'))
    service.openTab({ type: 'terminal' }); store.setSession('B')
    await Promise.resolve(); await Promise.resolve()
    expect(store.getSnapshot().state!.workspaceTerminalError).toBeUndefined()
    store.setSession('A'); expect(store.getSnapshot().state!.workspaceTerminalError).toBe('quota')
  })
  it('replaces only the requested view and does not resurrect old ids on refresh/open', async () => {
    const { store } = fixture()
    openWorkspaceTerminal(store, 'A', info)
    const originalId = tabs(store)[0]!.id
    store.reduce(state => ({ ...state, bottomSplits: { ...allLeaves(state.bottomSplits)[0]!, tabs: [...tabs(store), { ...tabs(store)[0]!, id: 'peer-view' }] } }))
    const fresh = { ...info, terminalId: 'terminal:fresh', title: 'fresh' }
    vi.spyOn(api, 'workspaceTerminalCreate').mockResolvedValue(fresh)
    expect(await restartWorkspaceTerminal(store, 'A', originalId, info.terminalId)).toBe(true)
    expect(tabs(store).find(tab => tab.id === originalId)!.meta).toMatchObject({ workspaceTerminalId: fresh.terminalId })
    expect(tabs(store).find(tab => tab.id === 'peer-view')!.meta).toMatchObject({ workspaceTerminalId: info.terminalId })
    openWorkspaceTerminal(store, 'A', fresh)
    expect(tabs(store)).toHaveLength(2)
  })
  it('releases a stale replacement after concurrent rebind and exposes cleanup failures', async () => {
    const { store } = fixture(); openWorkspaceTerminal(store, 'A', info)
    const originalId = tabs(store)[0]!.id
    let resolve!: (value: WorkspaceTerminalInfo) => void
    vi.spyOn(api, 'workspaceTerminalCreate').mockImplementation(() => new Promise(done => { resolve = done }))
    const terminate = vi.spyOn(api, 'workspaceTerminalTerminate').mockRejectedValue(new Error('cleanup failed'))
    const pending = restartWorkspaceTerminal(store, 'A', originalId, info.terminalId)
    store.reduce(state => ({ ...state, bottomSplits: { ...allLeaves(state.bottomSplits)[0]!, tabs: tabs(store).map(tab => ({ ...tab, meta: { workspaceTerminalId: 'terminal:other' } })) } }))
    resolve({ ...info, terminalId: 'terminal:orphan' })
    await expect(pending).rejects.toThrow('cleanup failed')
    expect(terminate).toHaveBeenCalledExactlyOnceWith('A', 'terminal:orphan')
    expect(workspaceTerminalIdOf(tabs(store)[0]!)).toBe('terminal:other')
  })
  it('dedupes shared views while preserving ordinary legacy tabs and detaches on close', () => {
    const { store, service } = fixture()
    service.openTab({ type: 'terminal', id: 'legacy' })
    openWorkspaceTerminal(store, 'A', info); openWorkspaceTerminal(store, 'A', info)
    expect(tabs(store)).toHaveLength(2)
    const terminate = vi.spyOn(api, 'workspaceTerminalTerminate')
    const view = tabs(store).find(tab => workspaceTerminalIdOf(tab) !== undefined)!
    store.reduce(state => closeTab(state, allLeaves(state.bottomSplits)[0]!.id, view.id))
    expect(terminate).not.toHaveBeenCalled(); expect(tabs(store)).toHaveLength(1)
  })
  it('commits a mounted list to its captured session, not the active store session', async () => {
    const { store } = fixture()
    openWorkspaceTerminal(store, 'A', info)
    let resolve!: (value: { terminals: WorkspaceTerminalInfo[] }) => void
    vi.spyOn(api, 'workspaceTerminalList').mockImplementation(() => new Promise(done => { resolve = done }))
    const root = renderRoot(createElement(WorkspaceTerminals, { sessionId: 'A', store }))
    act(() => { store.setSession('B') })
    await act(async () => { resolve({ terminals: [{ ...info, title: 'refreshed', exited: true }] }) })
    expect(tabs(store)).toHaveLength(0)
    const sourceTabs = allLeaves(store.getSessionStates().get('A')!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(sourceTabs[0]!.title).toBe('refreshed')
    expect(sourceTabs[0]!.meta).toMatchObject({ workspaceTerminalExited: true })
    root.unmount()
  })

  it('cancels stale list responses across session switches', async () => {
    const { store } = fixture()
    let resolve!: (value: { terminals: WorkspaceTerminalInfo[] }) => void
    const list = vi.spyOn(api, 'workspaceTerminalList').mockImplementation(() => new Promise(done => { resolve = done }))
    const root = renderRoot(createElement(WorkspaceTerminals, { sessionId: 'A', store }))
    expect(list).toHaveBeenCalledWith('A', expect.any(AbortSignal))
    const oldResolve = resolve
    const signal = list.mock.calls[0]![1]!
    store.setSession('B')
    await act(async () => { root.root.render(createElement(WorkspaceTerminals, { sessionId: 'B', store })) })
    expect(signal.aborted).toBe(true)
    await act(async () => { oldResolve({ terminals: [info] }) })
    expect(document.body.textContent).not.toContain('shared')
    expect(tabs(store)).toHaveLength(0)
    act(() => root.root.unmount()); root.container.remove()
  })
  it('loads inline on mount, opens a B-local view without closing management and cleans exited records', async () => {
    const { store, service } = fixture(); store.setSession('B')
    service.registerTab({ id: 'workspace-terminals', title: 'Manager', single: true, component: () => null })
    service.openTab({ type: 'workspace-terminals', target: 'bottom' })
    const list = vi.spyOn(api, 'workspaceTerminalList').mockResolvedValue({ terminals: [{ ...info, exited: true, exitCode: 0 }] })
    const terminate = vi.spyOn(api, 'workspaceTerminalTerminate').mockResolvedValue({ ok: true })
    const root = renderRoot(createElement(WorkspaceTerminals, { sessionId: 'B', store }))
    await act(async () => { root.root.render(createElement(WorkspaceTerminals, { sessionId: 'B', store })) })
    expect(list).toHaveBeenCalledWith('B', expect.any(AbortSignal))
    expect(root.container.querySelector('section')).not.toBeNull()
    const buttons = [...root.container.querySelectorAll('button')]
    const stop = buttons.find(button => button.textContent === t('workspaceTerminalTerminate'))!
    expect(stop.disabled).toBe(false)
    await act(async () => { stop.click() }); expect(terminate).not.toHaveBeenCalled()
    const confirmation = root.container.querySelector('[role="group"]')!
    expect(confirmation.textContent).toContain(t('workspaceTerminalTerminateConfirm'))
    await act(async () => { confirmation.querySelector<HTMLButtonElement>('button')!.click() }); expect(terminate).toHaveBeenCalledWith('B', info.terminalId)
    const open = [...root.container.querySelectorAll('button')].find(button => button.textContent === t('workspaceTerminalOpen'))!
    await act(async () => { open.click() })
    expect(workspaceTerminalIdOf(tabs(store).find(tab => tab.type === 'terminal')!)).toBe(info.terminalId)
    expect(tabs(store).some(tab => tab.type === 'workspace-terminals')).toBe(true)
    expect(root.container.textContent).toContain('shared')
    expect(store.getSessionStates().get('A')!.bottomSplits).not.toEqual(store.getSnapshot().state!.bottomSplits)
    act(() => root.root.unmount()); root.container.remove()
  })
})
