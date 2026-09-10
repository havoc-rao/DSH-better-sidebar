/**
 * The git surfaces' DATA SOURCE slot (feature `'gitSource'`): the seam
 * through which a plugin (e.g. dsh-remote) can take over every git read
 * AND mutation the built-in surfaces perform for the sessions it owns —
 * the GitView panel, the explorer's git-status decorations and the diff
 * tabs — by implementing the full host `git.*` route surface
 * (see docs/plans/2026-09-10-git-source-slot-design.md).
 *
 * Contract in one sentence: a git surface resolves its data source
 * through the registry — the FIRST provider whose `match` accepts the
 * (session, cwd) pair hands back a {@link GitDataSource}, and every
 * `api.gitX(...)` call on that surface becomes `source.gitX(...)` with
 * no other change. No provider matches (or none is registered) → the
 * surface keeps the local host `git.*` routes, byte for byte.
 *
 * The data source is a SHADOW of the host api's git methods: each method
 * mirrors the corresponding `/sidebar/api` `git.*` route's client
 * signature and return shape exactly — `api` itself is structurally a
 * `GitDataSource`, so a consumer falls back with a one-liner
 * (`useGitSource(...) ?? api`), and a provider implementation is a
 * near-copy of the api surface against its own git (e.g. a remote host).
 *
 * Coverage: every method the built-in surfaces actually call is
 * declared here — GitView (status / worktrees / branch / branch-status /
 * branch-tips / log-graph / fetch / stage / unstage / commit / checkout /
 * discard / revert / cherry-pick), explorer decorations (status) and the
 * diff tabs (status / diff / commit-diff). `git.commit-draft` (the AI
 * draft — a host one-shot agent concern, not repository data) and
 * `git.log` (no client call site) deliberately stay host-only.
 *
 * Resolution is pure and throwing-safe, mirroring file-tree-source.ts /
 * terminal-source.ts: providers are consulted in registration order —
 * FIRST match wins, later registrations never shadow an earlier one. A
 * provider whose `match` throws is skipped (console.error); a matched
 * provider whose `createSource` throws — or deliberately returns
 * `undefined` (a per-session refusal) — is skipped too and the next
 * provider gets its turn. No match → `undefined` = the default host
 * route path.
 *
 * Change semantics: host surfaces already poll (GitView's 2s silent
 * poll) and ride the shared git-status change bus (stage/commit/discard
 * bumps); the optional `subscribe` on the data source is the provider's
 * PUSH channel on top — a provider that knows the repo changed (e.g.
 * external remote mutations) bumps the listener and every mounted
 * consumer refreshes immediately.
 */
import { useEffect, useMemo, useReducer } from 'react'
import type { Context } from '../context-types.ts'
import type {
  GitBranchStatus,
  GitBranchTip,
  GitGraphEntry,
  GitStatusResult,
  GitWorktree,
  SessionScope,
} from './api.ts'

/** The result shape of every git mutation (mirror of the host routes' `{ ok: true }`). */
export interface GitOkResult {
  ok: true
}

/**
 * One provider session's complete git data surface. Every method mirrors
 * the host `api.git*` function it replaces — same arguments, same return
 * shape — so consumers swap `api.gitX(scope, …)` for `source.gitX(scope, …)`
 * with no adapter. `scope` arrives VERBATIM (session id + cwd + the optional
 * `repoRoot` the git panel pinned via chooseRepo); no path conversion
 * happens on the host side — remote semantics are the provider's business.
 */
export interface GitDataSource {
  /** One status snapshot (`git.status`), a linked-worktree checkout when
   *  `worktree` is given. */
  gitStatus(scope: SessionScope, worktree?: string, signal?: AbortSignal): Promise<GitStatusResult>
  /** The linked checkouts of the repository (`git.worktrees`). */
  gitWorktrees(scope: SessionScope, signal?: AbortSignal): Promise<GitWorktree[]>
  /** The current branch + every local branch name (`git.branch`). */
  gitBranch(scope: SessionScope, worktree?: string, signal?: AbortSignal): Promise<{ current: string; names: string[] }>
  /** The current branch's upstream relationship (`git.branch-status`). */
  gitBranchStatus(scope: SessionScope, worktree?: string, signal?: AbortSignal): Promise<GitBranchStatus>
  /** Watched branches' tips relative to the checkout HEAD (`git.branch-tips`). */
  gitBranchTips(scope: SessionScope, branches: readonly string[], worktree?: string, signal?: AbortSignal): Promise<{ tips: GitBranchTip[] }>
  /** History rows with parent hashes, lazily pageable (`git.log-graph`). */
  gitLogGraph(scope: SessionScope, count?: number, skip?: number, worktree?: string, signal?: AbortSignal): Promise<GitGraphEntry[]>
  /** One path's unified diff, staged or not (`git.diff`; path undefined =
   *  the whole working tree). */
  gitDiff(scope: SessionScope, path: string | undefined, staged: boolean, worktree?: string, signal?: AbortSignal): Promise<{ diff: string }>
  /** One commit's full patch (`git.commit-diff`). */
  gitCommitDiff(scope: SessionScope, hash: string, worktree?: string, signal?: AbortSignal): Promise<{ diff: string }>
  /** Stage one path — or everything when `path` is undefined (`git.stage`). */
  gitStage(scope: SessionScope, path?: string, worktree?: string): Promise<GitOkResult>
  /** Unstage one path — or everything when `path` is undefined (`git.unstage`). */
  gitUnstage(scope: SessionScope, path?: string, worktree?: string): Promise<GitOkResult>
  /** Commit the staged changes (`git.commit`). */
  gitCommit(scope: SessionScope, message: string, worktree?: string): Promise<GitOkResult>
  /** Check out another branch (`git.checkout`). */
  gitCheckout(scope: SessionScope, branch: string, worktree?: string): Promise<GitOkResult>
  /** Fetch remote refs, optionally `--prune` (`git.fetch`); rejects with
   *  the `git-no-remote` wire code when the repository has no remote. */
  gitFetch(scope: SessionScope, worktree?: string, prune?: boolean, signal?: AbortSignal): Promise<GitOkResult>
  /** Discard the worktree changes of one file (`git.discard`). */
  gitDiscard(scope: SessionScope, path: string, worktree?: string): Promise<GitOkResult>
  /** Revert one commit onto the current branch (`git.revert`). */
  gitRevert(scope: SessionScope, hash: string, worktree?: string): Promise<GitOkResult>
  /** Cherry-pick one commit onto the current branch (`git.cherry-pick`). */
  gitCherryPick(scope: SessionScope, hash: string, worktree?: string): Promise<GitOkResult>
  /** Provider-PUSH change channel (optional): the provider bumps the
   *  listener whenever the repository state may have changed outside the
   *  host surfaces (e.g. external remote mutations), and every mounted
   *  consumer refreshes immediately. Absent → the host keeps its own
   *  polling / shared-bus semantics only. Returns a disposer. */
  subscribe?(listener: () => void): () => void
}

/**
 * One registered git source provider (the registration descriptor).
 * Register through `ctx.betterSidebar.registerGitProvider` — returns a
 * disposer (Cordis `ctx.effect` HMR-safe), duplicate ids throw. The
 * provider owns every git surface of the sessions its `match` accepts;
 * sessions no provider matches keep the host `git.*` routes byte for
 * byte.
 */
export interface GitProviderDescriptor {
  /** Unique id (package-prefixed, e.g. 'dsh-remote'). Registering a
   *  duplicate id throws. */
  id: string
  /** Session predicate: does this provider own the given session's git
   *  surfaces? First match wins, consulted in registration order. Both
   *  arguments arrive VERBATIM (no path/session conversion happens on
   *  the host side):
   *  - `sessionId`: the session the surface belongs to (a diff tab
   *    resolves against the session that opened it);
   *  - `cwd`: the session working directory when known (for a remote
   *    provider this is the local mirror path — the provider maps it to
   *    its own remote semantics internally).
   *  A throwing `match` skips this provider (console.error). */
  match(sessionId: string, cwd: string | undefined): boolean
  /** Factory for one session's live git data source. Returning undefined
   *  REFUSES the takeover (the next provider gets its turn — the
   *  per-session escape hatch); throwing is treated the same way. Keep
   *  it cheap and side-effect-free: it may be invoked by every resolving
   *  surface; returning a stable instance (cached per session) is the
   *  recommended shape. */
  createSource(sessionId: string, cwd: string | undefined): GitDataSource | undefined
}

/**
 * Resolve the git data source of one session against a provider list
 * (registration order; first `match` whose `createSource` returns a
 * source wins). Throwing `match` / `createSource` and an explicit
 * `undefined` factory result skip that provider; no match resolves
 * `undefined` — the caller then uses the default local host `git.*`
 * routes (byte for byte the historical behavior). Pure: no React, no
 * registry access, fully unit-testable.
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
 * The render-side resolver hook: the git data source of one session, or
 * undefined for the default local host routes. Live: re-resolves when
 * the provider registry changes (a provider registers/unregisters while
 * a surface is mounted — e.g. a plugin activates after the panel
 * exists) and when the session/cwd changes. Registry-less service stubs
 * (tests, hosts without the full service) degrade to the host path — a
 * stub must never break a git surface.
 */
export function useGitSource(
  ctx: Context | undefined,
  sessionId: string,
  cwd: string | undefined,
): GitDataSource | undefined {
  const service = ctx?.betterSidebar
  // The tick is the SUBSCRIPTION state (same pattern as useFileTreeSource
  // / useTerminalTransport): the reducer's dispatch (`force`) is stable,
  // so the memo below must depend on the tick itself — otherwise a
  // registry notification re-renders the surface but never re-resolves
  // the source, and a provider registering after the panel exists would
  // never take over the visible surfaces.
  const [tick, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (service === undefined) return
    const offs: Array<() => void> = []
    try { offs.push(service.subscribe(force)) } catch { /* registry-less stub */ }
    return () => { for (const off of offs) off() }
  }, [service, force])
  return useMemo(() => {
    if (service === undefined) return undefined
    try {
      return resolveGitSource(service.getGitProviders(), sessionId, cwd)
    } catch {
      // A registry-less / partial service stub must not break the surface.
      return undefined
    }
  }, [service, sessionId, cwd, tick])
}