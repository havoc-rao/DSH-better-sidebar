/**
 * Bottom-panel first-expand auto-terminal tests — the TRIGGER CHAIN behind
 * issue #42 (bottom panel first expand + auto terminal → whole panel blank).
 *
 * #42's crash itself was the zero-size xterm open (the same root cause as
 * #25, fixed by openWhenSized — see tests/open-when-sized.spec.ts), and the
 * "whole panel blank" amplification is covered by the per-tab containment
 * tests (tests/sidebar-crash.spec.tsx). What this spec pins is the trigger:
 * the Sidebar effect that opens a terminal tab the FIRST time the bottom
 * panel expands (`bottomOpenedOnce`), its pref / enable-switch gates, and
 * the once-per-session semantics.
 *
 * The effect was removed with the 0.1.6 terminal yield (the deck that handed
 * terminal and browser to DSH's own right-Sidebar kinds) and is being
 * restored together with the terminal tab that came back into the plugin's
 * bottom workbench — the `bottomPanelAutoTerminal` pref and its settings
 * toggle had stayed on the ledger as a dead switch in between. These tests
 * render the REAL Sidebar shell against a minimal fake context (the repo's
 * jsdom pattern) and drive the bottom panel through the store, asserting the
 * tab lands in the bottom workbench, renders, and the panel itself survives.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import { allLeaves, createSidebarStore, toggleBottomPanel, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { t } from '../src/client/locales.ts'
import { api } from '../src/client/api.ts'

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
  unmount: () => void
}

/** Unique per-test session ids (see the comment inside). */
let sessionSeq = 0

/** Mount the real Sidebar shell against a minimal context (real store + service). */
function mountSidebar(): MountedSidebar {
  vi.spyOn(api, 'workspaceTerminalCreate').mockImplementation(async (source) => ({
    terminalId: `terminal:${crypto.randomUUID()}`, title: 'Terminal', cwd: '/tmp',
    createdBySessionId: source, createdAt: Date.now(), exited: false,
  }))
  vi.spyOn(api, 'workspaceTerminalList').mockResolvedValue({ terminals: [] })
  // The server owns atomic acquisition; this test harness models its result.
  vi.spyOn(api, 'workspaceTerminalEnsure').mockImplementation(async sessionId => {
    const { terminals } = await api.workspaceTerminalList(sessionId)
    return terminals.find(terminal => !terminal.exited) ?? api.workspaceTerminalCreate(sessionId)
  })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  // The jobs baseline poll (use-host-feeds) must never hit a real network.
  vi.stubGlobal('fetch', async () => { throw new Error('network stub') })
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // Fresh-session seed: the bottom panel starts closed (bottomOpen false →
  // the first expansion is a false→true TRANSITION). Unique session per
  // test — the store persists per-session state to localStorage (200ms
  // debounce); a shared id lets a previous test's late write leak into this
  // store's setSession restore.
  const sessionId = `auto-terminal-${++sessionSeq}`
  store.setSession(sessionId)
  // useSyncExternalStore requires STABLE snapshots across calls (the real DSH
  // services return stable objects) — a fresh object per call loops forever.
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = {
    current: sessionId,
    // cwd present → api.sessionCwd is never called in these tests.
    byId: { [sessionId]: { cwd: '/tmp' } },
  }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  }
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx: ctx as never, store })) })
  return {
    container,
    store,
    service,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  // Belt and braces: drop any persisted layout a pending 200ms debounce
  // write left behind between tests (unique session ids already isolate).
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Every tab currently living in the bottom workbench. */
function bottomTabs(store: SidebarStore): Array<{ id: string; type: string; title: string }> {
  const state = store.getSnapshot().state
  if (state === undefined) return []
  return allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)
}

/**
 * The stub terminal tab: counts renders so the test can see it actually
 * mount. Mirrors the REAL terminal descriptor's `createTab` (mints a fresh
 * unique id per open — the id safety-net's same-id focus therefore never
 * collapses two opens into one, exactly like production): a duplicate
 * openTab call in the auto-open effect would mint a SECOND tab and fail the
 * `toEqual(['terminal'])` assertions below.
 */
function registerStubTerminal(service: BetterSidebarService, renders: { count: number }): void {
  let minted = 0
  service.registerTab({
    id: 'terminal',
    title: () => 'Terminal',
    createTab: () => ({
      tab: {
        id: `terminal:${++minted}`,
        type: 'terminal',
        title: 'Terminal',
      },
      patch: { nextTerminal: minted + 1 },
    }),
    component: () => {
      renders.count += 1
      return createElement('div', null, 'terminal-stub-content')
    },
  })
}

describe('bottom-panel first-expand auto terminal (issue #42 trigger chain)', () => {
  it('auto-opens exactly one terminal tab in the bottom workbench on the FIRST expansion', async () => {
    const { container, store, service } = mountSidebar()

    const renders = { count: 0 }
    registerStubTerminal(service, renders)

    await act(async () => { store.reduce(toggleBottomPanel) })

    const state = store.getSnapshot().state!
    expect(state.bottomOpen).toBe(true)
    // The once-flag is set atomically with the first fire.
    expect(state.bottomOpenedOnce).toBe(true)
    // The terminal tab landed in the BOTTOM workbench (the effect pins the
    // active pane to the bottom tree's first leaf before opening).
    expect(bottomTabs(store).map(tab => tab.type)).toEqual(['terminal'])
    // The tab actually mounted and rendered — the chain is live end to end.
    expect(renders.count).toBeGreaterThanOrEqual(1)
    expect(container.textContent).toContain('terminal-stub-content')
    // The panel itself survived (the #42 symptom was a WHOLE blank panel):
    // the close control is present and the layout push for the bottom panel
    // height is live.
    expect(container.querySelector(`[aria-label="${t('collapseBottomPanel')}"]`)).not.toBeNull()
    expect(document.documentElement.style.getPropertyValue('--dsh-sidebar-height')).toBe(
      `${state.bottomHeight}px`,
    )
  })

  it('does not create another terminal when a closed panel already has one in another pane', async () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })
    act(() => { store.reduce(state => ({ ...state, bottomSplits: {
      kind: 'split', id: 'existing-split', dir: 'row', sizes: [0.5, 0.5],
      children: [state.bottomSplits, {
        kind: 'leaf', id: 'existing-terminal-pane', active: 'agent:existing',
        tabs: [{ id: 'agent:existing', type: 'terminal', title: 'Existing terminal' }],
      }],
    } })) })

    await act(async () => { store.reduce(toggleBottomPanel) })
    expect(bottomTabs(store).map(tab => tab.id)).toEqual(['agent:existing'])
    expect(api.workspaceTerminalCreate).not.toHaveBeenCalled()
    expect(store.getSnapshot().state!.bottomOpenedOnce).toBe(true)
    await act(async () => { store.reduce(toggleBottomPanel) })
    await act(async () => { store.reduce(toggleBottomPanel) })
    expect(api.workspaceTerminalCreate).not.toHaveBeenCalled()
  })

  it('does not auto-create a second terminal when an explicit async terminal open expands the panel', async () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })

    await act(async () => { service.openTab({ type: 'terminal', target: 'bottom' }) })

    expect(api.workspaceTerminalCreate).toHaveBeenCalledTimes(1)
    expect(bottomTabs(store)).toHaveLength(1)
    expect(store.getSnapshot().state!.bottomOpen).toBe(true)
    expect(store.getSnapshot().state!.bottomOpenedOnce).toBe(true)
  })

  it('reuses the same terminal on later expansions without creating or restarting a shell', async () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })

    await act(async () => { store.reduce(toggleBottomPanel) })
    expect(bottomTabs(store)).toHaveLength(1)

    const terminalId = bottomTabs(store)[0]!.id
    // Collapse → expand again: the existing view and shell are reused.
    act(() => { store.reduce(toggleBottomPanel) })
    expect(store.getSnapshot().state!.bottomOpen).toBe(false)
    act(() => { store.reduce(toggleBottomPanel) })
    expect(store.getSnapshot().state!.bottomOpenedOnce).toBe(true)
    expect(bottomTabs(store).map(tab => tab.id)).toEqual([terminalId])
    expect(api.workspaceTerminalCreate).toHaveBeenCalledTimes(1)
    expect(api.workspaceTerminalList).toHaveBeenCalledTimes(2)
  })

  it('does not auto-open when the bottomPanelAutoTerminal pref is off', () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })
    // setPrefs REPLACES the prefs record — spread the current one so only
    // the toggle moves.
    act(() => { store.setPrefs({ ...store.getPrefs(), bottomPanelAutoTerminal: false }) })

    act(() => { store.reduce(toggleBottomPanel) })
    expect(store.getSnapshot().state!.bottomOpen).toBe(true)
    // The gate returns BEFORE the open — the pref switch is never taken
    // back once flipped on again in the same session.
    expect(store.getSnapshot().state!.bottomOpenedOnce).toBe(false)
    expect(bottomTabs(store)).toHaveLength(0)
  })

  it('does not auto-open when the terminal tab type is disabled in settings', () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })
    act(() => { store.setPrefs({ ...store.getPrefs(), tabsEnabled: { terminal: false } }) })

    act(() => { store.reduce(toggleBottomPanel) })
    expect(store.getSnapshot().state!.bottomOpen).toBe(true)
    expect(store.getSnapshot().state!.bottomOpenedOnce).toBe(false)
    expect(bottomTabs(store)).toHaveLength(0)
  })

  it('reattaches a live workspace terminal with no tab instead of starting another shell', async () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })
    vi.mocked(api.workspaceTerminalList).mockResolvedValue({ terminals: [{
      terminalId: 'existing-shell', title: 'Keep my shell', cwd: '/tmp',
      createdBySessionId: 'another-session', createdAt: 1, exited: false,
    }] })
    await act(async () => { store.reduce(toggleBottomPanel) })
    expect(bottomTabs(store).map(tab => tab.id)).toEqual(['workspace-view:existing-shell'])
    expect(api.workspaceTerminalCreate).not.toHaveBeenCalled()
    // Closing a view must not forget the workspace-owned process.
    act(() => { store.reduce(state => ({ ...state, bottomOpen: false,
      bottomSplits: { kind: 'leaf', id: 'empty', active: null, tabs: [] },
    })) })
    await act(async () => { store.reduce(toggleBottomPanel) })
    expect(bottomTabs(store).map(tab => tab.id)).toEqual(['workspace-view:existing-shell'])
    expect(api.workspaceTerminalCreate).not.toHaveBeenCalled()
  })

  it('shares pending lookup across rapid collapse and expand, creating exactly one shell', async () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })
    let resolve!: (value: { terminals: [] }) => void
    vi.mocked(api.workspaceTerminalList).mockReturnValue(new Promise(done => { resolve = done }))
    await act(async () => { store.reduce(toggleBottomPanel) })
    await act(async () => { store.reduce(toggleBottomPanel) })
    await act(async () => { store.reduce(toggleBottomPanel) })
    expect(api.workspaceTerminalList).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ terminals: [] }) })
    expect(api.workspaceTerminalCreate).toHaveBeenCalledTimes(1)
    expect(bottomTabs(store)).toHaveLength(1)
  })

  it('a full workspace terminal quota surfaces the error and allows retry on a later expansion', async () => {
    const { store, service } = mountSidebar()
    registerStubTerminal(service, { count: 0 })
    const create = vi.mocked(api.workspaceTerminalCreate).mockRejectedValue(new Error('terminal limit reached'))
    await act(async () => { store.reduce(toggleBottomPanel) })
    expect(bottomTabs(store)).toHaveLength(0)
    expect(store.getSnapshot().state!.workspaceTerminalError).toBe('terminal limit reached')
    expect(store.getSnapshot().state!.bottomOpenedOnce).toBe(true)
    // With no shell available, a later expansion retries instead of staying empty forever.
    await act(async () => { store.reduce(toggleBottomPanel) })
    await act(async () => { store.reduce(toggleBottomPanel) })
    expect(create).toHaveBeenCalledTimes(2)
    expect(bottomTabs(store)).toHaveLength(0)
  })
})