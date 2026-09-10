/**
 * The git data source slot (feature 'gitSource', v0.23.0+): provider
 * resolution semantics (registration order, first match wins, throwing
 * providers skipped, `undefined` factory = refusal), the service registry
 * surface (`registerGitProvider` / `getGitProviders` / dispose + feature
 * flag), the `api`-structural compatibility that makes the host routes a
 * drop-in default, and the render-side hook's live registry resolution.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { api, type GitStatusResult } from '../src/client/api.ts'
import {
  resolveGitSource,
  useGitSource,
  type GitDataSource,
  type GitProviderDescriptor,
} from '../src/client/git-source.ts'
import { SIDEBAR_FEATURES, createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'

/** A canned remote source: the real methods are exercised by the surface
 *  specs; the resolver only deals in identity. */
const remoteSource = (): GitDataSource => ({
  gitStatus: () => Promise.resolve({ isRepo: true, root: '/r', entries: [] } as GitStatusResult),
  gitWorktrees: () => Promise.resolve([]),
  gitBranch: () => Promise.resolve({ current: 'main', names: [] }),
  gitBranchStatus: () => Promise.resolve({ upstream: undefined, ahead: 0, behind: 0, gone: false }),
  gitBranchTips: () => Promise.resolve({ tips: [] }),
  gitLogGraph: () => Promise.resolve([]),
  gitDiff: () => Promise.resolve({ diff: '' }),
  gitCommitDiff: () => Promise.resolve({ diff: '' }),
  gitStage: () => Promise.resolve({ ok: true }),
  gitUnstage: () => Promise.resolve({ ok: true }),
  gitCommit: () => Promise.resolve({ ok: true }),
  gitCheckout: () => Promise.resolve({ ok: true }),
  gitFetch: () => Promise.resolve({ ok: true }),
  gitDiscard: () => Promise.resolve({ ok: true }),
  gitRevert: () => Promise.resolve({ ok: true }),
  gitCherryPick: () => Promise.resolve({ ok: true }),
})

const makeProvider = (overrides: Partial<GitProviderDescriptor> = {}): GitProviderDescriptor => ({
  id: 'remote',
  match: () => true,
  createSource: () => remoteSource(),
  ...overrides,
})

describe('resolveGitSource', () => {
  it('resolves undefined with no providers (the default local host route path)', () => {
    expect(resolveGitSource([], 's1', '/p')).toBeUndefined()
  })

  it('first registration whose match accepts wins (provider order beats later registrations)', () => {
    const a = makeProvider({ id: 'a', match: (sessionId, cwd) => sessionId === 's1' && cwd === '/p' })
    const b = makeProvider({ id: 'b', match: () => true })
    expect(resolveGitSource([a, b], 's1', '/p')).toBeDefined()
    // Same list, a non-matching first provider → the second takes over.
    expect(resolveGitSource([a, b], 's2', '/q')).toBeDefined()
  })

  it('hands the session id and cwd verbatim to match and createSource (no local conversion)', () => {
    const match = vi.fn(() => true)
    const createSource = vi.fn(() => remoteSource())
    const resolved = resolveGitSource([makeProvider({ match, createSource })], 's9', undefined)
    expect(match).toHaveBeenCalledWith('s9', undefined)
    expect(createSource).toHaveBeenCalledWith('s9', undefined)
    expect(resolved).toBeDefined()
  })

  it('skips a throwing match and a throwing createSource (the surface never breaks), trying the next provider', () => {
    const boom = makeProvider({ id: 'boom', match: () => { throw new Error('match failed') } })
    const boomSource = makeProvider({ id: 'boom-source', createSource: () => { throw new Error('create failed') } })
    const ok = makeProvider({ id: 'ok', match: (sessionId) => sessionId === 's1' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(resolveGitSource([boom, ok], 's1', '/p')).toBeDefined()
      expect(resolveGitSource([boomSource, ok], 's1', '/p')).toBeDefined()
      expect(resolveGitSource([boom, boomSource], 's1', '/p')).toBeUndefined()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('a matched provider whose createSource returns undefined REFUSES — the next provider gets its turn', () => {
    const refusing = makeProvider({ id: 'refuse', createSource: () => undefined })
    const ok = makeProvider({ id: 'ok', match: (sessionId) => sessionId === 's1' })
    expect(resolveGitSource([refusing, ok], 's1', '/p')).toBeDefined()
    // A session the second provider does not accept: nobody wins → host routes.
    expect(resolveGitSource([refusing, ok], 's2', '/p')).toBeUndefined()
  })
})

describe('api is structurally a GitDataSource (the drop-in default)', () => {
  it('assigns the whole api object to the contract (compile-time + runtime)', () => {
    const asSource: GitDataSource = api
    expect(typeof asSource.gitStatus).toBe('function')
    expect(typeof asSource.gitLogGraph).toBe('function')
    expect(typeof asSource.gitCherryPick).toBe('function')
    expect(asSource.gitStatus).toBe(api.gitStatus)
  })
})

describe('the service registry (registerGitProvider)', () => {
  const setup = (): ReturnType<typeof createBetterSidebarService> => createBetterSidebarService(createSidebarStore())

  it('registers, lists in registration order, and disposes (notify fires)', () => {
    const service = setup()
    const listener = vi.fn()
    service.subscribe(listener)
    const disposeA = service.registerGitProvider(makeProvider({ id: 'a' }))
    const disposeB = service.registerGitProvider(makeProvider({ id: 'b' }))
    expect(service.getGitProviders().map(p => p.id)).toEqual(['a', 'b'])
    expect(listener).toHaveBeenCalledTimes(2)
    disposeA()
    expect(service.getGitProviders().map(p => p.id)).toEqual(['b'])
    expect(listener).toHaveBeenCalledTimes(3)
    disposeB()
    expect(service.getGitProviders()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('throws on a duplicate provider id', () => {
    const service = setup()
    service.registerGitProvider(makeProvider({ id: 'dup' }))
    expect(() => service.registerGitProvider(makeProvider({ id: 'dup' }))).toThrow(/already registered/)
  })

  it('a stale disposer (from before a re-registration) is a no-op', () => {
    const service = setup()
    const disposeFirst = service.registerGitProvider(makeProvider({ id: 'x' }))
    disposeFirst()
    const disposeSecond = service.registerGitProvider(makeProvider({ id: 'x' }))
    // The stale disposer from the first registration must not remove the
    // live re-registration (the registry guards on descriptor identity).
    disposeFirst()
    expect(service.getGitProviders().map(p => p.id)).toEqual(['x'])
    disposeSecond()
    expect(service.getGitProviders()).toEqual([])
  })

  it('advertises the gitSource feature flag', () => {
    expect(SIDEBAR_FEATURES).toContain('gitSource')
    expect(setup().features).toContain('gitSource')
  })
})

/** A recorder component exposing the hook's resolution to the tests. */
interface CaptureResult { source: GitDataSource | undefined }
let captured: CaptureResult = { source: undefined }
const Recorder: ComponentType<{ ctx?: Context; sessionId: string; cwd?: string }> = (props) => {
  captured = { source: useGitSource(props.ctx, props.sessionId, props.cwd) }
  return createElement('div', { 'data-testid': 'git-source-recorder' })
}

describe('useGitSource (render-side registry resolution)', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    captured = { source: undefined }
  })

  const mountWith = (ctx: Context | undefined, sessionId = 's1', cwd = '/p'): void => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root.render(createElement(Recorder, { ctx, sessionId, cwd }))
    })
  }

  it('resolves undefined without a context (host routes, byte for byte)', () => {
    mountWith(undefined)
    expect(captured.source).toBeUndefined()
    mountWith({} as Context)
    expect(captured.source).toBeUndefined()
  })

  it('resolves undefined when no provider matches (host routes)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerGitProvider(makeProvider({ id: 'other', match: (sessionId) => sessionId === 's-other' }))
    mountWith({ betterSidebar: service } as unknown as Context)
    expect(captured.source).toBeUndefined()
  })

  it('returns the first matching provider source, and re-resolves LIVE when a provider registers later', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const ctx = { betterSidebar: service } as unknown as Context
    mountWith(ctx)
    // First mount: no provider → host routes.
    expect(captured.source).toBeUndefined()
    // A provider registers while the surface stays mounted: the hook's
    // registry subscription re-renders and resolves it immediately.
    let dispose: (() => void) | undefined
    act(() => {
      dispose = service.registerGitProvider(makeProvider({
        id: 'late',
        match: (sessionId, cwd) => sessionId === 's1' && cwd === '/p',
        createSource: () => remoteSource(),
      }))
    })
    expect(captured.source).toBeDefined()
    // Disposing the provider reverts to the host route path.
    act(() => { dispose!() })
    expect(captured.source).toBeUndefined()
  })

  it('a throwing registry read degrades to undefined (registry-less stubs never break the surface)', () => {
    const stub = { betterSidebar: { subscribe: () => () => {}, getGitProviders: () => { throw new Error('stub') } } }
    mountWith(stub as unknown as Context)
    expect(captured.source).toBeUndefined()
  })
})