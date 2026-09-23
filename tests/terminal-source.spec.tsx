/**
 * The terminal data source slot (feature 'terminalSource', v0.22.0+):
 * provider resolution semantics (registration order, first match wins,
 * throwing providers skipped, `undefined` factory = refusal), the service
 * registry surface (`registerTerminalProvider` / `getTerminalProviders` /
 * dispose + feature flag), and the render-side hook's safe degradation
 * (registry-less service stubs / scope-less mounts never break the
 * terminal).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import {
  resolveTerminalSource,
  useTerminalTransport,
  type TerminalProviderDescriptor,
} from '../src/client/terminal-source.ts'
import { SIDEBAR_FEATURES, createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { TerminalTransport } from '../src/client/terminal-transport.ts'
import type { Context } from '../src/context-types.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

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
  it('resolves undefined with no providers (the default local path)', () => {
    expect(resolveTerminalSource([], 's1', '/p', 'terminal:1')).toBeUndefined()
  })

  it('first-match: the first registration whose match accepts wins', () => {
    const a = makeProvider({ id: 'a', match: (sessionId, cwd, tabId) => sessionId === 's1' && cwd === '/p' && tabId === 'terminal:1' })
    const b = makeProvider({ id: 'b', match: () => true })
    // Provider order wins over later registrations.
    expect(resolveTerminalSource([a, b], 's1', '/p', 'terminal:1')?.kind).toBe('remote-ssh-pty')
    // A non-matching first provider → the second takes over.
    expect(resolveTerminalSource([a, b], 's2', '/q', 'terminal:9')?.kind).toBe('remote-ssh-pty')
  })

  it('skips a throwing match and a throwing createTransport, trying the next provider', () => {
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
    expect(resolveTerminalSource([refusing, ok], 's1', '/p', 'terminal:1')?.kind).toBe('remote-ssh-pty')
    // A session the second provider does not accept: nobody wins → default local.
    expect(resolveTerminalSource([refusing, ok], 's2', '/p', 'terminal:1')).toBeUndefined()
  })

  it('hands session id, cwd and tab id verbatim to match and createTransport', () => {
    const match = vi.fn(() => true)
    const createTransport = vi.fn(() => remoteTransport('custom'))
    const resolved = resolveTerminalSource([makeProvider({ match, createTransport })], 's9', undefined, 'agent:abc')
    expect(match).toHaveBeenCalledWith('s9', undefined, 'agent:abc')
    expect(createTransport).toHaveBeenCalledWith('s9', undefined, 'agent:abc')
    expect(resolved?.kind).toBe('custom')
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

describe('useTerminalTransport degradation', () => {
  let captured: TerminalTransport | undefined = undefined
  function Harness(props: { ctx: Context | undefined; sessionId: string | undefined; cwd: string | undefined; tabId: string }) {
    captured = useTerminalTransport(props.ctx, props.sessionId, props.cwd, props.tabId)
    return createElement('div')
  }
  const mount = (props: Parameters<typeof Harness>[0]): { unmount: () => void } => {
    const root = renderRoot(createElement(Harness, props))
    return { unmount: root.unmount }
  }

  afterEach(() => { captured = undefined })

  it('a registry-less service stub degrades to undefined (the local path)', () => {
    const { unmount } = mount({ ctx: { betterSidebar: {} } as unknown as Context, sessionId: 's1', cwd: '/p', tabId: 'terminal:1' })
    act(() => {})
    expect(captured).toBeUndefined()
    unmount()
  })

  it('a scope-less mount (no sessionId) resolves undefined even with a live registry', () => {
    const service = createBetterSidebarService(createSidebarStore())
    service.registerTerminalProvider(makeProvider({ id: 'remote', match: () => true }))
    const { unmount } = mount({ ctx: { betterSidebar: service } as unknown as Context, sessionId: undefined, cwd: '/p', tabId: 'terminal:1' })
    act(() => {})
    expect(captured).toBeUndefined()
    unmount()
  })
})