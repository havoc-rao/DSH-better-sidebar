import { describe, expect, it, vi } from 'vitest'
import { createResourceDataService, ResourceDataError, type ResourceDataSource, type ResourceStrictDiff, type ResourceTextRead, type WorktreeRef } from '../src/client/resource-data.ts'
import type { GitProviderDescriptor } from '../src/client/git-source.ts'

const scope = { sessionId: 'session', cwd: '/workspace/container', repoRoot: '/workspace/repo' }
const ref: WorktreeRef = { kind: 'worktree', path: 'new.txt', staged: false, untracked: true, repoRoot: scope.repoRoot }
const text: ResourceTextRead = { kind: 'text', content: '', truncated: false, writable: true, byteLength: 0 }
const diff: ResourceStrictDiff = { requestedSide: 'unstaged', patch: '', empty: false, binary: false, truncated: false, untracked: { content: '', binary: false, truncated: false }, files: [{ oldPath: null, newPath: 'new.txt', change: 'added', editableAbsolutePath: '/workspace/repo/new.txt' }] }
function localSource() {
  return { readText: vi.fn(async () => text), writeText: vi.fn(async () => ({})), readStrictDiff: vi.fn(async () => diff) }
}
function git(id: string, source: ResourceDataSource | undefined, match = vi.fn(() => true)): GitProviderDescriptor {
  return { id, match, createSource: vi.fn(() => source) } as unknown as GitProviderDescriptor
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('strict resource data service', () => {
  it('rejects provider comparisons returning the opposite requested side', async () => {
    const local = localSource()
    const strict = vi.fn(async () => ({ ...diff, requestedSide: 'staged' as const }))
    const service = createResourceDataService({ local, getGitProviders: () => [git('remote', { readStrictDiff: strict })] })
    await expect(service.readDiff(scope, ref)).rejects.toMatchObject({ code: 'invalid-scope' })
    expect(strict).toHaveBeenCalledTimes(1)
    expect(local.readStrictDiff).not.toHaveBeenCalled()
  })

  it('bounds retained baselines, releases unused tickets, and explicitly invalidates stable provider bindings', async () => {
    const local = localSource()
    const notify = vi.fn()
    const service = createResourceDataService({ local, notify, getGitProviders: () => [] })
    const baselines = []
    for (let i = 0; i < 64; i++) baselines.push(await service.readText(scope, '/file', { authority: 'host-local' }))
    await expect(service.readText(scope, '/file', { authority: 'host-local' })).rejects.toMatchObject({ code: 'too-large' })
    expect(service.releaseTextBaseline(baselines[0]!.baselineId!)).toBe(true)
    expect(service.releaseTextBaseline(baselines[0]!.baselineId!)).toBe(false)
    const read = await service.readText(scope, '/file', { authority: 'host-local' })
    service.invalidateResourceProviders()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(service.releaseTextBaseline(read.baselineId!)).toBe(false)
    await expect(service.writeText(scope, '/file', 'x', { ...read, baselineId: read.baselineId!, expectedContent: '' }, { authority: 'host-local' })).rejects.toMatchObject({ code: 'provider-changed' })
    expect(local.writeText).not.toHaveBeenCalled()
    expect((await service.readText(scope, '/file', { authority: 'host-local' })).providerEpoch).toBe(1)
  })

  it('binds tickets to path/scope/service and locks duplicate pending saves', async () => {
    const pending = deferred<{}>()
    const write = vi.fn(() => pending.promise)
    const local = { readText: async () => text, writeText: write }
    const service = createResourceDataService({ local, getGitProviders: () => [] })
    const other = createResourceDataService({ local, getGitProviders: () => [] })
    const read = await service.readText(scope, '/file', { authority: 'host-local' })
    const baseline = { ...read, expectedContent: '', baselineId: read.baselineId! }
    await expect(service.writeText(scope, '/other', 'x', baseline, { authority: 'host-local' })).rejects.toMatchObject({ code: 'provider-changed' })
    await expect(service.writeText({ ...scope, sessionId: 'other' }, '/file', 'x', baseline, { authority: 'host-local' })).rejects.toMatchObject({ code: 'provider-changed' })
    await expect(service.writeText({ ...scope, cwd: '/other' }, '/file', 'x', baseline, { authority: 'host-local' })).rejects.toMatchObject({ code: 'provider-changed' })
    await expect(other.writeText(scope, '/file', 'x', baseline, { authority: 'host-local' })).rejects.toMatchObject({ code: 'provider-changed' })
    expect(write).not.toHaveBeenCalled()
    const saving = service.writeText(scope, '/file', 'x', baseline, { authority: 'host-local' })
    expect(service.releaseTextBaseline(baseline.baselineId)).toBe(false)
    await expect(service.writeText(scope, '/file', 'x', baseline, { authority: 'host-local' })).rejects.toMatchObject({ code: 'conflict' })
    expect(write).toHaveBeenCalledTimes(1)
    pending.resolve({})
    const saved = await saving
    expect(saved.baselineId).not.toBe(read.baselineId)
    await expect(service.writeText(scope, '/file', 'x', baseline, { authority: 'host-local' })).rejects.toMatchObject({ code: 'provider-changed' })
  })

  it.each([{ ...text, truncated: true }, { ...text, writable: false }, { kind: 'binary' as const, byteLength: 2 }])('does not issue tickets for unsafe reads', async unsafe => {
    const write = vi.fn(async () => ({}))
    const service = createResourceDataService({ local: { readText: async () => unsafe, writeText: write }, getGitProviders: () => [] })
    const result = await service.readText(scope, '/file', { authority: 'host-local' })
    expect(result.baselineId).toBeUndefined()
    await expect(service.writeText(scope, '/file', 'x', { ...result, expectedContent: '', baselineId: 'forged' }, { authority: 'host-local' })).rejects.toMatchObject({ code: 'provider-changed' })
    expect(write).not.toHaveBeenCalled()
  })

  it('does not mistake no provider matches for host ownership; explicit authority admits local IO', async () => {
    const local = localSource()
    const service = createResourceDataService({ local, getGitProviders: () => [] })
    await expect(service.readText(scope, '/file')).rejects.toMatchObject({ code: 'unavailable' })
    await expect(service.writeText(scope, '/file', '', { expectedContent: '', providerId: 'host-local', providerEpoch: 0, baselineId: 'invalid' })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(service.readDiff(scope, ref)).rejects.toMatchObject({ code: 'unavailable' })
    expect(local.readText).not.toHaveBeenCalled()
    expect(local.writeText).not.toHaveBeenCalled()
    expect(local.readStrictDiff).not.toHaveBeenCalled()
    expect(service.getResourceCapabilities(scope)).toMatchObject({ authorityRequired: true, readText: false, writeText: false, readDiff: false, condition: 'content', strictSides: true, patchByteLimit: 4194304 })
    const result = await service.readText(scope, '/file', { authority: 'host-local' })
    expect(result).toMatchObject({ ...text, providerId: 'host-local', providerEpoch: 0, baselineId: expect.any(String) })
    await service.writeText(scope, '/file', '', { expectedContent: '', providerId: result.providerId, providerEpoch: result.providerEpoch, baselineId: result.baselineId! }, { authority: 'host-local' })
    await service.readDiff(scope, ref, { authority: 'host-local' })
    expect(local.readText).toHaveBeenCalledWith(scope, '/file', { signal: expect.any(AbortSignal) })
    expect(local.writeText).toHaveBeenCalledWith(scope, '/file', '', { expectedContent: '' })
    expect(local.readStrictDiff).toHaveBeenCalledWith(scope, ref, { signal: expect.any(AbortSignal) })
    expect(ref.worktree).toBeUndefined()
  })

  it('Git ownership without document support forbids local reads/writes even with opt-in', async () => {
    const local = localSource()
    const provider = git('remote', {})
    const service = createResourceDataService({ local, getGitProviders: () => [provider] })
    await expect(service.readText(scope, '/file', { authority: 'host-local' })).rejects.toMatchObject({ code: 'unsupported-provider' })
    await expect(service.writeText(scope, '/file', 'x', { expectedContent: '', providerId: 'host-local', providerEpoch: 0, baselineId: 'invalid' }, { authority: 'host-local' })).rejects.toMatchObject({ code: 'unsupported-provider' })
    await expect(service.readDiff(scope, ref, { authority: 'host-local' })).rejects.toMatchObject({ code: 'unsupported-provider' })
    expect(local.readText).not.toHaveBeenCalled()
    expect(local.writeText).not.toHaveBeenCalled()
    expect(local.readStrictDiff).not.toHaveBeenCalled()
    expect(provider.match).toHaveBeenCalledWith(scope.sessionId, scope.cwd)
  })

  it.each(['undefined', 'throw', 'missing'] as const)('locks first matching document provider when source is %s', async mode => {
    const local = localSource()
    const next = vi.fn(() => local)
    const service = createResourceDataService({ local, getGitProviders: () => [] })
    service.registerDocumentProvider({ id: 'first', match: () => true, createSource: () => {
      if (mode === 'throw') throw new Error('factory failed')
      return mode === 'undefined' ? undefined : {}
    } })
    service.registerDocumentProvider({ id: 'next', match: () => true, createSource: next })
    await expect(service.readText(scope, '/file', { authority: 'host-local' })).rejects.toMatchObject({ code: 'unsupported-provider' })
    await expect(service.writeText(scope, '/file', 'x', { expectedContent: '', providerId: 'host-local', providerEpoch: 0, baselineId: 'invalid' }, { authority: 'host-local' })).rejects.toMatchObject({ code: 'unsupported-provider' })
    expect(next).not.toHaveBeenCalled()
    expect(local.readText).not.toHaveBeenCalled()
  })

  it.each(['document', 'git'] as const)('fails closed on throwing %s ownership predicate', async kind => {
    const local = localSource()
    const provider = git('throws', local, vi.fn(() => { throw new Error('unknown ownership') }))
    const service = createResourceDataService({ local, getGitProviders: () => kind === 'git' ? [provider] : [] })
    if (kind === 'document') service.registerDocumentProvider({ id: 'throws', match: provider.match, createSource: () => local })
    await expect(service.readText(scope, '/file', { authority: 'host-local' })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(service.readDiff(scope, ref, { authority: 'host-local' })).rejects.toMatchObject({ code: 'unavailable' })
    expect(local.readText).not.toHaveBeenCalled()
    expect(local.readStrictDiff).not.toHaveBeenCalled()
  })

  it.each(['undefined', 'throw', 'missing'] as const)('strict Git locks first match (%s), never legacy diff or another provider', async mode => {
    const local = localSource()
    const legacy = vi.fn()
    const next = git('next', local)
    const first = git('first', mode === 'undefined' ? undefined : { gitDiff: legacy } as ResourceDataSource)
    if (mode === 'throw') first.createSource = () => { throw new Error('factory error') }
    const service = createResourceDataService({ local, getGitProviders: () => [first, next] })
    await expect(service.readDiff(scope, ref, { authority: 'host-local' })).rejects.toMatchObject({ code: 'unsupported-provider' })
    expect(next.match).not.toHaveBeenCalled()
    expect(legacy).not.toHaveBeenCalled()
    expect(local.readStrictDiff).not.toHaveBeenCalled()
  })

  it('preserves complete scope/ref and provider untracked metadata without fs补读 or opposite-side fallback', async () => {
    const local = localSource()
    const strict = vi.fn(async () => diff)
    const service = createResourceDataService({ local, getGitProviders: () => [git('remote', { readStrictDiff: strict })] })
    const result = await service.readDiff(scope, ref)
    expect(result).toEqual({ ...diff, providerId: 'remote', providerEpoch: 0 })
    expect(strict).toHaveBeenCalledTimes(1)
    expect(strict).toHaveBeenCalledWith(scope, ref, { signal: expect.any(AbortSignal) })
    expect(local.readText).not.toHaveBeenCalled()
    expect(local.readStrictDiff).not.toHaveBeenCalled()
    await expect(service.readDiff(scope, { ...ref, repoRoot: '/different' })).rejects.toMatchObject({ code: 'invalid-scope' })
  })

  it('registry notifications abort reads promptly and reject stale results as provider-changed', async () => {
    const pending = deferred<ResourceTextRead>()
    let notify!: () => void
    let signal!: AbortSignal
    const off = vi.fn()
    const service = createResourceDataService({ local: {}, getGitProviders: () => [], subscribeRegistry: listener => { notify = listener; return off } })
    const unregister = service.registerDocumentProvider({ id: 'remote', match: () => true, createSource: () => ({ readText: async (_s, _p, options) => { signal = options!.signal!; return pending.promise } }) })
    const read = service.readText(scope, '/file')
    const rejection = expect(read).rejects.toMatchObject({ code: 'provider-changed' })
    await Promise.resolve()
    notify()
    expect(signal.aborted).toBe(true)
    await rejection
    pending.resolve(text)
    unregister(); unregister()
    expect(service.getDocumentProviders()).toEqual([])
    service.dispose(); service.dispose()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('doc registration/removal advances metadata epochs and duplicate registration fails', async () => {
    const local = localSource()
    const service = createResourceDataService({ local, getGitProviders: () => [] })
    const doc = { id: 'remote', match: vi.fn(() => true), createSource: vi.fn(() => local) }
    const off = service.registerDocumentProvider(doc)
    expect(service.getDocumentProviders()).toEqual([doc])
    expect(() => service.registerDocumentProvider(doc)).toThrow('duplicate')
    expect(await service.readText(scope, '/file')).toMatchObject({ providerId: 'remote', providerEpoch: 1 })
    expect(doc.createSource).toHaveBeenCalledWith(scope.sessionId, scope.cwd)
    off()
    expect(await service.readText(scope, '/file', { authority: 'host-local' })).toMatchObject({ providerId: 'host-local', providerEpoch: 2 })
  })

  it('external cancellation is aborted, disposal is provider-changed, and stale data never succeeds', async () => {
    const local = { readText: vi.fn(() => new Promise<ResourceTextRead>(() => {})) }
    const service = createResourceDataService({ local, getGitProviders: () => [] })
    const abort = new AbortController()
    const read = service.readText(scope, '/file', { authority: 'host-local', signal: abort.signal })
    abort.abort()
    await expect(read).rejects.toMatchObject({ code: 'aborted' })
    const old = service.readText(scope, '/file', { authority: 'host-local' })
    service.dispose()
    await expect(old).rejects.toMatchObject({ code: 'provider-changed' })
  })

  it.each(['success', 'failure'] as const)('ownership changes do not abort or unlock pending writes (%s)', async outcome => {
    const pending = deferred<{}>()
    const write = vi.fn(() => pending.promise)
    const service = createResourceDataService({ local: {}, getGitProviders: () => [] })
    const off = service.registerDocumentProvider({ id: 'remote', match: () => true, createSource: () => ({ writeText: write, readText: async () => text }) })
    const baseline = await service.readText(scope, '/file')
    const saving = service.writeText(scope, '/file', 'new', { expectedContent: '', providerId: baseline.providerId, providerEpoch: baseline.providerEpoch, baselineId: baseline.baselineId! })
    let settled = false
    void saving.then(() => { settled = true }, () => { settled = true })
    off()
    await Promise.resolve()
    expect(settled).toBe(false)
    if (outcome === 'success') pending.resolve({})
    else pending.reject(new Error('network failed'))
    await expect(saving).rejects.toMatchObject({ code: outcome === 'success' ? 'provider-changed' : 'write-outcome-unknown', ambiguous: true })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]).toHaveLength(4)
  })

  it('structured conflicts survive, unknown network write failures are ambiguous and never retry', async () => {
    const write = vi.fn(async () => { throw { code: 'conflict', message: 'disk changed' } })
    const service = createResourceDataService({ local: { writeText: write, readText: async () => text }, getGitProviders: () => [] })
    const first = await service.readText(scope, '/file', { authority: 'host-local' })
    await expect(service.writeText(scope, '/file', 'new', { ...first, expectedContent: '', baselineId: first.baselineId! }, { authority: 'host-local' })).rejects.toMatchObject({ code: 'conflict', ambiguous: false })
    write.mockImplementation(async () => { throw new TypeError('network') })
    const second = await service.readText(scope, '/file', { authority: 'host-local' })
    const saving = service.writeText(scope, '/file', 'new', { ...second, expectedContent: '', baselineId: second.baselineId! }, { authority: 'host-local' })
    await expect(saving).rejects.toBeInstanceOf(ResourceDataError)
    await expect(saving).rejects.toMatchObject({ code: 'write-outcome-unknown', ambiguous: true })
    expect(write).toHaveBeenCalledTimes(2)
  })
})
