/**
 * The git data-face slot (feature `'gitSource'`): the seam through which a
 * plugin (e.g. dsh-remote-workbench) can take over the git READ AND
 * MUTATION surface of the sessions it matches — the changes tab's Git lens,
 * the diff preview pane, the dedicated diff tab and the diff fold expansion
 * all route every `api.git*` call through the resolved GitDataSource, a
 * shadow of the host `git.*` route surface (same signatures verbatim).
 * Resolution is registration-order, FIRST match wins and throwing-safe: a
 * provider whose `match` throws is skipped (console.error); a matched
 * provider whose `createSource` throws — or deliberately returns
 * `undefined` (a per-session refusal) — is skipped too and the next
 * provider gets its turn. No match (or none registered) → the lenses keep
 * their local host routes byte for byte. The ctx-less diff tab reaches the
 * registry through the module-level {@link bindGitSourceSeat} seat
 * (bound in the client root's apply; see {@link useGitSourceSeat}).
 */
import { useEffect, useMemo, useReducer, useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import type { GitLogEntry, GitLogOptions, GitLogPage, GitStatusResult, GitWorktree, SessionScope } from './api.ts'

/** A successful git mutation ({ok:true}, mirror of the host route's shape). */
export interface GitOkResult { ok: true }

/**
 * The git data source a matching provider hands to the git surfaces: a
 * shadow of the host `api.git*` route surface — every method has the host
 * signature and return shape VERBATIM, so a provider owns status/log/diff
 * reads and stage/unstage/commit/checkout/discard/revert/cherry-pick
 * mutations of the sessions its `match` accepts. Sessions no provider
 * matches keep the local host routes byte for byte. The read surfaces
 * (diff preview pane, dedicated diff tab) route PER METHOD: a matched
 * source that happens to lack one method falls back to the host route for
 * that method alone — a partial provider never breaks a preview.
 */
export interface GitDataSource {
  gitStatus(scope: SessionScope, worktree?: string, signal?: AbortSignal): Promise<GitStatusResult>
  gitWorktrees(scope: SessionScope, signal?: AbortSignal): Promise<GitWorktree[]>
  gitBranch(scope: SessionScope, worktree?: string, signal?: AbortSignal): Promise<{ current: string; names: string[] }>
  gitLog(scope: SessionScope, count?: number, skip?: number, worktree?: string, options?: GitLogOptions, signal?: AbortSignal): Promise<GitLogPage | GitLogEntry[]>
  gitDiff(scope: SessionScope, path: string | undefined, staged: boolean, worktree?: string, signal?: AbortSignal): Promise<{ diff: string }>
  /**
   * Full patch text of one commit (diff display for the history rows and the
   * changes pane's commit previews) — mirror of the host `git.commit-diff`
   * route.
   */
  gitCommitDiff(scope: SessionScope, hash: string, worktree?: string, signal?: AbortSignal): Promise<{ diff: string }>
  /**
   * One file's content at a revision (`git show <rev>:<path>`); null when the
   * revision has no such path. The diff views' on-demand hunk-fold expansion
   * reads both sides' full contents through this — mirror of the host
   * `git.show` route.
   */
  gitShow(scope: SessionScope, rev: string, path: string, worktree?: string, signal?: AbortSignal): Promise<{ content: string | null }>
  gitStage(scope: SessionScope, path?: string, worktree?: string): Promise<GitOkResult>
  gitUnstage(scope: SessionScope, path?: string, worktree?: string): Promise<GitOkResult>
  gitCommit(scope: SessionScope, message: string, worktree?: string): Promise<GitOkResult>
  gitCheckout(scope: SessionScope, branch: string, worktree?: string): Promise<GitOkResult>
  gitDiscard(scope: SessionScope, path: string, worktree?: string): Promise<GitOkResult>
  gitRevert(scope: SessionScope, hash: string, worktree?: string): Promise<GitOkResult>
  gitCherryPick(scope: SessionScope, hash: string, worktree?: string): Promise<GitOkResult>
}

/**
 * One registered git data source provider (the registration descriptor).
 * Register through `ctx.betterSidebar.registerGitProvider` — returns a
 * disposer (Cordis `ctx.effect` HMR-safe); duplicate ids throw (the
 * service layer owns that guard).
 */
export interface GitProviderDescriptor {
  /** Unique id (package-prefixed, e.g. 'dsh-remote-workbench'). Registering
   *  a duplicate id throws. */
  id: string
  /** Session predicate: does this provider own the given session's git
   *  surface? First match wins, consulted in registration order; both
   *  arguments arrive VERBATIM. A throwing `match` skips this provider
   *  (console.error). */
  match(sessionId: string, cwd: string | undefined): boolean
  /** Factory for the data source of a matching session. Returning
   *  undefined REFUSES the takeover (the next provider gets its turn — the
   *  per-session escape hatch); throwing is treated the same way. Keep it
   *  cheap: it is invoked per resolving render of the git lens, and
   *  returning a stable instance (a module-level source or one cached per
   *  session) is the recommended shape. */
  createSource(sessionId: string, cwd: string | undefined): GitDataSource | undefined
}

/**
 * Resolve the git data source of one session against a provider list
 * (registration order; first `match` whose `createSource` returns a
 * source wins). Throwing `match` / `createSource` and an explicit
 * `undefined` factory result skip that provider; no match resolves
 * `undefined` — the caller then keeps the local host `api.git*` routes
 * byte for byte. Pure: no React, no registry access, fully unit-testable.
 */
export function resolveGitSource(
  providers: readonly GitProviderDescriptor[],
  sessionId: string,
  cwd: string | undefined,
): GitDataSource | undefined {
  for (const provider of providers) {
    let matched = false
    try {
      matched = provider.match(sessionId, cwd) === true
    } catch (error) {
      console.error('[dsh-better-sidebar] git provider match error:', error)
      continue
    }
    if (!matched) continue
    try {
      const source = provider.createSource(sessionId, cwd)
      if (source === undefined) continue
      return source
    } catch (error) {
      console.error('[dsh-better-sidebar] git provider createSource error:', error)
      continue
    }
  }
  return undefined
}

/**
 * The render-side resolver hook: the git data source the given scope's git
 * surfaces should route through, or undefined for the local host routes.
 * Live: re-resolves when the provider registry changes (a provider
 * registers/unregisters while the lens is mounted) and when the scope's
 * session/cwd/repoRoot change. A scope-less mount (`sessionId` undefined)
 * always resolves undefined: a provider takeover requires a session.
 * Registry-less service stubs (tests, hosts without the full service)
 * degrade to the local routes — a stub must never break the git lenses.
 */
export function useGitSource(ctx: Context | undefined, scope: SessionScope | undefined): GitDataSource | undefined {
  const service = ctx?.betterSidebar
  // The tick is the SUBSCRIPTION state (same pattern as
  // useTerminalTransport): the reducer's dispatch (`force`) is stable, so
  // the memo below must depend on the tick itself — otherwise a registry
  // notification re-renders the lens but never re-resolves the source.
  const [tick, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (service === undefined) return
    const offs: Array<() => void> = []
    try { offs.push(service.subscribe(force)) } catch { /* registry-less stub */ }
    return () => { for (const off of offs) off() }
  }, [service, force])
  return useMemo(() => {
    // No registry — or no session to resolve against — means the local
    // host routes; a provider takeover always requires a session.
    if (service === undefined || scope?.sessionId === undefined) return undefined
    const { sessionId, cwd } = scope
    try {
      return resolveGitSource(service.getGitProviders(), sessionId, cwd)
    } catch {
      // A registry-less / partial service stub must not break the lenses.
      return undefined
    }
  }, [service, scope?.sessionId, scope?.cwd, scope?.repoRoot, tick])
}

/**
 * The git-source client Context seat (mirror of the git-lens-graph seat):
 * the dedicated diff tab is mounted from an `openTab` seed that carries only
 * `{ sessionId, cwd, diff }` — NO Context prop — so it cannot call the
 * ctx-based {@link useGitSource} hook. The seat binds the live client root
 * Context once per apply() activation (hot reload re-runs apply) and serves
 * the CURRENT provider list as a `useSyncExternalStore` snapshot; a consumer
 * re-resolves through {@link resolveGitSource} against its own scope —
 * `undefined` keeps the local host routes byte for byte, exactly the
 * {@link useGitSource} semantics. The snapshot is read LIVE through the
 * bound Context on every call (never cached across fiber activations) and
 * the subscription fires on BOTH the cordis `internal/service` bus
 * (betterSidebar provide/unload) and the registry service's own
 * notifications (provider register/unregister), so a provider landing while
 * a diff tab is open re-renders the tab through the new source.
 */
let seatGetSnapshot: () => readonly GitProviderDescriptor[] | undefined = () => undefined
let seatSubscribe: (listener: () => void) => () => void = () => () => {}

/** The registry read, throwing-safe: a partial/absent service stub must
 *  resolve undefined (the local host routes), never throw into the seat. */
function readSeatProviders(getService: () => unknown): readonly GitProviderDescriptor[] | undefined {
  let service: unknown
  try { service = getService() } catch { return undefined }
  if (service === null || typeof service !== 'object') return undefined
  const getProviders = (service as { getGitProviders?: () => readonly GitProviderDescriptor[] }).getGitProviders
  if (typeof getProviders !== 'function') return undefined
  try { return getProviders.call(service) } catch { return undefined }
}

/**
 * Bind (or unbind — `ctx === null`) the git-source seat to the current
 * client root Context, so the ctx-less diff tab can resolve the provider
 * registry. Called once per apply() activation; the effect cleanup unbinds
 * so a disposed fiber can never keep serving a stale context.
 * @param ctx - the client root Context, or null to uninstall.
 */
export function bindGitSourceSeat(ctx: Context | null): void {
  if (ctx === null) {
    seatGetSnapshot = () => undefined
    seatSubscribe = () => () => {}
    return
  }
  // One cached value per notification cycle: useSyncExternalStore compares
  // snapshots by identity, and the registry hands out a fresh array per
  // call — every read between registry changes must return the SAME array
  // (a fresh identity per read would re-render forever).
  let cached: readonly GitProviderDescriptor[] | undefined
  let cacheValid = false
  const read = (): readonly GitProviderDescriptor[] | undefined => {
    if (!cacheValid) {
      cached = readSeatProviders(() => ctx.get('betterSidebar'))
      cacheValid = true
    }
    return cached
  }
  seatGetSnapshot = read
  seatSubscribe = (listener) => {
    const offs: Array<() => void> = []
    // Invalidate BEFORE notifying: listeners re-read through getSnapshot,
    // and a stale cache would serve the pre-change provider list.
    const notify = (): void => { cacheValid = false; listener() }
    // The cordis service bus fires on betterSidebar provide/unload (e.g. an
    // external reload re-provides the registry service).
    try { offs.push(ctx.on('internal/service', notify)) } catch { /* registry-less stub */ }
    // Provider register/unregister fires the registry service's OWN
    // subscription — a betterSidebar-internal event, not a cordis provide.
    try {
      const service = ctx.get('betterSidebar') as { subscribe?: (listener: () => void) => () => void } | undefined
      if (service?.subscribe !== undefined) offs.push(service.subscribe(notify))
    } catch { /* registry-less stub */ }
    return () => { for (const off of offs) off() }
  }
}

/** Unbind the seat (dispose path; equivalent to `bindGitSourceSeat(null)`). */
export function unbindGitSourceSeat(): void {
  bindGitSourceSeat(null)
}

/**
 * The current provider list for the render: the registered providers in
 * registration order, or undefined when no registry service is reachable
 * (consumers then keep the local host routes byte for byte). Live: the seat
 * subscription re-renders the consumer on provider register/unregister and
 * on betterSidebar provide/unload.
 */
export function useGitSourceSeat(): readonly GitProviderDescriptor[] | undefined {
  return useSyncExternalStore(seatSubscribe, seatGetSnapshot, seatGetSnapshot)
}