/**
 * Optional gitGraph v1 client-service seat (provider: dsh-git-graph).
 *
 * v1 = GraphTree FRAMEWORK ownership: the provider draws the commit DAG
 * (lanes/edges), virtualizes the viewport and owns keyboard focus/selection
 * semantics from purely topological row models (`id` + real `parents`); this
 * plugin keeps building the rows (its own `api.gitLog` data), injecting each
 * row's whole content through the `renderRow` slot and owning all Git
 * business (preview, context menu, paging).
 *
 * Collaboration surface (per the provider's contract):
 * - the service name `'gitGraph'` and protocol version `1` are a
 *   documented STRING protocol — cross-plugin runtime values cannot be
 *   value-imported (the client-bundle purity gate forbids value-importing
 *   the provider package, incl. `./client` / `./client-contract`); provider
 *   and consumer each hold their own literals. Only the contract TYPES
 *   cross the boundary (`import type … from 'dsh-git-graph/client-contract'`,
 *   erased at build — never reaches the purity gate);
 * - the service is OPTIONAL: it is never declared in this plugin's cordis
 *   `inject` array (a hard injection would fail the whole page when the
 *   provider is absent). The seat is a snapshot/subscribe pair — the
 *   snapshot re-reads `ctx.get('gitGraph')` on every call (no handle is
 *   cached across fiber activations; provider unload flips the snapshot
 *   back to undefined) and the readonly `internal/service` bus fires on
 *   every provide/unload change;
 * - missing / protocol-mismatched / unloaded values resolve to undefined
 *   and the diagnostic warns exactly once per degraded episode (a later
 *   valid read re-arms the warning). The consumer MUST fall back to its own
 *   history list in that case — never white screen.
 */
import { useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import type { GitGraphServiceV1 } from 'dsh-git-graph/client-contract'

/** The gitGraph v1 SERVICE NAME — documented string protocol (see header). */
export const GIT_GRAPH_SERVICE = 'gitGraph' as const

/** The v1 protocol version of the gitGraph service — documented literal
 *  held by both sides (v1 = generic GraphTree framework, see header). */
export const GIT_GRAPH_PROTOCOL_VERSION = 1 as const

/** The consumer-side diagnostic text (the provider contract header recipe,
 *  Chinese, one-shot per degraded episode to avoid console spam). */
const GIT_GRAPH_DIAGNOSTIC = '[dsh-git-graph] 服务缺失或协议不兼容：'
  + `gitGraph 应为 v${GIT_GRAPH_PROTOCOL_VERSION}（GraphTree 为函数）；`
  + '当前值将被忽略并回退本地历史列表。'

/**
 * Hand-written shape check of the optional gitGraph service (the
 * consumer-side diagnostic recipe from the provider's contract header).
 * Returns undefined for missing / null / wrong-version / partial values —
 * the caller then falls back to its local history list and must not white
 * screen. No runtime import of the provider package happens here.
 * @param value - the raw `ctx.get('gitGraph')` value.
 * @returns the v1 service, or undefined when absent/incompatible.
 */
export function resolveGitGraphServiceV1(value: unknown): GitGraphServiceV1 | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<GitGraphServiceV1>
  if (candidate.protocolVersion !== GIT_GRAPH_PROTOCOL_VERSION
    || typeof candidate.GraphTree !== 'function') {
    return undefined
  }
  return candidate as GitGraphServiceV1
}

/** Warn-once per degraded episode; a valid read re-arms the warning. */
let degraded = false
/** The module-level seat: one snapshot per render pass, re-read from the
 *  live ctx on every call (never cached across activations), plus the
 *  `internal/service` subscription that fires on provide/unload changes.
 *  The client root Context is shared by every client plugin, so a single
 *  seat holds for the whole page; `bindGitGraph` re-binds it on each fiber
 *  activation (hot reload re-runs apply). */
let seatGetSnapshot: () => GitGraphServiceV1 | undefined = () => undefined
let seatSubscribe: (listener: () => void) => () => void = () => () => {}

function readGitGraph(get: () => unknown): GitGraphServiceV1 | undefined {
  const resolved = resolveGitGraphServiceV1(get())
  if (resolved !== undefined) {
    degraded = false
    return resolved
  }
  if (!degraded) {
    degraded = true
    console.warn(GIT_GRAPH_DIAGNOSTIC)
  }
  return undefined
}

/**
 * The gitGraph v1 service for the current render, read LIVE from the given
 * Context on every call — never cached across fiber activations. Returns
 * the service when present and protocol-compatible, undefined otherwise
 * (the caller falls back to its own history list). One-shot warning per
 * degraded episode; `bindGitGraph` re-reads through the same path.
 */
export function getGitGraphService(ctx: Context): GitGraphServiceV1 | undefined {
  return readGitGraph(() => ctx.get(GIT_GRAPH_SERVICE))
}

/**
 * Bind (or unbind — `ctx === null`) the optional gitGraph seat to the
 * current client root Context. Called once per apply() activation; the
 * effect cleanup unbinds so a disposed fiber can never keep serving a
 * stale context.
 * @param ctx - the client root Context, or null to uninstall.
 */
export function bindGitGraph(ctx: Context | null): void {
  if (ctx === null) {
    seatGetSnapshot = () => undefined
    seatSubscribe = () => () => {}
    return
  }
  seatGetSnapshot = () => readGitGraph(() => ctx.get(GIT_GRAPH_SERVICE))
  seatSubscribe = listener => ctx.on('internal/service', listener)
}

/** Unbind the seat (dispose path; equivalent to `bindGitGraph(null)`). */
export function unbindGitGraph(): void {
  bindGitGraph(null)
}

/**
 * The v1 service snapshot for the current render: the live service when
 * present and protocol-compatible (the history section renders through the
 * provider's GraphTree framework), undefined when missing/mismatched/
 * unloaded (the history section falls back to its own list). The
 * `internal/service` subscription re-renders the consumer on provide/unload
 * changes.
 */
export function useGitGraph(): GitGraphServiceV1 | undefined {
  return useSyncExternalStore(seatSubscribe, seatGetSnapshot, seatGetSnapshot)
}