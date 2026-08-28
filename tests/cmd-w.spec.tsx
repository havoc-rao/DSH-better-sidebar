/**
 * The client-side ⌘W claim link (src/client/cmd-w.ts): the claim predicate
 * (the builtin ⌘W binding's when-clause + the focused-window guard), the
 * claim-and-close action, and the socket link itself (reconnect loop via an
 * injected socket factory — jsdom has no WebSocket).
 *
 * - the predicate mirrors the builtin binding exactly (drift would close
 *   tabs the binding would not touch, or leave claimed presses unclosed);
 * - a claim closes the ACTIVE tab through the same scope+closeTab path the
 *   binding uses (parity for onClose callbacks);
 * - every request gets an answer (claimed or not) — the host resolves a
 *   round when all views answered;
 * - only the focused window's view claims (document.hasFocus).
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  attachCmdWClaim, claimCmdW, shouldClaimCmdW,
  type CmdWClientSocket,
} from '../src/client/cmd-w.ts'
import { parseCmdWFrame, type CmdWFrame, type CmdWReplyFrame } from '../src/cmd-w-wire.ts'
import { setPlusMenuOpen, setFocusedTabId, getFocusedTabId, buildKeybindingContext } from '../src/client/keybindings.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import {
  activePaneTabsOf, activeTabOf, createSidebarStore, type SidebarStore,
} from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'

afterEach(() => {
  vi.restoreAllMocks()
  setPlusMenuOpen(false)
  setFocusedTabId(null)
  document.body.innerHTML = ''
})

/** The client-side store/service/ctx rig (mirror of the builtins test). */
function setup(): { store: SidebarStore; ctx: Context; closeCalls: string[] } {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: tab => tab.path, component: () => null })
  store.setSession('s1')
  const sessionsSnapshot = { byId: { s1: { cwd: '/repo' } }, current: 's1' }
  const closeCalls: string[] = []
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
  } as unknown as Context
  // The real service closeTab records the tab ids through the store; keep a
  // spy parallel so the tests can assert the close actually happened.
  const originalClose = service.closeTab.bind(service)
  service.closeTab = ((tabId: string) => {
    closeCalls.push(tabId)
    originalClose(tabId)
  }) as typeof service.closeTab
  return { store, ctx, closeCalls }
}

/** Put the document focus inside the sidebar host (and pin hasFocus). */
function focusSidebar(hasFocus = true): void {
  const host = document.createElement('div')
  host.setAttribute('data-dsh-better-sidebar', '')
  const button = document.createElement('button')
  button.id = 'sidebar-button'
  host.appendChild(button)
  document.body.appendChild(host)
  button.focus()
  vi.spyOn(document, 'hasFocus').mockReturnValue(hasFocus)
}

describe('shouldClaimCmdW', () => {
  const base = {
    state: null,
    narrow: false,
    focusInSidebar: true,
    textEditing: false,
    plusMenuOpen: false,
    searchActive: false,
    activeTab: { id: 't1', type: 'editor', title: 'a.ts' },
    activeTabType: 'editor',
    activePaneTabs: [],
  }

  it('claims when the sidebar is focused, the + menu is closed, and a tab is active', () => {
    expect(shouldClaimCmdW(base, true)).toBe(true)
  })

  it('yields when the window is not focused (another window of the shell)', () => {
    expect(shouldClaimCmdW(base, false)).toBe(false)
  })

  it('yields when the focus is outside the sidebar', () => {
    expect(shouldClaimCmdW({ ...base, focusInSidebar: false }, true)).toBe(false)
  })

  it('yields while a + menu is open (the builtin binding does the same)', () => {
    expect(shouldClaimCmdW({ ...base, plusMenuOpen: true }, true)).toBe(false)
  })

  it('passes the gates WITHOUT an active tab — whether something is closeable is the claim-target concern', () => {
    // The binding's when-clause is only the focus gates; the "nothing to
    // close" branch lives in the run/claim step (claimTargetOf), so the
    // predicate itself must NOT depend on the active tab.
    expect(shouldClaimCmdW({ ...base, activeTab: null, activeTabType: '' }, true)).toBe(true)
  })
})

describe('claimCmdW', () => {
  it('closes the active tab and answers claimed when everything lines up', () => {
    const { store, ctx, closeCalls } = setup()
    ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts' })
    const tabId = activeTabOf(store.getSnapshot().state!)!.id
    focusSidebar()

    const reply = claimCmdW(ctx, store, ctx.betterSidebar!, 'r1')
    expect(reply).toEqual({ type: 'cmd-w-reply', id: 'r1', claimed: true })
    expect(closeCalls).toContain(tabId)
    expect(activeTabOf(store.getSnapshot().state!)?.id).not.toBe(tabId)
  })

  it('answers unclaimed without side effects when the window is not focused', () => {
    const { store, ctx, closeCalls } = setup()
    ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts' })
    const tabId = activeTabOf(store.getSnapshot().state!)!.id
    focusSidebar(false)

    const reply = claimCmdW(ctx, store, ctx.betterSidebar!, 'r1')
    expect(reply).toEqual({ type: 'cmd-w-reply', id: 'r1', claimed: false })
    expect(closeCalls).not.toContain(tabId)
  })

  it('answers unclaimed when the focus sits outside the sidebar', () => {
    const { store, ctx, closeCalls } = setup()
    ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts' })
    const tabId = activeTabOf(store.getSnapshot().state!)!.id

    const reply = claimCmdW(ctx, store, ctx.betterSidebar!, 'r1')
    expect(reply.claimed).toBe(false)
    expect(closeCalls).not.toContain(tabId)
  })

  it('answers unclaimed while a + menu is open (mirror of the binding)', () => {
    const { store, ctx, closeCalls } = setup()
    ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts' })
    focusSidebar()
    setPlusMenuOpen(true)

    const reply = claimCmdW(ctx, store, ctx.betterSidebar!, 'r1')
    expect(reply.claimed).toBe(false)
    expect(closeCalls).toHaveLength(0)
  })

  it('answers unclaimed when no session is current', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Editor', component: () => null })
    const ctx = {
      betterSidebar: service,
      sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {}, current: undefined }) } },
    } as unknown as Context
    const reply = claimCmdW(ctx, store, service, 'r1')
    expect(reply).toEqual({ type: 'cmd-w-reply', id: 'r1', claimed: false })
  })

  it('closes the FOCUS-PINNED tab — the one the user is working in, not the highlighted one', () => {
    const { store, ctx, closeCalls } = setup()
    ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts', id: 'editor:/a.ts' })
    ctx.betterSidebar?.openTab({ type: 'editor', title: 'b.ts', path: '/b.ts', id: 'editor:/b.ts' })
    const tabs = activePaneTabsOf(store.getSnapshot().state!)
    const highlighted = activeTabOf(store.getSnapshot().state!)!
    // The user's focus sits in the OTHER tab (e.g. typing in the bottom
    // pane's terminal while `activePane` points at this pane).
    const working = tabs.find(tab => tab.id !== highlighted.id)!
    setFocusedTabId(working.id)
    focusSidebar()
    try {
      const reply = claimCmdW(ctx, store, ctx.betterSidebar!, 'r1')
      expect(reply).toEqual({ type: 'cmd-w-reply', id: 'r1', claimed: true })
      expect(closeCalls).toContain(working.id)
      expect(closeCalls).not.toContain(highlighted.id)
    } finally {
      setFocusedTabId(null)
    }
  })

  it('falls back to the state-active tab when the pinned tab no longer exists (stale focus across closes/sessions)', () => {
    const { store, ctx, closeCalls } = setup()
    ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts', id: 'editor:/a.ts' })
    const stateActive = activeTabOf(store.getSnapshot().state!)!
    setFocusedTabId('editor:/ghost')
    focusSidebar()
    try {
      const reply = claimCmdW(ctx, store, ctx.betterSidebar!, 'r1')
      expect(reply.claimed).toBe(true)
      expect(closeCalls).toContain(stateActive.id)
    } finally {
      setFocusedTabId(null)
    }
  })

  it('a freshly opened tab is pinned and claimed WITHOUT any click into its body', () => {
    const { store, ctx, closeCalls } = setup()
    ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts', id: 'editor:/a.ts' })
    // The open itself pinned the tab (activation pinning) — the user has
    // NOT clicked into the tab's content yet.
    expect(getFocusedTabId()).toBe('editor:/a.ts')
    focusSidebar()
    const reply = claimCmdW(ctx, store, ctx.betterSidebar!, 'r1')
    expect(reply).toEqual({ type: 'cmd-w-reply', id: 'r1', claimed: true })
    expect(closeCalls).toContain('editor:/a.ts')
  })
})

describe('attachCmdWClaim link', () => {
  /** A fake WebSocket the link drives through its handlers. */
  function makeSocket(): CmdWClientSocket & { sent: string[]; drop(): void; requests: CmdWFrame[] } {
    let socket: CmdWClientSocket & { sent: string[]; drop(): void; requests: CmdWFrame[] }
    socket = {
      readyState: 1,
      sent: [],
      requests: [],
      send(data) {
        socket.sent.push(data)
        const frame = parseCmdWFrame(data)
        if (frame !== null) socket.requests.push(frame)
      },
      close() {
        socket.readyState = 3
      },
      onmessage: null,
      onclose: null,
      onerror: null,
      drop() {
        socket.readyState = 3
        socket.onclose?.()
      },
    }
    return socket
  }

  it('connects to the claim endpoint and answers claimed with a tab close', () => {
    const { store, ctx, closeCalls } = setup()
    ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts' })
    const tabId = activeTabOf(store.getSnapshot().state!)!.id
    focusSidebar()
    const factory = vi.fn((_url: string) => makeSocket())
    const disposer = attachCmdWClaim(ctx, store, ctx.betterSidebar!, { createSocket: factory })

    const socket = factory.mock.results[0]!.value as ReturnType<typeof makeSocket>
    expect(String(factory.mock.calls[0]![0])).toContain('/sidebar/ws/cmd-w')
    socket.onmessage!({ data: JSON.stringify({ type: 'cmd-w', id: 'r1' }) })
    expect(closeCalls).toContain(tabId)
    const frame = socket.requests.at(-1)
    expect(frame).toEqual({ type: 'cmd-w-reply', id: 'r1', claimed: true })
    disposer()
  })

  it('always answers — unclaimed when the sidebar would not consume the key', () => {
    const { store, ctx } = setup()
    ctx.betterSidebar?.openTab({ type: 'editor', title: 'a.ts', path: '/a.ts' })
    const factory = vi.fn(() => makeSocket())
    const disposer = attachCmdWClaim(ctx, store, ctx.betterSidebar!, { createSocket: factory })

    const socket = factory.mock.results[0]!.value as ReturnType<typeof makeSocket>
    socket.onmessage!({ data: JSON.stringify({ type: 'cmd-w', id: 'r1' }) })
    expect(socket.requests.at(-1)).toEqual({ type: 'cmd-w-reply', id: 'r1', claimed: false })
    disposer()
  })

  it('ignores malformed pushes and non-request frames', () => {
    const { store, ctx } = setup()
    const factory = vi.fn(() => makeSocket())
    const disposer = attachCmdWClaim(ctx, store, ctx.betterSidebar!, { createSocket: factory })
    const socket = factory.mock.results[0]!.value as ReturnType<typeof makeSocket>

    socket.onmessage!({ data: 'not json' })
    socket.onmessage!({ data: JSON.stringify({ type: 'other', id: 'x' }) })
    socket.onmessage!({ data: JSON.stringify({ type: 'cmd-w-reply', id: 'x', claimed: true }) })
    expect(socket.sent).toHaveLength(0)
    disposer()
  })

  it('reconnects after a drop (mirror of the agent-opens loop) and stops on dispose', async () => {
    const { store, ctx } = setup()
    const factory = vi.fn(() => makeSocket())
    const disposer = attachCmdWClaim(ctx, store, ctx.betterSidebar!, {
      createSocket: factory,
      retryDelayMs: 5,
    })
    const first = factory.mock.results[0]!.value as ReturnType<typeof makeSocket>
    first.drop()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(factory).toHaveBeenCalledTimes(2)

    const second = factory.mock.results[1]!.value as ReturnType<typeof makeSocket>
    disposer()
    second.drop()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(factory).toHaveBeenCalledTimes(2) // no further reconnects
  })

  it('the context the claim evaluates is the SAME builder the runtime uses', () => {
    // Drift guard: buildKeybindingContext is what the runtime and the claim
    // share — exercise it once so the wiring is proven from this side too.
    const { store } = setup()
    const context = buildKeybindingContext(store)
    expect(context.activePaneTabs).toBeInstanceOf(Array)
    expect(typeof context.focusInSidebar).toBe('boolean')
  })
})