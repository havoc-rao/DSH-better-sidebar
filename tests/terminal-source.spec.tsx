/**
 * The terminal data source slot (feature 'terminalSource', v0.22.0+):
 * provider resolution semantics (registration order, first match wins,
 * throwing providers skipped, `undefined` factory = refusal), the service
 * registry surface (`registerTerminalProvider` / `getTerminalProviders` /
 * dispose + feature flag), and the DESCRIPTOR-LEVEL integration — the
 * built-in terminal tab resolves its connection layer through the
 * registry and frames it as the `transport` prop TerminalView already
 * knows (absent → undefined, the default localTransport path). The React
 * side of the resolution (the live registry subscription) is exercised
 * through the wrapper + a chunk recorder.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  resolveTerminalSource,
  type TerminalProviderDescriptor,
} from '../src/client/terminal-source.ts'
import { SIDEBAR_FEATURES, createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { builtinTabs } from '../src/client/builtins/tabs.tsx'
import { registerChunkForTests, resetChunks } from '../src/client/chunk-loader.ts'
import type { TerminalTransport } from '../src/client/terminal-transport.ts'
import type { Context } from '../src/context-types.ts'

/** A canned transport: the kind+identity is all the resolver deals in. */
const remoteTransport = (kind = 'remote-ssh-pty'): TerminalTransport => ({
  kind,
  open: () => {
    throw new Error('open is not exercised in this spec')
  },
})

const makeProvider = (overrides: Partial<TerminalProviderDescriptor> = {}): TerminalProviderDescriptor => ({
  id: 'remote',
  match: () => true,
  createTransport: () => remoteTransport(),
  ...overrides,
})

describe('resolveTerminalSource', () => {
  it('resolves undefined with no providers (the default localTransport path)', () => {
    expect(resolveTerminalSource([], 's1', '/p', 'terminal:1')).toBeUndefined()
  })

  it('first registration whose match accepts wins (provider order wins over later registrations)', () => {
    const a = makeProvider({ id: 'a', match: (sessionId, cwd, tabId) => sessionId === 's1' && cwd === '/p' && tabId === 'terminal:1' })
    const b = makeProvider({ id: 'b', match: () => true })
    const resolved = resolveTerminalSource([a, b], 's1', '/p', 'terminal:1')
    expect(resolved?.kind).toBe('remote-ssh-pty')
    // Same list, a non-matching first provider → the second takes over.
    expect(resolveTerminalSource([a, b], 's2', '/q', 'terminal:9')).toBeDefined()
    expect(resolveTerminalSource([a, b], 's2', '/q', 'terminal:9')!.kind).toBe('remote-ssh-pty')
  })

  it('hands the session id, cwd and tab id verbatim to match and createTransport (no local conversion)', () => {
    const match = vi.fn(() => true)
    const createTransport = vi.fn(() => remoteTransport('custom'))
    const resolved = resolveTerminalSource([makeProvider({ match, createTransport })], 's9', undefined, 'agent:abc')
    expect(match).toHaveBeenCalledWith('s9', undefined, 'agent:abc')
    expect(createTransport).toHaveBeenCalledWith('s9', undefined, 'agent:abc')
    expect(resolved?.kind).toBe('custom')
  })

  it('skips a throwing match and a throwing createTransport (the terminal never breaks), trying the next provider', () => {
    const boom = makeProvider({ id: 'boom', match: () => { throw new Error('match failed') } })
    const boomSource = makeProvider({ id: 'boom-source', createTransport: () => { throw new Error('create failed') } })
    const ok = makeProvider({ id: 'ok', match: (sessionId) => sessionId === 's1' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(resolveTerminalSource([boom, ok], 's1', '/p', 'terminal:1')?.kind).toBe('remote-ssh-pty')
      expect(resolveTerminalSource([boomSource, ok], 's1', '/p', 'terminal:1')?.kind).toBe('remote-ssh-pty')
      expect(resolveTerminalSource([boom, boomSource], 's1', '/p', 'terminal:1')).toBeUndefined()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('a matched provider whose createTransport returns undefined REFUSES — the next provider gets its turn', () => {
    const refusing = makeProvider({ id: 'refuse', createTransport: () => undefined })
    const ok = makeProvider({ id: 'ok', match: (sessionId) => sessionId === 's1' })
    // The refuser matches but refuses: the next provider still wins.
    expect(resolveTerminalSource([refusing, ok], 's1', '/p', 'terminal:1')?.kind).toBe('remote-ssh-pty')
    // A session the second provider does not accept: nobody wins → default local.
    expect(resolveTerminalSource([refusing, ok], 's2', '/p', 'terminal:1')).toBeUndefined()
  })

  it('an agent tab is just another tab: providers decide by tabId prefix', () => {
    const uiOnly = makeProvider({ id: 'ui', match: (_s, _c, tabId) => !tabId.startsWith('agent:') })
    const all = makeProvider({ id: 'all', match: () => true })
    expect(resolveTerminalSource([uiOnly], 's1', '/p', 'terminal:1')).toBeDefined()
    expect(resolveTerminalSource([uiOnly], 's1', '/p', 'agent:abc')).toBeUndefined()
    expect(resolveTerminalSource([uiOnly, all], 's1', '/p', 'agent:abc')).toBeDefined()
  })
})

describe('the service registry (registerTerminalProvider)', () => {
  const setup = (): ReturnType<typeof createBetterSidebarService> => createBetterSidebarService(createSidebarStore())

  it('registers, lists in registration order, and disposes (notify fires)', () => {
    const service = setup()
    const listener = vi.fn()
    service.subscribe(listener)
    const disposeA = service.registerTerminalProvider(makeProvider({ id: 'a' }))
    const disposeB = service.registerTerminalProvider(makeProvider({ id: 'b' }))
    expect(service.getTerminalProviders().map(p => p.id)).toEqual(['a', 'b'])
    expect(listener).toHaveBeenCalledTimes(2)
    disposeA()
    expect(service.getTerminalProviders().map(p => p.id)).toEqual(['b'])
    expect(listener).toHaveBeenCalledTimes(3)
    disposeB()
    expect(service.getTerminalProviders()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('throws on a duplicate provider id', () => {
    const service = setup()
    service.registerTerminalProvider(makeProvider({ id: 'dup' }))
    expect(() => service.registerTerminalProvider(makeProvider({ id: 'dup' }))).toThrow(/already registered/)
  })

  it('a stale disposer (from before a re-registration) is a no-op', () => {
    const service = setup()
    const first = makeProvider({ id: 'x' })
    const second = makeProvider({ id: 'x' })
    const disposeFirst = service.registerTerminalProvider(first)
    disposeFirst()
    const disposeSecond = service.registerTerminalProvider(second)
    // The stale disposer from the first registration must not remove the
    // live re-registration (the registry guards on descriptor identity).
    disposeFirst()
    expect(service.getTerminalProviders().map(p => p.id)).toEqual(['x'])
    disposeSecond()
    expect(service.getTerminalProviders()).toEqual([])
  })

  it('advertises the terminalSource feature flag', () => {
    expect(SIDEBAR_FEATURES).toContain('terminalSource')
    expect(setup().features).toContain('terminalSource')
  })
})

/** Render `node` into a detached body container under React's act(). */
function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  const unmount = (): void => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { container, unmount }
}

describe('the built-in terminal tab resolves through the registry (descriptor-level integration)', () => {
  let captured: TerminalViewPropsCapture | null = null
  interface TerminalViewPropsCapture { transport?: TerminalTransport }

  const Recorder: ComponentType<TerminalViewPropsCapture> = (props) => {
    captured = props
    return createElement('div', { 'data-testid': 'terminal-recorder' })
  }

  beforeEach(() => {
    resetChunks()
    captured = null
    registerChunkForTests('terminal', async () => ({ TerminalView: Recorder }))
  })

  afterEach(() => {
    for (const el of document.querySelectorAll('body > div')) el.remove()
  })

  const setupProps = (): {
    container: HTMLDivElement
    unmount: () => void
    ctx: Context
  } => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const ctx = { betterSidebar: service } as unknown as Context
    const terminal = builtinTabs(ctx).find(tab => tab.id === 'terminal')!
    const { container, unmount } = mount(createElement(terminal.component, {
      ctx,
      store,
      scope: { sessionId: 's1', cwd: '/p' },
      tab: { id: 'terminal:abc', type: 'terminal', title: 'bash' },
      visible: true,
    }))
    return { container, unmount, ctx }
  }

  it('no matching provider → no transport prop (the default localTransport path, byte for byte)', async () => {
    const { container, unmount } = setupProps()
    await act(async () => {})
    expect(container.querySelector('[data-testid="terminal-recorder"]')).not.toBeNull()
    expect(captured?.transport).toBeUndefined()
    unmount()
  })

  it("a matching provider's transport flows into the terminal tab as the transport prop", async () => {
    const { container, unmount, ctx } = setupProps()
    ctx.betterSidebar!.registerTerminalProvider(makeProvider({
      id: 'dsh-remote',
      match: (sessionId, cwd, tabId) => sessionId === 's1' && cwd === '/p' && tabId === 'terminal:abc',
      createTransport: () => remoteTransport('remote-ssh-pty'),
    }))
    await act(async () => {})
    expect(container.querySelector('[data-testid="terminal-recorder"]')).not.toBeNull()
    expect(captured?.transport?.kind).toBe('remote-ssh-pty')
    unmount()
  })

  it('a provider that does not match this tab is skipped (registry consulted in order, refusal falls through)', async () => {
    const { container, unmount, ctx } = setupProps()
    ctx.betterSidebar!.registerTerminalProvider(makeProvider({
      id: 'other-session',
      match: (sessionId) => sessionId === 's-other',
    }))
    ctx.betterSidebar!.registerTerminalProvider(makeProvider({
      id: 'this-session',
      match: (sessionId) => sessionId === 's1',
      createTransport: () => remoteTransport('session-owned'),
    }))
    await act(async () => {})
    expect(container.querySelector('[data-testid="terminal-recorder"]')).not.toBeNull()
    expect(captured?.transport?.kind).toBe('session-owned')
    unmount()
  })

  it('a provider registering AFTER the tab opened is seen by a later mount (registry subscription re-resolves)', async () => {
    const { unmount, ctx } = setupProps()
    await act(async () => {})
    // The first mount had no provider: no transport.
    expect(captured?.transport).toBeUndefined()
    // A provider registers while the tab stays mounted; the wrapper's
    // registry subscription re-renders and re-resolves — a view mounted
    // NOW (new tab / remount) would receive the provider transport.
    act(() => {
      ctx.betterSidebar!.registerTerminalProvider(makeProvider({
        id: 'late',
        match: () => true,
        createTransport: () => remoteTransport('late-registered'),
      }))
    })
    expect(captured?.transport?.kind).toBe('late-registered')
    unmount()
  })
})