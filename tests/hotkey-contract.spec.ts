// @vitest-environment jsdom
/**
 * The dsh-hotkey contract (v0.20.x adaptation):
 *
 * 1. `getSnapshot()` carries the flat `sessionId` / `bottomOpen` / `panelOpen`
 *    fields dsh-hotkey reads at keypress time (`panelOpen` from the probe the
 *    client half installs — `ctx.sidebarRight.isExpanded()` or the kernel's
 *    `[data-sidebar-right-open]` marker; `undefined` when unknown).
 * 2. A "right" open falls back to the plugin's bottom workbench while the
 *    native controller (`ctx.sidebarRight`) is ABSENT — a popup / session
 *    window on a runtime that has not mounted ui-sidebar-right — instead of
 *    sitting in the pending queue forever.
 * 3. With the controller present, opens go native exactly as before, and the
 *    cross-session queue keeps working.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createBetterSidebarService, type SidebarServiceSnapshot } from '../src/client/service.ts'
import { createNativeSurface } from '../src/client/native/surface.ts'
import { createSidebarStore, allLeaves } from '../src/client/state.ts'
import { Sidebar } from '../src/client/Sidebar.tsx'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

/** A minimal ctx: `sidebarRight` is whatever the caller hands over. */
function makeCtx(controller: unknown): {
  get: (name: string) => unknown
  sessions: { list: { subscribe: (cb: () => void) => () => void; getSnapshot: () => { current: string; byId: Record<string, { sessionId: string; cwd: string }> } } }
} {
  return {
    get: (name: string) => (name === 'sidebarRight' ? controller : undefined),
    sessions: {
      list: {
        subscribe: () => () => {},
        getSnapshot: () => ({ current: 's1', byId: { s1: { sessionId: 's1', cwd: '/work' } } }),
      },
    },
  }
}

/** A service bound to a store on session s1, with the editor type registered. */
function mount(probe?: () => boolean | undefined): {
  store: ReturnType<typeof createSidebarStore>
  service: ReturnType<typeof createBetterSidebarService>
} {
  const store = createSidebarStore()
  store.setSession('s1')
  const service = createBetterSidebarService(store, probe)
  service.registerTab({ id: 'editor', title: 'Files', component: () => null })
  return { store, service }
}

describe('getSnapshot() flat panel flags (dsh-hotkey contract)', () => {
  it('reports sessionId, bottomOpen (from state) and panelOpen (from the probe)', () => {
    const { store, service } = mount(() => true)
    store.reduce(s => ({ ...s, bottomOpen: true }))
    const snap = service.getSnapshot() as SidebarServiceSnapshot
    expect(snap.sessionId).toBe('s1')
    expect(snap.bottomOpen).toBe(true)
    expect(snap.panelOpen).toBe(true)
    // The store snapshot's own fields ride along unchanged.
    expect(snap.state?.bottomOpen).toBe(true)
    expect(snap.prefs).toBeDefined()
  })

  it('bottomOpen is false while the workbench is closed; panelOpen follow the probe', () => {
    const { store, service } = mount(() => false)
    expect(service.getSnapshot().bottomOpen).toBe(false)
    expect(service.getSnapshot().panelOpen).toBe(false)
    store.reduce(s => ({ ...s, bottomOpen: true }))
    expect(service.getSnapshot().bottomOpen).toBe(true)
  })

  it('panelOpen is undefined without a probe and when the probe throws', () => {
    const noProbe = mount()
    expect(noProbe.service.getSnapshot().panelOpen).toBeUndefined()
    const broken = mount(() => { throw new Error('boom') })
    expect(broken.service.getSnapshot().panelOpen).toBeUndefined()
    expect(broken.service.getSnapshot().bottomOpen).toBe(false)
  })

  it('sessionId is undefined before any session becomes active', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    expect(service.getSnapshot().sessionId).toBeUndefined()
    expect(service.getSnapshot().bottomOpen).toBe(false)
  })
})

describe('openTab with a live native controller (unchanged native routing)', () => {
  it('routes a path-less editor open to the files kind and never touches the workbench', () => {
    const controller: { openTab: ReturnType<typeof vi.fn>; openResource: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; openTabIn?: ReturnType<typeof vi.fn> } = { openTab: vi.fn(), openResource: vi.fn(), close: vi.fn() }
    const surface = createNativeSurface(makeCtx(controller) as never, { get: () => undefined } as never)
    const { store, service } = mount()
    service.setSurface(surface)
    service.openTab({ type: 'editor' }, { sessionId: 's1' })
    expect(controller.openTab).toHaveBeenCalledWith('files', { params: {}, revealIfOpened: true })
    const tabs = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(l => l.tabs)
    expect(tabs).toHaveLength(0)
    expect(store.getSnapshot().state?.bottomOpen).toBe(false)
  })

  it('canPlace is true while the controller exists', () => {
    const surface = createNativeSurface(makeCtx({ openTab: vi.fn() }) as never, { get: () => undefined } as never)
    expect(surface.canPlace?.('s1')).toBe(true)
  })
})

describe('openTab without a native controller (popup-window fallback)', () => {
  it('canPlace is false without the controller', () => {
    const surface = createNativeSurface(makeCtx(undefined) as never, { get: () => undefined } as never)
    expect(surface.canPlace?.('s1')).toBe(false)
  })

  it('a right open lands in the bottom workbench instead of the dead queue', () => {
    const controller: { openTab: ReturnType<typeof vi.fn> } = { openTab: vi.fn() }
    const holder: { current: unknown } = { current: undefined }
    const ctx = makeCtx(holder.current)
    ctx.get = (name: string) => (name === 'sidebarRight' ? holder.current : undefined)
    const surface = createNativeSurface(ctx as never, { get: () => undefined } as never)
    const { store, service } = mount()
    service.setSurface(surface)
    service.openTab({ type: 'editor' }, { sessionId: 's1' })
    // The files window is in the workbench, and the workbench is open.
    const tabs = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(l => l.tabs)
    expect(tabs).toEqual([expect.objectContaining({ type: 'editor' })])
    expect(tabs[0]?.path).toBeUndefined()
    expect(store.getSnapshot().state?.bottomOpen).toBe(true)
    // Nothing was queued: once the kernel controller appears, flushing the
    // pending queue must place nothing new.
    holder.current = controller
    surface.flushPending()
    expect(controller.openTab).not.toHaveBeenCalled()
  })

  it('a cross-session right open with no controller lands in THAT session\'s workbench', () => {
    const holder: { current: unknown } = { current: undefined }
    const ctx = makeCtx(holder.current)
    ctx.get = (name: string) => (name === 'sidebarRight' ? holder.current : undefined)
    const surface = createNativeSurface(ctx as never, { get: () => undefined } as never)
    const { store, service } = mount()
    service.setSurface(surface)
    service.openTab({ type: 'editor' }, { sessionId: 's2' })
    // The UI's active session must NOT switch…
    expect(store.getSnapshot().sessionId).toBe('s1')
    // …and s2's own workbench carries the open.
    const s2 = store.getSessionStates().get('s2')
    expect(s2?.bottomOpen).toBe(true)
    const tabs = s2 === undefined ? [] : allLeaves(s2.bottomSplits).flatMap(l => l.tabs)
    expect(tabs).toEqual([expect.objectContaining({ type: 'editor' })])
    expect(tabs[0]?.path).toBeUndefined()
  })
})

describe('cross-session queueing is preserved when the controller EXISTS', () => {
  it('queues an open for a session with no mounted surface, then flushes it', () => {
    const controller: { openTab: ReturnType<typeof vi.fn>; openResource: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; openTabIn?: ReturnType<typeof vi.fn> } = { openTab: vi.fn(), openResource: vi.fn(), close: vi.fn() }
    const surface = createNativeSurface(makeCtx(controller) as never, { get: () => undefined } as never)
    const { service } = mount()
    service.setSurface(surface)
    // s2 is not the active session and the controller has no openTabIn yet.
    service.openTab({ type: 'editor' }, { sessionId: 's2' })
    expect(controller.openTab).not.toHaveBeenCalled()
    // The controller gains the per-session write face — the flush replays.
    controller.openTabIn = vi.fn()
    surface.flushPending()
    expect(controller.openTabIn).toHaveBeenCalledWith('s2', 'files', { params: {}, revealIfOpened: true })
  })
})
// ─── DOM contract (the real Sidebar shell) ───────────────────────────────

/** jsdom has no WebSocket; the agent-terminals push effect constructs one on mount. */
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

let sessionSeq = 0

function renderSidebar(): {
  container: HTMLDivElement
  store: ReturnType<typeof createSidebarStore>
  service: ReturnType<typeof createBetterSidebarService>
  unmount: () => void
} {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const sessionId = `hk-s1-${++sessionSeq}`
  store.setSession(sessionId)
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = { current: sessionId, byId: { [sessionId]: { cwd: '/tmp' } } }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  }
  const root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx: ctx as never, store })) })
  return {
    container,
    store,
    service,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

describe('DOM contract (real sidebar shell)', () => {
  it('exposes the toggle cluster with the bottom-close and sidebar-toggle buttons', () => {
    const { container, unmount } = renderSidebar()
    try {
      const cluster = container.querySelector('[data-dsh-panel-host] [data-dsh-toggle-cluster]')
      expect(cluster, 'the strip-end toggle cluster must exist').not.toBeNull()
      expect(cluster!.querySelector('button[aria-label="Collapse bottom panel"]'), 'the close control rides the cluster').not.toBeNull()
      const sidebarToggle = cluster!.querySelector<HTMLButtonElement>('[data-dsh-sidebar-toggle]')
      expect(sidebarToggle, 'the sidebar toggle rides the cluster').not.toBeNull()
      // No kernel right Sidebar in this jsdom world → the fallback label.
      expect(sidebarToggle!.getAttribute('aria-label')).toBe('Expand sidebar')
      expect(sidebarToggle!.getAttribute('aria-pressed')).toBe('false')
    } finally {
      unmount()
    }
  })

  it('the sidebar toggle opens the files window in the workbench, then collapses it', () => {
    const { container, service, store, unmount } = renderSidebar()
    try {
      service.registerTab({ id: 'editor', title: 'Files', component: () => null })
      const sidebarToggle = container.querySelector<HTMLButtonElement>('[data-dsh-sidebar-toggle]')!
      act(() => { sidebarToggle.click() })
      // Files window open + workbench expanded (the no-kernel fallback pair).
      const state = store.getSnapshot().state!
      const tabs = allLeaves(state.bottomSplits).flatMap(l => l.tabs)
      expect(tabs).toEqual([expect.objectContaining({ type: 'editor' })])
      expect(state.bottomOpen).toBe(true)
      expect(sidebarToggle.getAttribute('aria-label')).toBe('Collapse sidebar')
      expect(sidebarToggle.getAttribute('aria-pressed')).toBe('true')
      // A second press collapses the workbench (toggle semantics).
      act(() => { sidebarToggle.click() })
      expect(store.getSnapshot().state?.bottomOpen).toBe(false)
    } finally {
      unmount()
    }
  })
})
