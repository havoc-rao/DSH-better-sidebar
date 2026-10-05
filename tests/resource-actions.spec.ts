import { describe, expect, it, vi } from 'vitest'
import {
  createResourceActionRegistry, type ResourceActionContext, type ResourceActionDescriptor,
  type FileActivationContext, type FileOpenTargetDescriptor,
} from '../src/client/resource-actions.ts'

const scope = { sessionId: 'session', cwd: '/workspace', repoRoot: '/repository' }
const file = (): ResourceActionContext => ({ kind: 'file', surface: 'file-tree-context', scope,
  absolutePath: '/workspace/file.ts', isDirectory: false, dirty: false, readOnly: false })
const activation = (): FileActivationContext => ({ intent: 'activate', scope,
  absolutePath: '/workspace/file.ts', dirty: false, readOnly: false })
function action(id: string, extra: Partial<ResourceActionDescriptor> = {}): ResourceActionDescriptor {
  return { id, label: id, surfaces: ['file-tree-context'], run: vi.fn(), ...extra }
}
function target(id: string, extra: Partial<FileOpenTargetDescriptor> = {}): FileOpenTargetDescriptor {
  return { id, priority: 100, accept: () => true, open: () => 'declined', ...extra }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('resource action registry', () => {
  it('registers, rejects duplicate ids, notifies, and disposes idempotently across replacement', () => {
    const notify = vi.fn(); const api = createResourceActionRegistry(notify)
    const first = action('a'); const remove = api.registerResourceAction(first)
    expect(api.getResourceActions(file())).toEqual([first])
    expect(() => api.registerResourceAction(first)).toThrow(/already registered/)
    remove(); remove()
    const second = action('a'); api.registerResourceAction(second); remove()
    expect(api.getResourceActions(file())).toEqual([second])
    expect(notify).toHaveBeenCalledTimes(3)
    const removeTarget = api.registerFileOpenTarget(target('a'))
    expect(() => api.registerFileOpenTarget(target('a'))).toThrow(/already registered/)
    removeTarget(); removeTarget()
  })
  it('sorts by ascending order with default 100 and stable ties, and filters surfaces/availability', () => {
    const api = createResourceActionRegistry(() => {})
    for (const item of [action('default'), action('late', { order: 101 }), action('early', { order: -1 }),
      action('tie', { order: 100 }), action('hidden', { available: () => false }),
      action('viewer', { surfaces: ['file-viewer-toolbar'] })]) api.registerResourceAction(item)
    expect(api.getResourceActions(file()).map(item => item.id)).toEqual(['early', 'default', 'tie', 'late'])
  })
  it('passes fresh full context and reevaluates availability before running', async () => {
    const api = createResourceActionRegistry(() => {}); const run = vi.fn()
    api.registerResourceAction(action('edit', { available: ctx => ctx.kind === 'file' && ctx.dirty === false, run }))
    expect(api.getResourceActions(file())).toHaveLength(1)
    const latest = { ...file(), dirty: true } as ResourceActionContext
    await expect(api.runResourceAction('edit', () => latest)).rejects.toThrow(/unavailable/)
    expect(run).not.toHaveBeenCalled()
    await api.runResourceAction('edit', file)
    expect(run).toHaveBeenCalledWith(file(), expect.any(AbortSignal))
    const git: ResourceActionContext = { kind: 'git-diff', surface: 'git-preview-toolbar', scope,
      ref: { kind: 'worktree', path: 'file.ts', staged: false } }
    const compare = vi.fn(); api.registerResourceAction(action('compare', { surfaces: ['git-preview-toolbar'], run: compare }))
    await api.runResourceAction('compare', () => git)
    expect(compare.mock.calls[0]?.[0]).toBe(git)
  })
  it('exposes available, context, and run exceptions instead of silently swallowing them', async () => {
    const api = createResourceActionRegistry(() => {}); const failure = new Error('visible failure')
    api.registerResourceAction(action('bad', { available: () => { throw failure } }))
    expect(() => api.getResourceActions(file())).toThrow(failure)
    await expect(api.runResourceAction('bad', file)).rejects.toBe(failure)
    api.registerResourceAction(action('run', { run: () => { throw failure } }))
    await expect(api.runResourceAction('run', file)).rejects.toBe(failure)
    await expect(api.runResourceAction('run', () => { throw failure })).rejects.toBe(failure)
    await expect(api.runResourceAction('missing', file)).rejects.toThrow(/unavailable/)
  })
  it('merges live document reports conservatively, isolates sessions/paths, and defaults to clean writable', () => {
    const api = createResourceActionRegistry(() => {}); const path = '/file'
    expect(api.getFileDocumentState(scope, path)).toEqual({ dirty: false, readOnly: false })
    const remove = api.reportFileDocument('one', scope, path, { dirty: true, readOnly: false })
    api.setFileDocumentState('two', scope, path, { dirty: 'unknown', readOnly: true })
    expect(api.getFileDocumentState({ ...scope, cwd: '/different' }, path)).toEqual({ dirty: true, readOnly: true })
    remove(); remove()
    expect(api.getFileDocumentState(scope, path)).toEqual({ dirty: 'unknown', readOnly: true })
    api.setFileDocumentState('two', scope, path, { dirty: false, readOnly: false })
    expect(api.getFileDocumentState(scope, path)).toEqual({ dirty: false, readOnly: false })
    api.setFileDocumentState('two', scope, path, undefined)
    const old = api.reportFileDocument('one', scope, path, { dirty: true, readOnly: false })
    api.setFileDocumentState('one', scope, path, { dirty: 'unknown', readOnly: true }); old()
    expect(api.getFileDocumentState(scope, path).dirty).toBe('unknown')
    expect(api.getFileDocumentState({ ...scope, sessionId: 'other' }, path).dirty).toBe(false)
    expect(api.getFileDocumentState(scope, '/other').dirty).toBe(false)
  })
  it('reads current document state rather than stale menu dirty', async () => {
    const api = createResourceActionRegistry(() => {}); const run = vi.fn()
    api.registerResourceAction(action('edit', { available: ctx => ctx.kind === 'file' && ctx.dirty === false, run }))
    const read = () => ({ ...file(), ...api.getFileDocumentState(scope, '/workspace/file.ts') }) as ResourceActionContext
    expect(api.getResourceActions(read())).toHaveLength(1)
    api.setFileDocumentState('viewer', scope, '/workspace/file.ts', { dirty: 'unknown', readOnly: false })
    await expect(api.runResourceAction('edit', read)).rejects.toThrow(/unavailable/)
    expect(run).not.toHaveBeenCalled()
  })
  it('aborts action work promptly on unregister even when the consumer ignores cancellation', async () => {
    const api = createResourceActionRegistry(() => {}); const pending = deferred<void>(); let signal!: AbortSignal
    const remove = api.registerResourceAction(action('edit', { run: (_ctx, current) => { signal = current; return pending.promise } }))
    const result = api.runResourceAction('edit', file)
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    remove(); expect(signal.aborted).toBe(true); await assertion
    pending.reject(new Error('late failure'))
  })
  it('does not start callbacks unregistered by context or availability evaluation', async () => {
    const api = createResourceActionRegistry(() => {}); const run = vi.fn()
    const remove = api.registerResourceAction(action('edit', { run }))
    await expect(api.runResourceAction('edit', () => { remove(); return file() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('ordinary file activation', () => {
  it('returns false by default and orders priorities stably; declined continues and handled stops', async () => {
    const api = createResourceActionRegistry(() => {}); const calls: string[] = []
    expect(await api.dispatchFileActivation(activation)).toBe(false)
    for (const [id, priority, result] of [['last', 9, 'handled'], ['first', 1, 'declined'], ['tie', 1, 'handled']] as const) {
      api.registerFileOpenTarget(target(id, { priority, open: () => { calls.push(id); return result } }))
    }
    expect(await api.dispatchFileActivation(activation)).toBe(true)
    expect(calls).toEqual(['first', 'tie'])
  })
  it('re-reads full latest context between declined targets and skips rejected candidates', async () => {
    const api = createResourceActionRegistry(() => {}); let dirty = false
    const rejected = vi.fn(); const accepted = vi.fn(() => 'handled' as const)
    api.registerFileOpenTarget(target('no', { accept: () => false, open: rejected }))
    api.registerFileOpenTarget(target('decline', { open: () => { dirty = true; return 'declined' } }))
    api.registerFileOpenTarget(target('yes', { open: accepted }))
    expect(await api.dispatchFileActivation(() => ({ ...activation(), dirty }))).toBe(true)
    expect(rejected).not.toHaveBeenCalled()
    expect(accepted).toHaveBeenCalledWith({ ...activation(), dirty: true }, expect.any(AbortSignal))
  })
  it('propagates accept/open failures and never falls back after accepted errors', async () => {
    for (const field of ['accept', 'open'] as const) {
      const api = createResourceActionRegistry(() => {}); const error = new Error(field); const fallback = vi.fn()
      api.registerFileOpenTarget(target('bad', { [field]: () => { throw error } }))
      api.registerFileOpenTarget(target('fallback', { open: fallback }))
      await expect(api.dispatchFileActivation(activation)).rejects.toBe(error)
      expect(fallback).not.toHaveBeenCalled()
    }
  })
  it('does not start open after synchronous unregister in accept, or reach later fallback', async () => {
    const api = createResourceActionRegistry(() => {}); const open = vi.fn(); const fallback = vi.fn()
    let remove!: () => void
    remove = api.registerFileOpenTarget(target('remove', { accept: () => { remove(); return true }, open }))
    api.registerFileOpenTarget(target('fallback', { open: fallback }))
    await expect(api.dispatchFileActivation(activation)).rejects.toMatchObject({ name: 'AbortError' })
    expect(open).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled()
  })
  it('skips later unregistered targets and refuses asynchronous accepted failures', async () => {
    const api = createResourceActionRegistry(() => {}); const open = vi.fn()
    let remove!: () => void
    api.registerFileOpenTarget(target('first', { priority: 0, open: () => { remove(); return 'declined' } }))
    remove = api.registerFileOpenTarget(target('removed', { open }))
    expect(await api.dispatchFileActivation(activation)).toBe(false)
    expect(open).not.toHaveBeenCalled()
    const error = new Error('async failure'); const fallback = vi.fn()
    api.registerFileOpenTarget(target('bad', { open: () => Promise.reject(error) }))
    api.registerFileOpenTarget(target('fallback', { open: fallback }))
    await expect(api.dispatchFileActivation(activation)).rejects.toBe(error)
    expect(fallback).not.toHaveBeenCalled()
  })
  it.each(['handled', 'declined'] as const)('aborts unregistered targets without late %s or fallback', async lateResult => {
    const api = createResourceActionRegistry(() => {}); const pending = deferred<'handled' | 'declined'>()
    let signal!: AbortSignal; const fallback = vi.fn()
    const remove = api.registerFileOpenTarget(target('pending', { open: (_ctx, current) => { signal = current; return pending.promise } }))
    api.registerFileOpenTarget(target('fallback', { open: fallback }))
    const result = api.dispatchFileActivation(activation)
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    remove(); await assertion; expect(signal.aborted).toBe(true)
    pending.resolve(lateResult); await Promise.resolve()
    expect(fallback).not.toHaveBeenCalled()
  })
  it('disposes all tasks, clears registrations/reports, and refuses future work', async () => {
    const api = createResourceActionRegistry(() => {}); const pending = deferred<void>(); const opening = deferred<'handled'>()
    let actionSignal!: AbortSignal; let targetSignal!: AbortSignal
    api.registerResourceAction(action('a', { run: (_ctx, signal) => { actionSignal = signal; return pending.promise } }))
    api.registerFileOpenTarget(target('t', { open: (_ctx, signal) => { targetSignal = signal; return opening.promise } }))
    api.setFileDocumentState('viewer', scope, '/file', { dirty: true, readOnly: true })
    const running = api.runResourceAction('a', file); const dispatching = api.dispatchFileActivation(activation)
    const failures = Promise.all([expect(running).rejects.toMatchObject({ name: 'AbortError' }),
      expect(dispatching).rejects.toMatchObject({ name: 'AbortError' })])
    api.dispose(); api.dispose(); await failures
    expect(actionSignal.aborted && targetSignal.aborted).toBe(true)
    expect(api.getResourceActions(file())).toEqual([])
    expect(api.getFileDocumentState(scope, '/file')).toEqual({ dirty: false, readOnly: false })
    expect(() => api.registerResourceAction(action('new'))).toThrow(/cancelled/)
    await expect(api.dispatchFileActivation(activation)).rejects.toMatchObject({ name: 'AbortError' })
    pending.resolve(); opening.resolve('handled')
  })
})
