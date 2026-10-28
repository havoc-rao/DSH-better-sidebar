/**
 * Installer integration contract: real SidebarStore preference writes publish
 * subscribeState, NOT service registry notifications. Enabling Files/Git must
 * reconcile desired membership without requiring an unrelated inventory pulse.
 * Only injection/effect ownership and the public native controller are mocked.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { installWorkspaceToolTabs, type WorkspaceMembership, type WorkspaceTabsController } from '../src/client/workspace-tool-tabs.ts'

class Source<T> {
  readonly listeners = new Set<() => void>()
  constructor(private value: T) {}
  getSnapshot = (): T => this.value
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(value: T): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
}

type Row = { sessionId: string; tabId: string; kind: string; contentId: string }
const row = (sessionId: string, kind: string): Row => ({
  sessionId, tabId: `${sessionId}-${kind}`, kind, contentId: `dsh-resource://page/${kind}`,
})
const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  localStorage.clear()
  vi.restoreAllMocks()
})
const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

function fixture() {
  localStorage.clear()
  const sidebarStore = createSidebarStore()
  sidebarStore.setPrefs({ ...sidebarStore.getPrefs(), tabsEnabled: { editor: false, git: false } })
  const service = createBetterSidebarService(sidebarStore)
  disposers.push(() => service.dispose())
  const mounted = new Source<string | undefined>('s1')
  const openTabs = new Source<readonly Row[]>([row('s2', 'files'), row('s2', 'git')])
  const workspaces = new Source<WorkspaceMembership>({
    phase: 'ready', state: 'idle',
    items: [{ workspaceId: 'w1', path: '/workspace', sessionIds: ['s1', 's2'] }],
  })
  const controller: WorkspaceTabsController = {
    mounted, openTabs,
    tabsIn: sid => openTabs.getSnapshot().filter(item => item.sessionId === sid)
      .map(item => ({ id: item.tabId, kind: item.kind })),
    commandTarget: () => ({}),
    openTab: vi.fn(kind => { openTabs.set([...openTabs.getSnapshot(), row(mounted.getSnapshot()!, kind)]) }),
    close: vi.fn(tabId => { openTabs.set(openTabs.getSnapshot().filter(item => item.tabId !== tabId)) }),
    active: () => undefined,
    focus: vi.fn(),
    isExpanded: () => true,
    toggleExpanded: vi.fn(),
  }
  const effectDisposers: (() => void)[] = []
  const scope = {
    get: (name: string) => name === 'sidebarRight' ? controller : name === 'workspaces' ? { list: workspaces } : undefined,
    effect: vi.fn((effect: () => () => void) => { effectDisposers.push(effect()) }),
  }
  const inject = vi.fn((_names: string[], callback: (value: typeof scope) => void) => { callback(scope) })
  const ctx = { inject } as unknown as Context
  const dispose = () => { for (const stop of effectDisposers.splice(0).reverse()) stop() }
  disposers.push(dispose)
  const registryListener = vi.fn()
  disposers.push(service.subscribe(registryListener))
  const subscribeState = vi.spyOn(service, 'subscribeState')
  installWorkspaceToolTabs(ctx, service)
  const enable = (id: 'editor' | 'git') => {
    const prefs = sidebarStore.getPrefs()
    sidebarStore.setPrefs({ ...prefs, tabsEnabled: { ...prefs.tabsEnabled, [id]: true } })
  }
  const kinds = () => controller.tabsIn('s1').map(item => item.kind)
  return { sidebarStore, service, controller, mounted, openTabs, workspaces, inject, scope,
    registryListener, subscribeState, enable, kinds, dispose }
}

describe('installWorkspaceToolTabs', () => {
  it('restores Files and Git from real preference updates without any registry notification', async () => {
    const f = fixture()
    await flush()
    expect(f.inject).toHaveBeenCalledWith(['sidebarRight', 'workspaces'], expect.any(Function))
    expect(f.scope.effect).toHaveBeenCalledTimes(1)
    expect(f.subscribeState).toHaveBeenCalledTimes(1)
    expect(f.kinds()).toEqual([])
    expect(f.controller.openTab).not.toHaveBeenCalled()

    // Files is controlled by the editor preference, not a files preference.
    f.enable('editor')
    expect(f.registryListener).not.toHaveBeenCalled()
    await flush()
    expect(f.kinds()).toEqual(['files'])
    expect(f.controller.openTab).toHaveBeenCalledExactlyOnceWith('files')

    f.enable('git')
    expect(f.registryListener).not.toHaveBeenCalled()
    await flush()
    expect(f.kinds()).toEqual(['files', 'git'])
    expect(f.controller.openTab).toHaveBeenCalledTimes(2)

    // Unchanged prefs can notify the real store, but must not reopen duplicates.
    f.sidebarStore.setPrefs(f.sidebarStore.getPrefs())
    await flush()
    expect(f.controller.openTab).toHaveBeenCalledTimes(2)
    expect(f.registryListener).not.toHaveBeenCalled()
  })

  it('effect cleanup releases state, inventory, workspace and external-storage subscriptions', async () => {
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    const f = fixture()
    await flush()
    expect(f.openTabs.listeners.size).toBe(1)
    expect(f.workspaces.listeners.size).toBe(1)
    expect(f.mounted.listeners.size).toBe(1)
    f.dispose()
    expect(f.openTabs.listeners.size).toBe(0)
    expect(f.workspaces.listeners.size).toBe(0)
    expect(f.mounted.listeners.size).toBe(0)
    expect(removeEventListener).toHaveBeenCalledWith('storage', expect.any(Function))
    f.enable('editor')
    f.enable('git')
    window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage }))
    await flush()
    expect(f.controller.openTab).not.toHaveBeenCalled()
    expect(f.registryListener).not.toHaveBeenCalled()
  })
})
