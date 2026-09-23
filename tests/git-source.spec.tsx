/**
 * The git data source slot (feature 'gitSource', v0.23.0+): provider
 * resolution semantics (registration order, first match wins, `undefined`
 * factory = per-session refusal), no-match degradation (the local host
 * routes), plus the shape contract — a GitDataSource shadows the host
 * `api.git*` method set exactly (compile-time: `api` itself is assignable
 * to GitDataSource; runtime: every contract method present on a resolved
 * source).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  resolveGitSource,
  type GitDataSource,
  type GitOkResult,
  type GitProviderDescriptor,
} from '../src/client/git-source.ts'
import { api, type GitStatusResult } from '../src/client/api.ts'

/** A canned source: method presence + identity is all the resolver deals in. */
const makeSource = (): GitDataSource => ({
  gitStatus: async (): Promise<GitStatusResult> => ({ isRepo: false, entries: [] }),
  gitWorktrees: async () => [],
  gitBranch: async () => ({ current: '', names: [] }),
  gitLog: async () => [],
  gitDiff: async () => ({ diff: '' }),
  gitStage: async (): Promise<GitOkResult> => ({ ok: true }),
  gitUnstage: async (): Promise<GitOkResult> => ({ ok: true }),
  gitCommit: async (): Promise<GitOkResult> => ({ ok: true }),
  gitCheckout: async (): Promise<GitOkResult> => ({ ok: true }),
  gitDiscard: async (): Promise<GitOkResult> => ({ ok: true }),
  gitRevert: async (): Promise<GitOkResult> => ({ ok: true }),
  gitCherryPick: async (): Promise<GitOkResult> => ({ ok: true }),
})

const makeProvider = (overrides: Partial<GitProviderDescriptor> = {}): GitProviderDescriptor => ({
  id: 'remote',
  match: () => true,
  createSource: () => makeSource(),
  ...overrides,
})

/** The contract method set, as the Git lens' `gitApi.git*` call surface. */
const CONTRACT_METHODS = [
  'gitStatus',
  'gitWorktrees',
  'gitBranch',
  'gitLog',
  'gitDiff',
  'gitStage',
  'gitUnstage',
  'gitCommit',
  'gitCheckout',
  'gitDiscard',
  'gitRevert',
  'gitCherryPick',
] as const

// Compile-time shape contract: the host `api` object itself is assignable
// to GitDataSource — every method the contract names exists on the host
// route surface with a compatible signature. If api.ts drifts, typecheck
// fails here, exactly where consumers would feel it.
const _hostShadowsContract: GitDataSource = api

describe('GitDataSource shape', () => {
  it('exposes the full contract method set', () => {
    const source = makeSource()
    for (const method of CONTRACT_METHODS) {
      expect(typeof source[method]).toBe('function')
    }
  })

  it('GitOkResult is the {ok:true} mutation result shape', () => {
    const ok: GitOkResult = { ok: true }
    expect(ok.ok).toBe(true)
  })
})

describe('resolveGitSource', () => {
  it('resolves undefined with no providers (the local host routes stay)', () => {
    expect(resolveGitSource([], 's1', '/p')).toBeUndefined()
  })

  it('first-match: the first provider whose match accepts wins', () => {
    const a = makeProvider({ id: 'a', match: (sessionId, cwd) => sessionId === 's1' && cwd === '/p' })
    const b = makeProvider({ id: 'b', match: () => true })
    expect(resolveGitSource([a, b], 's1', '/p')).toBeDefined()
    // A non-matching first provider → the second takes over.
    expect(resolveGitSource([a, b], 's2', '/q')).toBeDefined()
  })

  it('a matched provider whose createSource returns undefined REFUSES — the next provider gets its turn', () => {
    const refusing = makeProvider({ id: 'refuse', createSource: () => undefined })
    const ok = makeProvider({ id: 'ok', match: (sessionId) => sessionId === 's1' })
    expect(resolveGitSource([refusing, ok], 's1', '/p')).toBeDefined()
    // A session nobody accepts: no source → the local routes stay.
    expect(resolveGitSource([refusing, ok], 's2', '/p')).toBeUndefined()
  })

  it('skips a throwing match and a throwing createSource, trying the next provider', () => {
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

  it('hands session id and cwd verbatim to match and createSource', () => {
    const match = vi.fn(() => true)
    const createSource = vi.fn(() => makeSource())
    resolveGitSource([makeProvider({ match, createSource })], 's9', undefined)
    expect(match).toHaveBeenCalledWith('s9', undefined)
    expect(createSource).toHaveBeenCalledWith('s9', undefined)
  })
})