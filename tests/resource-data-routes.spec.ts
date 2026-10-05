import { afterEach, describe, expect, it, vi } from 'vitest'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { RESOURCE_PATCH_BYTE_LIMIT, resourceDiffMetadata } from '../src/resource-data-routes.ts'
import type { ResourceStrictDiff } from '../src/resource-data-routes.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

const roots: string[] = []
const cleanups: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-resource-route-')))
  roots.push(root)
  return root
}
function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@dsh.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@dsh.invalid' } })
  if (result.status !== 0) throw new Error(result.stderr)
}
function mount(cwd: string, readLimit = 1024 * 1024, sessionPresent = true) {
  const routes: SidebarWebRoute[] = []
  apply({
    webRuntime: { trustedHosts: [] },
    webServer: { register: (route: SidebarWebRoute) => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
    sessions: { get: () => sessionPresent ? ({ header: { cwd }, snapshotEvents: () => [] }) : undefined },
    tools: { register: () => () => {} },
    effect: (fn: () => unknown) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup as () => void) },
    inject: () => () => {}, on: () => () => {}, get: () => undefined,
  } as never, { readLimit })
  const route = routes.find(route => route.path === '/sidebar/api')!
  return async (method: string, payload: unknown, host = '127.0.0.1:3080'): Promise<{ status: number; ok: boolean; value: any; error?: { code: string; message: string } }> => {
    const body = Buffer.from(JSON.stringify({ sessionId: 'resource-session', authority: 'host-local', ...payload as object }))
    const req = { method: 'POST', url: `/sidebar/api/${method}`, headers: { host }, [Symbol.asyncIterator]: async function* () { yield body } }
    let status = 0
    let output = ''
    await route.handler(req as never, { writeHead: (code: number) => { status = code }, end: (chunk: unknown) => { output += String(chunk ?? '') } } as never)
    return { status, ...JSON.parse(output) }
  }
}
function repo(): string {
  const root = fixture()
  git(root, 'init', '-q')
  writeFileSync(join(root, 'tracked.txt'), 'base\n')
  writeFileSync(join(root, 'empty.txt'), '')
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  return root
}
const diffRef = (path: string, staged: boolean, extra = {}) => ({ ref: { kind: 'worktree', path, staged, ...extra } })

describe('real fenced resource data routes', () => {
  it('reads complete/empty text, binary, invalid UTF-8 and truncation with byte lengths', async () => {
    const root = fixture()
    const api = mount(root, 4)
    const path = join(root, 'text')
    writeFileSync(path, 'é')
    expect((await api('document.read', { path })).value).toEqual({ kind: 'text', content: 'é', byteLength: 2, truncated: false, writable: true })
    writeFileSync(path, '')
    expect((await api('document.read', { path })).value).toMatchObject({ content: '', byteLength: 0, writable: true })
    writeFileSync(path, Buffer.from([0xc3, 0x28]))
    expect((await api('document.read', { path })).value).toEqual({ kind: 'binary', byteLength: 2 })
    writeFileSync(path, Buffer.from([0, 1]))
    expect((await api('document.read', { path })).value.kind).toBe('binary')
    writeFileSync(path, 'abcdef')
    expect((await api('document.read', { path })).value).toEqual({ kind: 'text', content: 'abcd', byteLength: 6, truncated: true, writable: false })
    expect((await api('document.read', { path: 'relative' })).error?.code).toBe('invalid-path')
    expect((await api('document.read', { path: join(root, 'missing') })).error?.code).toBe('not-found')
    expect((await api('document.read', { path }, 'evil.example')).status).toBe(403)
    expect((await api('document.read', { path, authority: undefined })).error?.code).toBe('invalid-scope')
    const detached = mount(root, 4, false)
    expect((await detached('document.read', { path, cwd: root })).error?.code).toBe('invalid-scope')
  })

  it('requires a complete baseline, preserves drafts on conflict, accepts empty strings, and serializes same path writes', async () => {
    const root = fixture()
    const api = mount(root, 16)
    const path = join(root, 'text')
    writeFileSync(path, '')
    expect((await api('document.write', { path, content: 'new' })).error?.code).toBe('bad-request')
    expect((await api('document.write', { path, content: 'new', expectedContent: '' })).value).toEqual({})
    const results = await Promise.all([
      api('document.write', { path, content: 'first', expectedContent: 'new' }),
      api('document.write', { path, content: 'second', expectedContent: 'new' }),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.find(result => !result.ok)).toMatchObject({ status: 409, error: { code: 'conflict' } })
    const winner = results[0]!.ok ? 'first' : 'second'
    expect(readFileSync(path, 'utf8')).toBe(winner)
    expect((await api('document.write', { path, content: '', expectedContent: winner })).ok).toBe(true)
    for (const bytes of [Buffer.from([0, 1]), Buffer.from([0xc3, 0x28])]) {
      writeFileSync(path, bytes)
      expect((await api('document.write', { path, content: 'x', expectedContent: '' })).error?.code).toBe('conflict')
      expect(readFileSync(path)).toEqual(bytes)
    }
    writeFileSync(path, 'a'.repeat(17))
    expect((await api('document.write', { path, content: 'x', expectedContent: 'a' })).error?.code).toBe('too-large')
    // Legacy route still accepts unconditional overwrites, no semantic changes.
    expect((await api('fs.write', { path, content: 'legacy' })).ok).toBe(true)
  })

  it('rechecks the baseline after preparing the temp file and refuses external races', async () => {
    const root = fixture()
    const api = mount(root)
    const path = join(root, 'race.txt')
    writeFileSync(path, 'base')
    const original = fsPromises.writeFile
    vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (...args: Parameters<typeof original>) => {
      await original(...args)
      if (String(args[0]).includes('.dsh-document-')) writeFileSync(path, 'external')
    })
    syncBuiltinESMExports()
    expect((await api('document.write', { path, content: 'replacement', expectedContent: 'base' })).error?.code).toBe('conflict')
    expect(readFileSync(path, 'utf8')).toBe('external')
  })

  it('never reads the other side when staged/unstaged is empty', async () => {
    const root = repo()
    const api = mount(root)
    writeFileSync(join(root, 'tracked.txt'), 'index\n')
    git(root, 'add', 'tracked.txt')
    const empty = (await api('git.diff-strict', diffRef('tracked.txt', false))).value as ResourceStrictDiff
    expect(empty).toMatchObject({ requestedSide: 'unstaged', patch: '', empty: true, binary: false, truncated: false, files: [] })
    writeFileSync(join(root, 'tracked.txt'), 'disk\n')
    const staged = (await api('git.diff-strict', diffRef('tracked.txt', true))).value as ResourceStrictDiff
    const unstaged = (await api('git.diff-strict', diffRef('tracked.txt', false))).value as ResourceStrictDiff
    expect(staged.patch).toContain('+index')
    expect(staged.patch).not.toContain('+disk')
    expect(unstaged.patch).toContain('-index')
    expect(unstaged.patch).toContain('+disk')
    git(root, 'reset', '-q', 'HEAD', '--', 'tracked.txt')
    expect((await api('git.diff-strict', diffRef('tracked.txt', true))).value.empty).toBe(true)
  })

  it('returns lossless rename/binary/delete/empty/mode metadata and bounded untracked reads', async () => {
    const root = repo()
    const api = mount(root, 8)
    const renamed = '路径 with spaces.txt'
    renameSync(join(root, 'tracked.txt'), join(root, renamed))
    git(root, 'add', '-A')
    const rename = (await api('git.diff-strict', { ref: { kind: 'worktree', staged: true } })).value as ResourceStrictDiff
    expect(rename.files).toContainEqual({ oldPath: 'tracked.txt', newPath: renamed, change: 'renamed', editableAbsolutePath: join(root, renamed) })
    rmSync(join(root, 'empty.txt'))
    const deletion = (await api('git.diff-strict', diffRef('empty.txt', false))).value as ResourceStrictDiff
    expect(deletion.files).toEqual([{ oldPath: 'empty.txt', newPath: null, change: 'deleted' }])
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 4, 5]))
    expect((await api('git.diff-strict', diffRef('binary.bin', false))).value.binary).toBe(true)
    writeFileSync(join(root, 'empty.txt'), '')
    git(root, 'update-index', '--chmod=+x', 'empty.txt')
    const mode = (await api('git.diff-strict', diffRef('empty.txt', true))).value as ResourceStrictDiff
    expect(mode.files).toEqual([{ oldPath: 'empty.txt', newPath: 'empty.txt', change: 'mode', editableAbsolutePath: join(root, 'empty.txt') }])
    const fresh = join(root, 'fresh.txt')
    writeFileSync(fresh, '')
    expect((await api('git.diff-strict', diffRef('fresh.txt', false))).value).toMatchObject({ empty: false, untracked: { content: '', binary: false, truncated: false }, files: [{ oldPath: null, newPath: 'fresh.txt', change: 'added' }] })
    expect((await api('git.diff-strict', diffRef('fresh.txt', true))).value).toMatchObject({ empty: true, files: [] })
    writeFileSync(fresh, '0123456789')
    expect((await api('git.diff-strict', diffRef('fresh.txt', false))).value.untracked).toEqual({ content: '01234567', binary: false, truncated: true })
    writeFileSync(fresh, Buffer.from([0, 1]))
    expect((await api('git.diff-strict', diffRef('fresh.txt', false))).value.untracked).toEqual({ content: null, binary: true, truncated: false })
  })

  it('rejects scope mismatch, outside paths and unrelated worktrees while preserving nested cwd and child repo semantics', async () => {
    const root = repo()
    const child = join(root, 'nested')
    mkdirSync(child)
    const api = mount(child)
    writeFileSync(join(root, 'tracked.txt'), 'modified\n')
    expect((await api('git.diff-strict', { ...diffRef('tracked.txt', false, { repoRoot: root }), repoRoot: root })).value.patch).toContain('+modified')
    expect((await api('git.diff-strict', { ...diffRef('tracked.txt', false, { repoRoot: root }), repoRoot: child })).error?.code).toBe('invalid-scope')
    expect((await api('git.diff-strict', diffRef('../outside', false))).error?.code).toBe('invalid-path')
    expect((await api('git.diff-strict', diffRef('tracked.txt', false, { worktree: child }))).error?.code).toBe('invalid-scope')
    const linked = join(fixture(), 'linked checkout')
    git(root, 'worktree', 'add', '-q', '-b', 'resource-linked', linked)
    writeFileSync(join(linked, 'tracked.txt'), 'linked change\n')
    expect((await api('git.diff-strict', diffRef('tracked.txt', false, { worktree: linked, repoRoot: root }))).value.patch).toContain('+linked change')
    const container = fixture()
    const selected = join(container, 'child')
    mkdirSync(selected)
    git(selected, 'init', '-q')
    writeFileSync(join(selected, 'new.txt'), 'child text')
    const childApi = mount(container)
    expect((await childApi('git.diff-strict', { ...diffRef('new.txt', false, { repoRoot: selected }), repoRoot: selected })).value.untracked.content).toBe('child text')
    git(selected, 'add', '-A')
    git(selected, 'commit', '-q', '-m', 'child baseline')
    const childLinked = join(fixture(), 'child linked')
    git(selected, 'worktree', 'add', '-q', '-b', 'child-linked', childLinked)
    writeFileSync(join(childLinked, 'new.txt'), 'selected linked text')
    expect((await childApi('git.diff-strict', { ...diffRef('new.txt', false, { repoRoot: selected, worktree: childLinked }), repoRoot: selected })).value.patch).toContain('+selected linked text')
    expect((await childApi('git.diff-strict', { ...diffRef('new.txt', false, { repoRoot: selected, worktree: linked }), repoRoot: selected })).error?.code).toBe('invalid-scope')
  })

  it.skipIf(process.platform === 'win32')('distinguishes unstaged pure chmod from content plus mode changes on both sides', async () => {
    const root = repo()
    git(root, 'config', 'core.filemode', 'true')
    const api = mount(root)
    const path = join(root, 'tracked.txt')
    chmodSync(path, 0o755)
    expect((await api('git.diff-strict', diffRef('tracked.txt', false))).value.files[0].change).toBe('mode')
    git(root, 'add', 'tracked.txt')
    expect((await api('git.diff-strict', diffRef('tracked.txt', true))).value.files[0].change).toBe('mode')
    git(root, 'reset', '--hard', '-q', 'HEAD')
    chmodSync(path, 0o755)
    writeFileSync(path, 'changed content\n')
    const unstaged = (await api('git.diff-strict', diffRef('tracked.txt', false))).value as ResourceStrictDiff
    expect(unstaged.files[0]!.change).toBe('modified')
    expect(unstaged.patch).toContain('+changed content')
    git(root, 'add', 'tracked.txt')
    const staged = (await api('git.diff-strict', diffRef('tracked.txt', true))).value as ResourceStrictDiff
    expect(staged.files[0]!.change).toBe('modified')
    expect(staged.patch).toContain('+changed content')
  })

  it('does not turn truncated or invalid UTF-8 raw metadata into editable paths', () => {
    const root = fixture()
    const hash = 'a'.repeat(40)
    const modified = `:100644 100644 ${hash} ${hash} M\0`
    const renamed = `:100644 100644 ${hash} ${hash} R100\0`
    expect(resourceDiffMetadata(Buffer.from(`${modified}partial`), root)).toEqual([])
    expect(resourceDiffMetadata(Buffer.from(`${renamed}old.txt\0partial`), root)).toEqual([])
    expect(resourceDiffMetadata(Buffer.from(`${modified}complete.txt\0${modified}partial`), root)).toEqual([{ oldPath: 'complete.txt', newPath: 'complete.txt', change: 'modified', editableAbsolutePath: join(root, 'complete.txt') }])
    expect(resourceDiffMetadata(Buffer.concat([Buffer.from(modified), Buffer.from([0xc3, 0x28, 0])]), root)).toEqual([])
    expect(resourceDiffMetadata(Buffer.concat([Buffer.from(renamed), Buffer.from([0xff, 0]), Buffer.from('new.txt\0')]), root)).toEqual([])
  })

  it('caps patch stdout in the server process before accumulation', async () => {
    const root = repo()
    const api = mount(root)
    writeFileSync(join(root, 'tracked.txt'), 'a'.repeat(RESOURCE_PATCH_BYTE_LIMIT + 1024))
    const result = (await api('git.diff-strict', diffRef('tracked.txt', false))).value as ResourceStrictDiff
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(RESOURCE_PATCH_BYTE_LIMIT)
    expect(result.files).toHaveLength(1)
  })
})
