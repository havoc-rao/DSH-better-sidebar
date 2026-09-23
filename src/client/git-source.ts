/**
 * The git data-face slot (feature `'gitSource'`): the seam through which a
 * plugin (e.g. dsh-remote-workbench) can take over the git READ AND
 * MUTATION surface of the sessions it matches — the changes tab's Git lens
 * routes every `api.git*` call through the resolved GitDataSource, a
 * shadow of the host `git.*` route surface (same signatures verbatim).
 * Resolution is registration-order, FIRST match wins and throwing-safe: a
 * provider whose `match` throws is skipped (console.error); a matched
 * provider whose `createSource` throws — or deliberately returns
 * `undefined` (a per-session refusal) — is skipped too and the next
 * provider gets its turn. No match (or none registered) → the lenses keep
 * their local host routes byte for byte.
 */
import { useEffect, useMemo, useReducer } from 'react'
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
 * matches keep the local host routes byte for byte.
 */
export interface GitDataSource {
  gitStatus(scope: SessionScope, worktree?: string, signal?: AbortSignal): Promise<GitStatusResult>
  gitWorktrees(scope: SessionScope, signal?: AbortSignal): Promise<GitWorktree[]>
  gitBranch(scope: SessionScope, worktree?: string, signal?: AbortSignal): Promise<{ current: string; names: string[] }>
  gitLog(scope: SessionScope, count?: number, skip?: number, worktree?: string, options?: GitLogOptions, signal?: AbortSignal): Promise<GitLogPage | GitLogEntry[]>
  gitDiff(scope: SessionScope, path: string | undefined, staged: boolean, worktree?: string, signal?: AbortSignal): Promise<{ diff: string }>
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