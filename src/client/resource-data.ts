import type { SessionScope } from './api.ts'
import type { GitProviderDescriptor } from './git-source.ts'
import type { SidebarDiffRef } from './state.ts'

export type WorktreeRef = Extract<SidebarDiffRef, { kind: 'worktree' }>
export type ResourceTextRead =
  | { kind: 'text'; content: string; truncated: boolean; revision?: string; writable: boolean; byteLength: number }
  | { kind: 'binary'; byteLength: number }
export interface ResourceTextWriteResult { revision?: string }
export interface ResourceDiffFile {
  oldPath: string | null
  newPath: string | null
  change: 'added' | 'deleted' | 'modified' | 'renamed' | 'mode'
  editableAbsolutePath?: string
}
export interface ResourceStrictDiff {
  requestedSide: 'staged' | 'unstaged'
  patch: string
  empty: boolean
  binary: boolean
  truncated: boolean
  untracked?: { content: string | null; binary: boolean; truncated: boolean }
  files: readonly ResourceDiffFile[]
}
export interface ResourceReadOptions { signal?: AbortSignal }
export interface ResourceAuthorityOptions { authority?: 'host-local' }
export interface ResourceDataOptions extends ResourceReadOptions, ResourceAuthorityOptions {}
export interface ResourceWriteCondition { expectedContent: string }
/** A write baseline is bound to the exact complete-read provider generation. */
export interface ResourceWriteBaseline extends ResourceWriteCondition, ResourceProviderMetadata { baselineId: string }
export type ResourceTextReadResult = ResourceTextRead & ResourceProviderMetadata & { baselineId?: string }
export type ResourceTextWriteOutcome = ResourceTextWriteResult & ResourceProviderMetadata & { baselineId: string }
let serviceSequence = 0
/** A provider's methods never receive authority: only this service admits host IO. */
export interface ResourceDataSource {
  readText?(scope: SessionScope, path: string, options?: ResourceReadOptions): Promise<ResourceTextRead>
  writeText?(scope: SessionScope, path: string, content: string, condition: ResourceWriteCondition): Promise<ResourceTextWriteResult>
  readStrictDiff?(scope: SessionScope, ref: WorktreeRef, options?: ResourceReadOptions): Promise<ResourceStrictDiff>
}
export interface DocumentProviderDescriptor {
  id: string
  match(sessionId: string, cwd: string | undefined): boolean
  createSource(sessionId: string, cwd: string | undefined): ResourceDataSource | undefined
}
export interface ResourceProviderMetadata { providerId: string; providerEpoch: number }
export type ResourceDataErrorCode =
  | 'conflict' | 'not-found' | 'permission-denied' | 'invalid-path' | 'invalid-scope'
  | 'too-large' | 'unsupported-provider' | 'provider-changed' | 'unavailable'
  | 'aborted' | 'write-outcome-unknown'
const codes = new Set<string>([
  'conflict', 'not-found', 'permission-denied', 'invalid-path', 'invalid-scope',
  'too-large', 'unsupported-provider', 'provider-changed', 'unavailable', 'aborted', 'write-outcome-unknown',
])
export class ResourceDataError extends Error {
  readonly name = 'ResourceDataError'
  constructor(readonly code: ResourceDataErrorCode, message: string, readonly ambiguous = false, readonly reason?: 'authority-required') { super(message) }
}
export interface ResourceCapabilities {
  condition: 'content'
  byteLimit: number
  patchByteLimit: number
  strictSides: true
  /** Absence of provider matches is NOT evidence of local ownership. */
  authorityRequired: true
  providerEpoch: number
  readText: boolean
  writeText: boolean
  readDiff: boolean
  documentProviderId?: string
  gitProviderId?: string
  documentError?: ResourceDataErrorCode
  diffError?: ResourceDataErrorCode
  documentErrorReason?: 'authority-required'
  diffErrorReason?: 'authority-required'
  /** Values are configured/default limits, not a per-provider assertion. */
  limitsSource: 'configured' | 'default'
}
interface Owner { id: string; source: ResourceDataSource }
function fail(code: ResourceDataErrorCode, message: string): never { throw new ResourceDataError(code, message) }
function normalize(error: unknown, write = false): ResourceDataError {
  if (error instanceof ResourceDataError) return error
  const candidate = error as { code?: unknown; message?: unknown } | null
  if (typeof candidate?.code === 'string' && codes.has(candidate.code)) {
    return new ResourceDataError(candidate.code as ResourceDataErrorCode, typeof candidate.message === 'string' ? candidate.message : candidate.code, candidate.code === 'write-outcome-unknown')
  }
  return new ResourceDataError(write ? 'write-outcome-unknown' : 'unavailable', error instanceof Error ? error.message : String(error), write)
}
function validateScope(scope: SessionScope) {
  if (!scope || typeof scope.sessionId !== 'string' || !scope.sessionId) fail('invalid-scope', 'A session scope is required')
}
function validatePath(path: string) {
  if (typeof path !== 'string' || path.includes('\0') || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path))) fail('invalid-path', 'An absolute document path without NUL is required')
}

/** Strict data seam, intentionally independent of legacy throwing-safe Git resolution.
 * First true owns the request even if its factory or method is unavailable. No
 * legacy gitDiff, fsRead or cwd-as-worktree fallback is permitted here.
 */
export function createResourceDataService(options: {
  local: ResourceDataSource
  getGitProviders: () => readonly GitProviderDescriptor[]
  subscribeRegistry?: (listener: () => void) => () => void
  notify?: () => void
  limits?: { textByteLimit?: number; patchByteLimit?: number }
}) {
  const documents = new Map<string, DocumentProviderDescriptor>()
  const reads = new Set<AbortController>()
  const activation = `${++serviceSequence}-${globalThis.crypto.randomUUID()}`
  let ticketSequence = 0
  const tickets = new Map<string, { resource: string; content: string; providerId: string; providerEpoch: number; pending: boolean }>()
  const resourceKey = (scope: SessionScope, path: string) => JSON.stringify([scope.sessionId, scope.cwd, scope.repoRoot, path])
  function issue(scope: SessionScope, path: string, content: string, providerId: string, providerEpoch: number) {
    if (tickets.size >= 64) fail('too-large', 'At most 64 live text baselines are supported; release unused baselines')
    if (new TextEncoder().encode(content).byteLength > textLimit) fail('too-large', 'Complete text baseline exceeds the configured byte limit')
    const baselineId = `${activation}-${++ticketSequence}`
    tickets.set(baselineId, { resource: resourceKey(scope, path), content, providerId, providerEpoch, pending: false })
    return baselineId
  }
  let epoch = 0
  let disposed = false
  let gitSnapshot: readonly GitProviderDescriptor[] | undefined
  const textLimit = options.limits?.textByteLimit ?? 512 * 1024
  const patchLimit = options.limits?.patchByteLimit ?? 4 * 1024 * 1024
  function changed() {
    epoch++
    tickets.clear()
    for (const read of reads) read.abort()
    options.notify?.()
  }
  function ensureLive() { if (disposed) fail('unavailable', 'Resource data service is disposed') }
  function gitProviders() {
    let current: readonly GitProviderDescriptor[]
    try { current = options.getGitProviders() } catch (error) { throw normalize(error) }
    if (gitSnapshot && (current.length !== gitSnapshot.length || current.some((p, i) => p !== gitSnapshot![i]))) changed()
    gitSnapshot = [...current]
    return current
  }
  function firstMatch<T extends { match(sessionId: string, cwd: string | undefined): boolean }>(providers: readonly T[], scope: SessionScope): T | undefined {
    for (const provider of providers) {
      let matched: boolean
      try { matched = provider.match(scope.sessionId, scope.cwd) === true }
      catch (error) { throw new ResourceDataError('unavailable', `Provider ownership predicate failed: ${error instanceof Error ? error.message : String(error)}`) }
      if (matched) return provider
    }
    return undefined
  }
  function source(provider: DocumentProviderDescriptor | GitProviderDescriptor, scope: SessionScope): Owner {
    try {
      const value = provider.createSource(scope.sessionId, scope.cwd)
      if (!value) fail('unsupported-provider', `Provider ${provider.id} refused a source`)
      return { id: provider.id, source: value as ResourceDataSource }
    } catch (error) { throw new ResourceDataError('unsupported-provider', `Provider ${provider.id} source unavailable: ${error instanceof Error ? error.message : String(error)}`) }
  }
  function resolveDocument(scope: SessionScope, authority?: 'host-local'): Owner {
    ensureLive(); validateScope(scope)
    const git = gitProviders()
    const doc = firstMatch([...documents.values()], scope)
    if (doc) return source(doc, scope)
    if (firstMatch(git, scope)) fail('unsupported-provider', 'Git-owned scope has no document provider')
    if (authority !== 'host-local') throw new ResourceDataError('unavailable', 'Local ownership requires explicit host-local authority', false, 'authority-required')
    return { id: 'host-local', source: options.local }
  }
  function resolveDiff(scope: SessionScope, authority?: 'host-local'): Owner {
    ensureLive(); validateScope(scope)
    const git = firstMatch(gitProviders(), scope)
    if (git) return source(git, scope)
    // A document provider also proves non-host ownership, not host Git authority.
    if (firstMatch([...documents.values()], scope)) fail('unsupported-provider', 'Document-owned scope has no strict Git provider')
    if (authority !== 'host-local') throw new ResourceDataError('unavailable', 'Local ownership requires explicit host-local authority', false, 'authority-required')
    return { id: 'host-local', source: options.local }
  }
  function requireMethod<K extends keyof ResourceDataSource>(owner: Owner, method: K): NonNullable<ResourceDataSource[K]> {
    const fn = owner.source[method]
    if (typeof fn !== 'function') fail('unsupported-provider', `Provider ${owner.id} does not support ${method}`)
    return fn as NonNullable<ResourceDataSource[K]>
  }
  const unsubscribe = options.subscribeRegistry?.(() => { gitSnapshot = undefined; changed() })
  async function read<T>(owner: Owner, signal: AbortSignal | undefined, invoke: (signal: AbortSignal) => Promise<T>): Promise<T & ResourceProviderMetadata> {
    const start = epoch
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const aborted = () => new ResourceDataError(start !== epoch || disposed ? 'provider-changed' : 'aborted', start !== epoch || disposed ? 'Provider changed during read' : 'Resource read was cancelled')
    if (signal?.aborted) throw aborted()
    signal?.addEventListener('abort', cancel, { once: true })
    reads.add(controller)
    try {
      const value = await new Promise<T>((accept, reject) => {
        const onAbort = () => reject(aborted())
        controller.signal.addEventListener('abort', onAbort, { once: true })
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw aborted()
          return invoke(controller.signal)
        }).then(value => {
          controller.signal.removeEventListener('abort', onAbort)
          if (controller.signal.aborted || start !== epoch || disposed) reject(aborted())
          else accept(value)
        }, error => {
          controller.signal.removeEventListener('abort', onAbort)
          reject(controller.signal.aborted || start !== epoch || disposed ? aborted() : normalize(error))
        })
      })
      if (start !== epoch || disposed) throw aborted()
      return { ...value, providerId: owner.id, providerEpoch: start }
    } finally { reads.delete(controller); signal?.removeEventListener('abort', cancel) }
  }
  return {
    registerDocumentProvider(provider: DocumentProviderDescriptor): () => void {
      ensureLive()
      if (!provider.id || provider.id === 'host-local' || documents.has(provider.id)) throw new Error(`Invalid or duplicate document provider id: ${provider.id}`)
      documents.set(provider.id, provider); changed()
      return () => { if (documents.get(provider.id) !== provider) return; documents.delete(provider.id); changed() }
    },
    getDocumentProviders(): readonly DocumentProviderDescriptor[] { return [...documents.values()] },
    /** Providers must invalidate when a stable descriptor changes its source binding. */
    invalidateResourceProviders(): void { ensureLive(); changed() },
    /** Releases retained baseline text. Pending saves retain their ticket/lock. */
    releaseTextBaseline(baselineId: string): boolean {
      const ticket = tickets.get(baselineId)
      if (!ticket || ticket.pending) return false
      return tickets.delete(baselineId)
    },
    async readText(scope: SessionScope, path: string, opts?: ResourceDataOptions): Promise<ResourceTextReadResult> {
      validatePath(path)
      const owner = resolveDocument(scope, opts?.authority)
      const fn = requireMethod(owner, 'readText')
      const result = await read(owner, opts?.signal, signal => fn.call(owner.source, scope, path, { signal }))
      if (result.providerEpoch !== epoch || disposed) fail('provider-changed', 'Provider changed during read')
      if (result.kind === 'text' && !result.truncated && result.writable) {
        return { ...result, baselineId: issue(scope, path, result.content, result.providerId, result.providerEpoch) }
      }
      return result
    },
    async writeText(scope: SessionScope, path: string, content: string, condition: ResourceWriteBaseline, opts?: ResourceAuthorityOptions): Promise<ResourceTextWriteOutcome> {
      validatePath(path)
      if (typeof content !== 'string' || !condition || typeof condition.expectedContent !== 'string') fail('conflict', 'An expectedContent condition is required')
      if (new TextEncoder().encode(content).byteLength > textLimit) fail('too-large', 'Replacement text exceeds the configured byte limit')
      const owner = resolveDocument(scope, opts?.authority)
      const fn = requireMethod(owner, 'writeText')
      const start = epoch
      if (condition.providerId !== owner.id || condition.providerEpoch !== start) fail('provider-changed', 'Write baseline belongs to another provider generation')
      const ticket = tickets.get(condition.baselineId)
      if (!ticket || ticket.resource !== resourceKey(scope, path) || ticket.content !== condition.expectedContent || ticket.providerId !== owner.id || ticket.providerEpoch !== start) fail('provider-changed', 'A complete writable read of this resource and service activation is required')
      if (ticket.pending) fail('conflict', 'This baseline already has a pending save')
      ticket.pending = true
      // Never race an abort against a potentially committed write. Await the real
      // outcome, retain the caller's save lock, and never automatically retry.
      let value: ResourceTextWriteResult
      try { value = await fn.call(owner.source, scope, path, content, { expectedContent: condition.expectedContent }) }
      catch (error) {
        tickets.delete(condition.baselineId)
        if (start !== epoch || disposed) throw new ResourceDataError('write-outcome-unknown', 'Provider changed while write outcome was unresolved', true)
        throw normalize(error, true)
      }
      if (start !== epoch || disposed) throw new ResourceDataError('provider-changed', 'Write completed under an obsolete provider; reread before updating cache', true)
      tickets.delete(condition.baselineId)
      return { ...value, providerId: owner.id, providerEpoch: start, baselineId: issue(scope, path, content, owner.id, start) }
    },
    async readDiff(scope: SessionScope, ref: WorktreeRef, opts?: ResourceDataOptions): Promise<ResourceStrictDiff & ResourceProviderMetadata> {
      if (!ref || ref.kind !== 'worktree' || typeof ref.staged !== 'boolean') fail('invalid-scope', 'Only worktree comparisons are supported')
      if (scope.repoRoot !== undefined && ref.repoRoot !== undefined && scope.repoRoot !== ref.repoRoot) fail('invalid-scope', 'Scope and ref repoRoot disagree')
      const owner = resolveDiff(scope, opts?.authority)
      const fn = requireMethod(owner, 'readStrictDiff')
      const result = await read(owner, opts?.signal, signal => fn.call(owner.source, scope, ref, { signal }))
      if (result.providerEpoch !== epoch || disposed) fail('provider-changed', 'Provider changed during strict comparison')
      if (result.requestedSide !== (ref.staged ? 'staged' : 'unstaged')) fail('invalid-scope', 'Provider returned a different comparison side')
      if (typeof result.patch !== 'string' || typeof result.empty !== 'boolean' || typeof result.binary !== 'boolean' || typeof result.truncated !== 'boolean' || !Array.isArray(result.files)) fail('unavailable', 'Provider returned malformed strict comparison data')
      return result
    },
    getResourceCapabilities(scope: SessionScope, opts?: ResourceAuthorityOptions): ResourceCapabilities {
      const result: ResourceCapabilities = { condition: 'content', limitsSource: options.limits ? 'configured' : 'default', byteLimit: textLimit, patchByteLimit: patchLimit, strictSides: true, authorityRequired: true, providerEpoch: epoch, readText: false, writeText: false, readDiff: false }
      try {
        const owner = resolveDocument(scope, opts?.authority)
        result.documentProviderId = owner.id
        result.readText = typeof owner.source.readText === 'function'
        result.writeText = typeof owner.source.writeText === 'function'
        if (!result.readText || !result.writeText) result.documentError = 'unsupported-provider'
      } catch (error) { const failure = normalize(error); result.documentError = failure.code; result.documentErrorReason = failure.reason }
      try {
        const owner = resolveDiff(scope, opts?.authority)
        result.gitProviderId = owner.id
        result.readDiff = typeof owner.source.readStrictDiff === 'function'
        if (!result.readDiff) result.diffError = 'unsupported-provider'
      } catch (error) { const failure = normalize(error); result.diffError = failure.code; result.diffErrorReason = failure.reason }
      result.providerEpoch = epoch
      return result
    },
    dispose() {
      if (disposed) return
      disposed = true; changed(); documents.clear(); unsubscribe?.()
    },
  }
}
export type ResourceDataService = ReturnType<typeof createResourceDataService>
