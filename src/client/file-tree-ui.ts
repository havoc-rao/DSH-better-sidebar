/**
 * Optional fileTreeUi v2 client-service seat (provider: dsh-file-tree-ui).
 *
 * v2 = tree-FRAMEWORK ownership: the provider renders the whole file tree
 * (container/subtree lists, indent guides + hover seat, chevron + fold
 * interaction and animations, row chrome slots, drop visuals) from
 * `FileTreeRowModel` inputs; this plugin keeps building the row models,
 * injecting row content and owning all expansion state data (per-row
 * `expanded` + `onToggle`) and DnD/context-menu business.
 *
 * Collaboration surface (per the provider's contract):
 * - the service name `'fileTreeUi'` and protocol version `2` are a
 *   documented STRING protocol — cross-plugin runtime values cannot be
 *   value-imported (the client-bundle purity gate forbids value-importing
 *   the provider package, incl. `./client` / `./client-contract`); provider
 *   and consumer each hold their own literals. Only the contract TYPES
 *   cross the boundary (`import type … from 'dsh-file-tree-ui/client-contract'`,
 *   erased at build — never reaches the purity gate);
 * - the service is OPTIONAL: it is never declared in this plugin's cordis
 *   `inject` array (a hard injection would fail the whole page when the
 *   provider is absent). The seat is a snapshot/subscribe pair — the
 *   snapshot re-reads `ctx.get('fileTreeUi')` on every call (no handle is
 *   cached across fiber activations; provider unload flips the snapshot
 *   back to undefined) and the readonly `internal/service` bus fires on
 *   every provide/unload change;
 * - missing / protocol-mismatched / unloaded values resolve to undefined
 *   and the diagnostic warns exactly once per degraded episode (a later
 *   valid read re-arms the warning). The consumer MUST fall back to its own
 *   rendering in that case — never white screen.
 */
import { useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import type { FileTreeUiServiceV2 } from 'dsh-file-tree-ui/client-contract'

/** The fileTreeUi v2 SERVICE NAME — documented string protocol (see header). */
export const FILE_TREE_UI_SERVICE = 'fileTreeUi' as const

/** The v2 protocol version of the fileTreeUi service — documented literal
 *  held by both sides (v2 = whole-tree framework ownership, see header). */
export const FILE_TREE_UI_PROTOCOL_VERSION = 2 as const

/** The consumer-side diagnostic text (the provider contract header recipe,
 *  Chinese, one-shot per degraded episode to avoid console spam). */
const FILE_TREE_UI_DIAGNOSTIC = '[dsh-file-tree-ui] 服务缺失或协议不兼容：'
  + `fileTreeUi 应为 v${FILE_TREE_UI_PROTOCOL_VERSION}（renderFileTree/`
  + 'renderRowMenu 均为函数）；当前值将被忽略并回退本地渲染。'

/**
 * Hand-written shape check of the optional fileTreeUi service (the
 * consumer-side diagnostic recipe from the provider's contract header).
 * Returns undefined for missing / null / wrong-version / partial values —
 * the caller then falls back to its local rendering and must not white
 * screen. No runtime import of the provider package happens here.
 * @param value - the raw `ctx.get('fileTreeUi')` value.
 * @returns the v2 service, or undefined when absent/incompatible.
 */
export function resolveFileTreeUiServiceV2(value: unknown): FileTreeUiServiceV2 | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<FileTreeUiServiceV2>
  if (candidate.protocolVersion !== FILE_TREE_UI_PROTOCOL_VERSION
    || typeof candidate.renderFileTree !== 'function'
    || typeof candidate.renderRowMenu !== 'function') {
    return undefined
  }
  return candidate as FileTreeUiServiceV2
}

/**
 * The module-level seat: one snapshot per render pass, re-read from the
 * live ctx on every call (never cached across activations), plus the
 * `internal/service` subscription that fires on provide/unload changes.
 * The client root Context is shared by every client plugin, so a single
 * seat holds for the whole page; `installFileTreeUiSeat` re-binds it on
 * each fiber activation (hot reload re-runs apply).
 */
let seatGetSnapshot: () => FileTreeUiServiceV2 | undefined = () => undefined
let seatSubscribe: (listener: () => void) => () => void = () => () => {}
/** Warn-once per degraded episode; a valid read re-arms the warning. */
let degraded = false

function readFileTreeUi(get: () => unknown): FileTreeUiServiceV2 | undefined {
  const resolved = resolveFileTreeUiServiceV2(get())
  if (resolved !== undefined) {
    degraded = false
    return resolved
  }
  if (!degraded) {
    degraded = true
    console.warn(FILE_TREE_UI_DIAGNOSTIC)
  }
  return undefined
}

/**
 * Bind (or unbind — `ctx === null`) the optional fileTreeUi seat to the
 * current client root Context. Called once per apply() activation; the
 * effect cleanup re-installs a null seat so a disposed fiber can never
 * keep serving a stale context.
 * @param ctx - the client root Context, or null to uninstall.
 */
export function installFileTreeUiSeat(ctx: Context | null): void {
  if (ctx === null) {
    seatGetSnapshot = () => undefined
    seatSubscribe = () => () => {}
    return
  }
  seatGetSnapshot = () => readFileTreeUi(() => ctx.get(FILE_TREE_UI_SERVICE))
  seatSubscribe = listener => ctx.on('internal/service', listener)
}

/**
 * The v2 service snapshot for the current render: the live service when
 * present and protocol-compatible (the tree renders through the provider's
 * FileTree framework), undefined when missing/mismatched/unloaded (the
 * component falls back to its own rendering). The `internal/service`
 * subscription re-renders the consumer on provide/unload changes.
 */
export function useFileTreeUi(): FileTreeUiServiceV2 | undefined {
  return useSyncExternalStore(seatSubscribe, seatGetSnapshot, seatGetSnapshot)
}