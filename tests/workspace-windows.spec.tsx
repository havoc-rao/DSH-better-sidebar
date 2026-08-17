/**
 * Workspace-bound windows UI tests: the pinned tab strip (partition behind
 * a divider, pin glyph, not draggable), and the right-click bind/unbind
 * menu flow end to end through the real Sidebar shell — bind from a content
 * tab, the stub appearing in every session of the workspace, unbind back
 * into a local tab, and the disabled state for sessions outside any
 * workspace.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

import { Sidebar } from '../src/client/Sidebar.tsx'
import { allLeaves, createSidebarStore, firstLeaf, isBoundTabId, openTabInActivePane, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { createWorkspaceWindowsStore, type WorkspaceWindowsStore } from '../src/client/workspace-windows.ts'
import type { Context } from '../src/context-types.ts'
import { t } from '../src/client/locales.ts'

/** jsdom has no WebSocket; the agent-terminals push effect constructs one on mount. */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

interface MountedSidebar {
  container: HTMLDivElement
  store: SidebarStore
  service: BetterSidebarService
  windows: WorkspaceWindowsStore
  unmount: () => void
}

/** Mount the real Sidebar shell with a wired workspace windows store. */
function mountSidebar(): MountedSidebar {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // useSyncExternalStore requires STABLE snapshots across calls (the real
  // DSH services return stable objects) — fresh objects per call loop
  // forever (the repo's established jsdom pattern, see
  // bottom-auto-terminal.spec.tsx).
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = {
    current: 's1',
    byId: { s1: { cwd: '/ws-a' }, s2: { cwd: '/ws-a' }, orphan: { cwd: '/elsewhere' } },
  }
  const workspacesSnapshot = {
    items: [
      { workspaceId: '11111111-aaaa-0000-0000-000000000001', path: '/ws-a', title: 'Workspace A', sessionIds: ['s1', 's2'], createdAt: '', updatedAt: '' },
    ],
  }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    workspaces: {
      openPath: async () => {},
      list: { subscribe: () => () => {}, getSnapshot: () => workspacesSnapshot },
    },
    betterSidebar: service,
  } as unknown as Context
  const windows = createWorkspaceWindowsStore(ctx)
  windows.attachSidebarStore(store)
  // Fresh-session seed before the first render (same as the other shell tests).
  store.setSession('s1')
  const serviceWithWindows = createBetterSidebarService(store, windows)
  serviceWithWindows.registerTab({
    id: 'editor',
    title: () => 'Editor',
    component: () => createElement('div', null, 'editor-content'),
  })
  serviceWithWindows.registerTab({
    id: 'terminal',
    title: () => 'Terminal',
    component: () => createElement('div', null, 'terminal-stub-content'),
  })
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx, store, windows })) })
  return {
    container,
    store,
    service: serviceWithWindows,
    windows,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** The tab element whose title attribute matches (the strip's tooltip). */
function tabEl(container: HTMLElement, title: string): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>('[title]')].find(el => el.getAttribute('title') === title) ?? null
}

/** Right-click a tab element and return the menu item element with `label`. */
function openTabMenu(container: HTMLElement, title: string, label: string): HTMLElement {
  const el = tabEl(container, title)
  expect(el, `tab "${title}"`).not.toBeNull()
  act(() => {
    el!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 80 }))
  })
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(node => node.textContent?.trim() === label)
  expect(item, `menu item "${label}"`).not.toBeNull()
  return item!
}

describe('workspace-bound windows UI', () => {
  it('bind via the tab context menu pins the window in every session of the workspace', () => {
    const { container, store, service, unmount } = mountSidebar()
    // Open a file window in session s1 (the + menu path would do the same).
    act(() => { service.openFile({ sessionId: 's1', cwd: '/ws-a' }, '/ws-a/src/a.ts') })

    const bindItem = openTabMenu(container, 'a.ts', t('bindToWorkspaceWithName', { title: 'Workspace A' }))
    act(() => { bindItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // The window moved into the workspace store; the stub renders pinned.
    const bound = store.getSnapshot().state ? firstLeaf(store.getSnapshot().state!.splits).tabs.find(t => isBoundTabId(t.id)) : undefined
    expect(bound).toBeDefined()
    expect(store.getSnapshot().state!.splits !== undefined).toBe(true)
    const stubs = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).filter(t => isBoundTabId(t.id))
    expect(stubs).toHaveLength(1)
    // The pinned tab keeps its title and shows the pin glyph.
    expect(tabEl(container, 'a.ts')).not.toBeNull()
    expect(container.querySelector('[class*="tabPin"]')).not.toBeNull()

    // Every session of the workspace sees the window (s2 was not loaded).
    act(() => { store.setSession('s2') })
    const s2Stubs = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).filter(t => isBoundTabId(t.id))
    expect(s2Stubs.map(t => t.id)).toEqual([stubs[0]!.id])

    unmount()
  })

  it('a bound stub is not draggable and its close button unbinds everywhere', () => {
    const { container, store, service, unmount } = mountSidebar()
    act(() => { service.openFile({ sessionId: 's1', cwd: '/ws-a' }, '/ws-a/src/a.ts') })
    act(() => { service.openFile({ sessionId: 's1', cwd: '/ws-a' }, '/ws-a/src/b.ts', 'b.ts') })

    // Bind the FIRST file (a.ts, currently active).
    const bindItem = openTabMenu(container, 'a.ts', t('bindToWorkspaceWithName', { title: 'Workspace A' }))
    act(() => { bindItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // The pinned tab element is marked non-draggable.
    const pinned = tabEl(container, 'a.ts')!
    expect(pinned.getAttribute('draggable')).toBe('false')

    // Its close button is the second button inside the tab (the ✕) — the
    // close routes to unbind(false): gone from the store AND the tree.
    const close = pinned.querySelector('button')
    expect(close).not.toBeNull()
    act(() => { close!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(store.getSnapshot().state!.splits !== undefined).toBe(true)
    const stubs = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).filter(t => isBoundTabId(t.id))
    expect(stubs).toHaveLength(0)
    // b.ts (a plain local tab) survived.
    expect(tabEl(container, 'b.ts')).not.toBeNull()

    unmount()
  })

  it('unbind via the context menu keeps the window here as a local tab', () => {
    const { container, store, service, unmount } = mountSidebar()
    act(() => { service.openFile({ sessionId: 's1', cwd: '/ws-a' }, '/ws-a/src/a.ts') })
    const bindItem = openTabMenu(container, 'a.ts', t('bindToWorkspaceWithName', { title: 'Workspace A' }))
    act(() => { bindItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // Right-click the STUB (its title resolves from the store) → unbind.
    const unbindItem = openTabMenu(container, 'a.ts', t('unbindFromWorkspace'))
    act(() => { unbindItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // The window left the workspace store; a local tab materialized here.
    expect(container.querySelector('[class*="tabPin"]')).toBeNull()
    const local = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs).find(t => t.path === '/ws-a/src/a.ts')
    expect(local).toBeDefined()
    expect(isBoundTabId(local!.id)).toBe(false)
    // And it is the active tab again (the stub slot keeps the focus).
    expect(firstLeaf(store.getSnapshot().state!.splits).active).toBe(local!.id)

    unmount()
  })

  it('the bind menu is disabled for a session outside any workspace', () => {
    const { container, store, service, unmount } = mountSidebar()
    act(() => { store.setSession('orphan') })
    act(() => { service.openFile({ sessionId: 'orphan', cwd: '/elsewhere' }, '/elsewhere/x.ts', 'x.ts') })

    const item = openTabMenu(container, 'x.ts', t('bindToWorkspaceNoWorkspace'))
    // The native button is disabled (ui-primitives renders disabled rows).
    expect((item as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('[class*="tabPin"]')).toBeNull()

    unmount()
  })

  it('terminal tabs can be bound too (path-less windows share the window)', () => {
    const { container, store, windows, unmount } = mountSidebar()
    // Open a local terminal (directly into the tree — the + menu flow
    // would go through the descriptor's createTab).
    act(() => {
      store.reduce(s => openTabInActivePane(s, { id: 'terminal:1', type: 'terminal', title: 'Terminal' }))
    })

    const bindItem = openTabMenu(container, 'Terminal', t('bindToWorkspaceWithName', { title: 'Workspace A' }))
    act(() => { bindItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(windows.getSnapshot().windows).toHaveLength(1)
    expect(windows.getSnapshot().windows[0]!.type).toBe('terminal')
    // The local terminal left the tree; the stub (pinned, same title) is there.
    const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(l => l.tabs)
    expect(tabs.some(t => t.id === 'terminal:1')).toBe(false)
    const stub = tabs.find(t => isBoundTabId(t.id))
    expect(stub).toBeDefined()
    expect(tabEl(container, 'Terminal')).not.toBeNull()
    expect(container.querySelector('[class*="tabPin"]')).not.toBeNull()

    unmount()
  })

  it('agent-owned terminals never offer the bind menu (model-managed)', () => {
    const { container, store, unmount } = mountSidebar()
    act(() => {
      store.reduce(s => openTabInActivePane(s, { id: 'agent:some-uuid', type: 'terminal', title: 'agent shell' }))
    })

    const el = tabEl(container, 'agent shell')
    expect(el).not.toBeNull()
    act(() => {
      el!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 80 }))
    })
    expect(document.body.querySelectorAll('[role="menuitem"]')).toHaveLength(0)

    unmount()
  })
})
