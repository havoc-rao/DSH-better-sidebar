/**
 * The file-tree data source slot (v0.17.0+): provider resolution semantics
 * (registration order, first match wins, throwing providers skipped), the
 * entry normalizer, the capability gate, the multi-root declaration
 * resolution (v0.18.0+), and the service registry surface
 * (`registerFileTreeProvider` / `getFileTreeProviders` / dispose + feature
 * flag). The React side (resolution hook + FileTree diverge) is covered by
 * file-tree-remote.spec.tsx and file-tree-multiroot.spec.tsx.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  fileTreeCapabilityOn, normalizeFileTreeEntries, referencablePathOf, resolveFileTreeRoots, resolveFileTreeSource,
  type FileTreeDataSource, type FileTreeProviderDescriptor, type FileTreeProviderRoot,
  type ResolvedFileTreeRoot, type ResolvedFileTreeSource,
} from '../src/client/file-tree-source.ts'
import { SIDEBAR_FEATURES, createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

function sourceOf(list?: (dir: string) => Promise<never>): FileTreeDataSource {
  return { list: list ?? (async () => ({ entries: [] })) }
}

const makeProvider = (overrides: Partial<FileTreeProviderDescriptor> = {}): FileTreeProviderDescriptor => ({
  id: 'remote',
  match: () => true,
  createSource: () => sourceOf(),
  ...overrides,
})

describe('resolveFileTreeSource', () => {
  it('resolves undefined with no providers (the default local host path)', () => {
    expect(resolveFileTreeSource([], 's1', '/p')).toBeUndefined()
  })

  it('first registration whose match accepts wins (provider order wins over later registrations)', () => {
    const a = makeProvider({ id: 'a', match: (sessionId, cwd) => sessionId === 's1' && cwd === '/a' })
    const b = makeProvider({ id: 'b', match: () => true })
    const resolved = resolveFileTreeSource([a, b], 's1', '/a')
    expect(resolved?.providerId).toBe('a')
    // Same list, a non-matching first provider → the second one takes over.
    const resolvedB = resolveFileTreeSource([a, b], 's2', '/b')
    expect(resolvedB?.providerId).toBe('b')
  })

  it('hands the session id and cwd verbatim to match and createSource (no local conversion)', () => {
    const match = vi.fn(() => true)
    const createSource = vi.fn(() => sourceOf())
    const resolved = resolveFileTreeSource([makeProvider({ match, createSource })], 's9', undefined)
    expect(match).toHaveBeenCalledWith('s9', undefined)
    expect(createSource).toHaveBeenCalledWith('s9', undefined)
    expect(resolved).not.toBeUndefined()
  })

  it('skips a throwing match and a throwing createSource (tree never breaks), trying the next provider', () => {
    const boom = makeProvider({ id: 'boom', match: () => { throw new Error('match failed') } })
    const boomSource = makeProvider({ id: 'boom-source', createSource: () => { throw new Error('create failed') } })
    const ok = makeProvider({ id: 'ok', match: (sessionId) => sessionId === 's1' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(resolveFileTreeSource([boom, ok], 's1', '/p')?.providerId).toBe('ok')
      expect(resolveFileTreeSource([boomSource, ok], 's1', '/p')?.providerId).toBe('ok')
      expect(resolveFileTreeSource([boom, boomSource], 's1', '/p')).toBeUndefined()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('defaults capabilities to {} and preserves a declared capability face', () => {
    expect(resolveFileTreeSource([makeProvider()], 's1', '/p')?.capabilities).toEqual({})
    const caps = { upload: true }
    expect(resolveFileTreeSource([makeProvider({ capabilities: caps })], 's1', '/p')?.capabilities).toBe(caps)
  })
})

describe('resolveFileTreeRoots (multi-root, v0.18.0+)', () => {
  const root = (id: string, dir: string, label = id): FileTreeProviderRoot => ({ id, label, dir })
  const rootsProvider = (overrides: Partial<FileTreeProviderDescriptor> = {}): FileTreeProviderDescriptor => ({
    id: 'remote',
    match: () => true,
    createSource: () => sourceOf(),
    roots: () => [root('r1', '/remote/proj')],
    ...overrides,
  })

  it('resolves [] with no providers or no roots declarations (single-root stays)', async () => {
    expect(await resolveFileTreeRoots([], 's1', '/p')).toEqual([])
    // A v0.17 provider without `roots` contributes nothing — the session
    // keeps its single-root resolution through the existing source path.
    expect(await resolveFileTreeRoots([makeProvider()], 's1', '/p')).toEqual([])
  })

  it('only matched providers with NON-empty roots contribute, merged in registration order', async () => {
    const a = rootsProvider({ id: 'a', roots: () => [root('x', '/a/x'), root('y', '/a/y')], match: sid => sid === 's1' })
    const b = rootsProvider({ id: 'b', roots: () => [root('z', '/b/z')], match: () => false })
    const c = rootsProvider({ id: 'c', roots: () => [] })
    const found = await resolveFileTreeRoots([a, b, c], 's1', '/p')
    expect(found.map(r => `${r.providerId}:${r.id}`)).toEqual(['a:x', 'a:y'])
    // A session the first provider does not accept: no contributions at all.
    expect(await resolveFileTreeRoots([a, b, c], 's2', '/p')).toEqual([])
  })

  it('same root id: the FIRST registration wins (across providers and within one list)', async () => {
    const a = rootsProvider({ id: 'a', roots: () => [root('same', '/a/same')] })
    const b = rootsProvider({ id: 'b', roots: () => [root('same', '/b/same'), root('other', '/b/other')] })
    const found = await resolveFileTreeRoots([a, b], 's1', '/p')
    expect(found.map(r => r.dir)).toEqual(['/a/same', '/b/other'])
    // Duplicate ids INSIDE one provider's list: first entry wins.
    const dup = rootsProvider({ id: 'dup', roots: () => [root('k', '/dup/one'), root('k', '/dup/two')] })
    expect((await resolveFileTreeRoots([dup], 's1', '/p')).map(r => r.dir)).toEqual(['/dup/one'])
  })

  it('resolves async roots (promise) and binds providerId / source / capabilities', async () => {
    const caps = { upload: true }
    const asyncProvider = rootsProvider({
      id: 'async',
      roots: async () => [root('r', '/async/r', 'Async Root')],
      capabilities: caps,
    })
    const found = await resolveFileTreeRoots([asyncProvider], 's1', '/p')
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe('r')
    expect(found[0]!.label).toBe('Async Root')
    expect(found[0]!.dir).toBe('/async/r')
    expect(found[0]!.providerId).toBe('async')
    expect(found[0]!.capabilities).toBe(caps)
    expect(found[0]!.source).toBeDefined()
  })

  it('hands session id and cwd verbatim to match and roots (no local conversion)', async () => {
    const match = vi.fn(() => true)
    const roots = vi.fn(() => [root('r', '/remote/x')])
    await resolveFileTreeRoots([rootsProvider({ match, roots })], 's9', undefined)
    expect(match).toHaveBeenCalledWith('s9', undefined)
    expect(roots).toHaveBeenCalledWith('s9', undefined)
  })

  it('a throwing/rejecting match, roots, or createSource skips that provider only (tree never breaks)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const badMatch = rootsProvider({ id: 'bad-match', match: () => { throw new Error('m') } })
      const badRoots = rootsProvider({ id: 'bad-roots', roots: () => { throw new Error('r') } })
      const rejectingRoots = rootsProvider({ id: 'bad-roots-async', roots: async () => { throw new Error('ra') } })
      const badSource = rootsProvider({ id: 'bad-source', createSource: () => { throw new Error('c') } })
      const ok = rootsProvider({ id: 'ok', roots: () => [root('good', '/ok/good')] })
      const found = await resolveFileTreeRoots([badMatch, badRoots, rejectingRoots, badSource, ok], 's1', '/p')
      expect(found.map(r => r.id)).toEqual(['good'])
      expect(await resolveFileTreeRoots([badRoots], 's1', '/p')).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('shape-guards malformed root entries (missing id/dir) and skips them', async () => {
    const evil = rootsProvider({
      id: 'evil',
      roots: () => [
        { id: '', dir: '/no-id', label: 'x' },
        { id: 'no-dir', dir: '', label: 'y' },
        { id: 'ok', dir: '/ok', label: 'good' },
      ],
    })
    const found = await resolveFileTreeRoots([evil], 's1', '/p')
    expect(found.map(r => r.id)).toEqual(['ok'])
  })
})

describe('normalizeFileTreeEntries', () => {
  it('fills the optional cosmetic fields with false (absent = default)', () => {
    expect(normalizeFileTreeEntries([{ name: 'a', path: '/p/a', isDir: false }])).toEqual([
      { name: 'a', path: '/p/a', isDir: false, hidden: false, isSymlink: false, broken: false },
    ])
  })

  it('preserves explicitly declared cosmetic fields and dir markers', () => {
    expect(normalizeFileTreeEntries([
      { name: 'd', path: '/p/d', isDir: true, hidden: true, isSymlink: true },
    ])).toEqual([
      { name: 'd', path: '/p/d', isDir: true, hidden: true, isSymlink: true, broken: false },
    ])
  })

  it('passes entry.meta through as-is (v0.20.0): present → present, absent → absent', () => {
    const meta = { size: 1280, mtime: 1725600000000 }
    expect(normalizeFileTreeEntries([
      { name: 'a', path: '/p/a', isDir: false, meta },
      { name: 'b', path: '/p/b', isDir: true },
    ])).toEqual([
      { name: 'a', path: '/p/a', isDir: false, hidden: false, isSymlink: false, broken: false, meta },
      { name: 'b', path: '/p/b', isDir: true, hidden: false, isSymlink: false, broken: false },
    ])
  })

  it('keeps PARTIAL meta (size only / mtime only) exact', () => {
    expect(normalizeFileTreeEntries([{ name: 's', path: '/p/s', isDir: false, meta: { size: 42 } }])[0]!.meta)
      .toEqual({ size: 42 })
    expect(normalizeFileTreeEntries([{ name: 't', path: '/p/t', isDir: false, meta: { mtime: 1 } }])[0]!.meta)
      .toEqual({ mtime: 1 })
  })
})

describe('fileTreeCapabilityOn', () => {
  it('local mode (undefined source) keeps every ability', () => {
    expect(fileTreeCapabilityOn(undefined, 'upload')).toBe(true)
    expect(fileTreeCapabilityOn(undefined, 'download')).toBe(true)
    expect(fileTreeCapabilityOn(undefined, 'git')).toBe(true)
    expect(fileTreeCapabilityOn(undefined, 'openWith')).toBe(true)
    expect(fileTreeCapabilityOn(undefined, 'search')).toBe(true)
  })

  it('provider mode defaults every ability OFF unless declared true', () => {
    const resolved = resolveFileTreeSource([makeProvider()], 's1', '/p')!
    expect(fileTreeCapabilityOn(resolved, 'upload')).toBe(false)
    expect(fileTreeCapabilityOn(resolved, 'download')).toBe(false)
    expect(fileTreeCapabilityOn(resolved, 'git')).toBe(false)
    expect(fileTreeCapabilityOn(resolved, 'openWith')).toBe(false)
    expect(fileTreeCapabilityOn(resolved, 'search')).toBe(false)
    expect(fileTreeCapabilityOn(resolved, 'open')).toBe(false)
    const rich = resolveFileTreeSource([makeProvider({ capabilities: { upload: true, search: true, open: true } })], 's1', '/p')!
    expect(fileTreeCapabilityOn(rich, 'upload')).toBe(true)
    expect(fileTreeCapabilityOn(rich, 'search')).toBe(true)
    expect(fileTreeCapabilityOn(rich, 'open')).toBe(true)
    expect(fileTreeCapabilityOn(rich, 'download')).toBe(false)
  })
})

describe('referencablePathOf (the @-reference mapping, v0.21.0)', () => {
  const refSource = (reference?: (path: string) => string): FileTreeDataSource =>
    reference === undefined ? sourceOf() : { ...sourceOf(), reference }

  const resolved = (source: FileTreeDataSource, caps = {}): ResolvedFileTreeSource =>
    ({ providerId: 'remote', source, capabilities: caps })

  const rootOf = (dir: string, source: FileTreeDataSource): ResolvedFileTreeRoot =>
    ({ id: 'r', label: dir, dir, providerId: 'remote', source, capabilities: {} })

  it('local mode (no source, no roots) keeps the row path verbatim', () => {
    expect(referencablePathOf('/w/a.ts', { cwd: '/w' })).toBe('/w/a.ts')
    expect(referencablePathOf('/w/a.ts', { cwd: '/w', singleSource: undefined, roots: [] })).toBe('/w/a.ts')
  })

  it('single-source mode maps every row through the source reference()', () => {
    const source = refSource((path) => path.replace(/^\/remote/, '/mirror'))
    const mode = { cwd: '/mirror', singleSource: resolved(source) }
    expect(referencablePathOf('/remote/src/a.ts', mode)).toBe('/mirror/src/a.ts')
  })

  it('single-source mode without a reference() keeps the row path verbatim (byte-for-byte)', () => {
    const mode = { cwd: '/mirror', singleSource: resolved(sourceOf()) }
    expect(referencablePathOf('/remote/src/a.ts', mode)).toBe('/remote/src/a.ts')
  })

  it('single-source mode: a throwing reference() degrades to the row path (pill never breaks)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const source = refSource(() => { throw new Error('boom') })
      expect(referencablePathOf('/remote/a.ts', { cwd: '/mirror', singleSource: resolved(source) })).toBe('/remote/a.ts')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('multi-root: rows under a REMOTE root map through that root\'s source', () => {
    const source = refSource((path) => path.replace(/^\/remote/, '/mirror'))
    const roots = [rootOf('/remote', source)]
    expect(referencablePathOf('/remote/src/a.ts', { cwd: '/w', roots })).toBe('/mirror/src/a.ts')
    // The root row itself maps as well (dir references).
    expect(referencablePathOf('/remote', { cwd: '/w', roots })).toBe('/mirror')
  })

  it('multi-root: the LOCAL subtree (under cwd) never maps — the local root is never taken over', () => {
    const source = refSource(() => '/hijacked')
    const roots = [rootOf('/remote', source)]
    expect(referencablePathOf('/w/a.ts', { cwd: '/w', roots })).toBe('/w/a.ts')
    // A REMOTE root whose dir string would prefix-match a local path is
    // shadowed by the cwd guard (same rule as the tree's rootAt).
    const evilRoot = rootOf('/w', source)
    expect(referencablePathOf('/w/a.ts', { cwd: '/w', roots: [evilRoot] })).toBe('/w/a.ts')
  })

  it('multi-root: rows under NO root keep the row path verbatim', () => {
    const source = refSource(() => '/mapped')
    expect(referencablePathOf('/elsewhere/b.ts', { cwd: '/w', roots: [rootOf('/remote', source)] })).toBe('/elsewhere/b.ts')
  })

  it('multi-root rows tolerate backslash separators (remote-absolute semantics)', () => {
    const source = refSource((path) => path.replace(/^D:\\remote/, 'D:\\mirror'))
    const roots = [rootOf('D:\\remote', source)]
    expect(referencablePathOf('D:\\remote\\src\\a.ts', { cwd: 'C:\\w', roots })).toBe('D:\\mirror\\src\\a.ts')
  })
})

describe('the service registry (registerFileTreeProvider)', () => {
  const setup = (): ReturnType<typeof createBetterSidebarService> => createBetterSidebarService(createSidebarStore())

  it('registers, lists in registration order, and disposes (notify fires)', () => {
    const service = setup()
    const listener = vi.fn()
    service.subscribe(listener)
    const disposeA = service.registerFileTreeProvider(makeProvider({ id: 'a' }))
    const disposeB = service.registerFileTreeProvider(makeProvider({ id: 'b' }))
    expect(service.getFileTreeProviders().map(p => p.id)).toEqual(['a', 'b'])
    expect(listener).toHaveBeenCalledTimes(2)
    disposeA()
    expect(service.getFileTreeProviders().map(p => p.id)).toEqual(['b'])
    expect(listener).toHaveBeenCalledTimes(3)
    disposeB()
    expect(service.getFileTreeProviders()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('throws on a duplicate provider id', () => {
    const service = setup()
    service.registerFileTreeProvider(makeProvider({ id: 'dup' }))
    expect(() => service.registerFileTreeProvider(makeProvider({ id: 'dup' }))).toThrow(/already registered/)
  })

  it('a stale disposer (from before a re-registration) is a no-op', () => {
    const service = setup()
    const first = makeProvider({ id: 'x' })
    const second = makeProvider({ id: 'x' })
    const disposeFirst = service.registerFileTreeProvider(first)
    disposeFirst()
    const disposeSecond = service.registerFileTreeProvider(second)
    // The stale disposer from the first registration must not remove the
    // live re-registration (the registry guards on descriptor identity).
    disposeFirst()
    expect(service.getFileTreeProviders().map(p => p.id)).toEqual(['x'])
    disposeSecond()
    expect(service.getFileTreeProviders()).toEqual([])
  })

  it('advertises the fileTreeSource feature flag', () => {
    expect(SIDEBAR_FEATURES).toContain('fileTreeSource')
    expect(setup().features).toContain('fileTreeSource')
  })
})