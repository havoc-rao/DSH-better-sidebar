/**
 * The file tree's DATA SOURCE slot (feature `'fileTreeSource'`): the seam
 * through which a plugin (e.g. dsh-remote) can take over the explorer's
 * listings for the sessions it owns.
 *
 * Contract in one sentence: the tree defaults to the local host `fs.tree`
 * route; a plugin registers a provider (session predicate + `list`), the
 * first provider whose `match` accepts a session becomes that session's
 * data source, and every listing — the root and each expanded directory —
 * then runs through the provider's `list` instead. No path conversion
 * happens anywhere: `dir` reaches the provider verbatim (remote-absolute
 * semantics stay the provider's business), and the entries the provider
 * returns are rendered exactly like local rows.
 *
 * Refresh semantics ride the existing `refreshTick` mechanism unchanged:
 * a tick wipes the level cache and the visible set reloads through
 * WHATEVER source is currently resolved — local or provider.
 *
 * Multi-root (v0.18.0+): a provider may additionally declare `roots` — a
 * (possibly async) list of REMOTE starting points for a session. When any
 * matched provider's `roots` settles non-empty, the session's tree becomes
 * multi-root: the local cwd root stays present with FULL local semantics
 * (listings through the local fs.tree route — never taken over by any
 * provider), and each declared root renders as an extra expandable root row
 * whose listings run through that provider's `list`. Providers contribute
 * roots in registration order (same root id: the FIRST registration wins);
 * a throwing / rejecting `roots` skips that provider's contribution and
 * never breaks the tree. Sessions without roots keep the v0.17 single-root
 * resolution byte for byte.
 *
 * Local-only abilities degrade by declaration: a provider may opt into
 * `capabilities` (upload / download / search / git / openWith). Anything
 * not declared `true` is disabled for provider sessions (menu entries
 * hidden, drag-drop inert, git decorations off); local sessions keep every
 * ability unconditionally. In multi-root mode the LOCAL root keeps the
 * full local face unconditionally and each REMOTE root carries its own
 * provider's face. There is no per-flag opt-out needed — the default
 * degradation rule IS "absent means off".
 *
 * Resolution is pure and throwing-safe: a provider whose `match` or
 * `createSource` throws is skipped (console.error), never allowed to break
 * the tree. Providers are consulted in registration order — FIRST match
 * wins; later registrations never shadow an earlier one, and no match
 * falls through to the local host.
 */
import { useEffect, useMemo, useReducer, useState } from 'react'
import type { Context } from '../context-types.ts'
import type { FsEntry } from './api.ts'

/**
 * One explorer row as a data source reports it.
 *
 * Compared with the local host's `FsEntry`, three fields are cosmetic /
 * stat-derived — `hidden` (dotfile dimming), `isSymlink` (the link badge)
 * and `broken` (a dangling link) — and therefore OPTIONAL here: a remote
 * provider that cannot cheaply derive them omits them and the tree
 * defaults each to `false`. `name` / `path` / `isDir` are the only
 * semantically loaded fields and are always required. There are no
 * git-specific or inode-like fields in the row shape — git decorations
 * ride the separate `gitStatus` overlay, which providers gate through
 * `capabilities.git` instead.
 *
 * v0.20.0: `meta` — optional stat detail (file size / mtime) rendered as
 * a dimmed row suffix when present. The local host's fs.tree never sets
 * it, so local rows stay byte-for-byte identical.
 */
export interface FileTreeEntry {
  name: string
  path: string
  isDir: boolean
  hidden?: boolean
  isSymlink?: boolean
  broken?: boolean
  /** Optional stat detail (v0.20.0): a dimmed size/mtime suffix. */
  meta?: {
    /** Byte size (files); absent → no size shown. */
    size?: number
    /** Last-modified epoch millis; absent → no time shown. */
    mtime?: number
  }
}

/** One directory listing (or its failure), mirror of the host fs.tree shape. */
export type FileTreeListResult =
  | { entries: readonly FileTreeEntry[]; truncated?: boolean }
  | { error: string }

/** One global file-name search (v0.17.0+; mirror of the host fs.search
 *  contract: matches are cwd-relative '/'-separated paths). */
export type FileTreeSearchResult =
  | { matches: string[]; truncated?: boolean }
  | { error: string }

/**
 * The local-only abilities a provider may keep available in provider mode.
 * Absent / `false` = the ability is DEGRADED OFF for provider sessions
 * (the tree hides the entry / makes the surface inert); `true` = the
 * provider implements it itself. Local sessions ignore this table entirely.
 */
export interface FileTreeProviderCapabilities {
  /** Drag-drop + "upload here" + the panel's upload pickers. Default off. */
  upload?: boolean
  /** The file context-menu download (local host file route). Default off. */
  download?: boolean
  /** Git status decorations / footer (a provider-fed overlay). Default off.
   *  Declaring it turns decorations ON for provider sessions — the DATA
   *  then comes from the git data-source slot (feature `'gitSource'`,
   *  v0.23.0+): a registered git provider's status snapshot for the
   *  session feeds the overlay (see `git-source.ts`). Without a matching
   *  git provider the overlay has no source and the tree stays clean. */
  git?: boolean
  /** The "open with" external-target section. Default off. */
  openWith?: boolean
  /** The global file-name search box (provider `search()`). Default off. */
  search?: boolean
  /** File-row clicks / Enter / Space open through the provider's `open(path)`
   *  (v0.20.0) — the provider owns the open action for paths under its
   *  data. Default off: without it the tree runs the caller's original
   *  `onOpenFile(path)` path, byte for byte. */
  open?: boolean
}

/**
 * The live data source of one provider session. `createSource` may be
 * invoked repeatedly (once per resolving surface per session); keep it
 * cheap and side-effect-free — a pure fetcher factory.
 */
export interface FileTreeDataSource {
  /** List one absolute directory's entries, remote semantics verbatim. */
  list(dir: string): Promise<FileTreeListResult>
  /** Global file-name search; only consulted when `capabilities.search`
   *  is declared — a provider declaring search must provide this. */
  search?(query: string, signal?: AbortSignal): Promise<FileTreeSearchResult>
  /** Open one remote path (v0.20.0): the open DELEGATE for file rows when
   *  `capabilities.open` is declared — the tree calls `open(path)` instead
   *  of the caller's `onOpenFile(path)`. Without the declared capability or
   *  this function the tree keeps its original `onOpenFile` path. */
  open?(path: string): void
  /**
   * Map one row path to the path the explorer's @-reference should insert
   * (v0.21.0): a provider whose rows carry remote-absolute paths returns
   * the LOCAL path the session can actually read (e.g. the session cwd
   * joined with the path's relative part — a remote workspace's local
   * mirror). Both directions of path conversion are the provider's
   * business (same philosophy as the rest of this seam: no path
   * conversion happens on the host side); the tree only ever consults
   * this on the pill call sites, and it must be synchronous and cheap.
   * A `reference` that throws degrades to the row path verbatim. Absent →
   * the row path is inserted verbatim — byte-for-byte the local behavior.
   */
  reference?(path: string): string
}

/**
 * One REMOTE starting point a provider declares for a session (v0.18.0+,
 * multi-root mode). `dir` is the root's ABSOLUTE path under remote
 * semantics — never converted to a local path; every expansion under it
 * calls the providing provider's `list(dir)`.
 */
export interface FileTreeProviderRoot {
  /** Unique root id; when multiple providers declare the same id, the
   *  FIRST registration (in registration order) wins. */
  id: string
  /** The row label shown in the tree's root list. */
  label: string
  /** The root's absolute path (remote semantics verbatim). */
  dir: string
}

/**
 * One registered file tree provider (the registration descriptor).
 * Register through `ctx.betterSidebar.registerFileTreeProvider` — returns
 * a disposer (Cordis `ctx.effect` HMR-safe), duplicate ids throw.
 */
export interface FileTreeProviderDescriptor {
  /** Unique id (package-prefixed, e.g. 'dsh-remote'). */
  id: string
  /** Session predicate: does this provider own the given session's tree?
   *  `cwd` is the session working directory when known. First match wins. */
  match(sessionId: string, cwd: string | undefined): boolean
  /** Factory for one session's live data source (see FileTreeDataSource). */
  createSource(sessionId: string, cwd: string | undefined): FileTreeDataSource
  /**
   * Multi-root declarations (v0.18.0+): when `match` accepts the session
   * and this settles to a NON-EMPTY array, the session's tree becomes
   * multi-root — the local cwd root stays present with full local
   * semantics, and each returned root renders as an additional expandable
   * root row browsed through this provider's `list`. Multiple providers'
   * roots merge in registration order (same root id: first registration
   * wins). A throwing / rejecting `roots` skips this provider's
   * contribution; an absent or empty result keeps the v0.17 single-root
   * behavior byte for byte. Keep it cheap and side-effect-free — it may be
   * invoked by every resolving surface (same guidance as `createSource`).
   */
  roots?(sessionId: string, cwd: string | undefined): FileTreeProviderRoot[] | Promise<FileTreeProviderRoot[]>
  /** The supported local abilities (absent = all off; see
   *  {@link FileTreeProviderCapabilities}). */
  capabilities?: FileTreeProviderCapabilities
}

/** One resolved provider session: the live source plus its capability face. */
export interface ResolvedFileTreeSource {
  providerId: string
  source: FileTreeDataSource
  capabilities: FileTreeProviderCapabilities
}

/**
 * One RESOLVED remote root (v0.18.0+, multi-root mode): a provider's raw
 * `FileTreeProviderRoot` triple bound to the live source that serves its
 * listings — `source.list(dir)` runs under this root, and `capabilities`
 * are the root's own degradation face (local root keeps the full face).
 */
export interface ResolvedFileTreeRoot {
  id: string
  label: string
  dir: string
  providerId: string
  source: FileTreeDataSource
  capabilities: FileTreeProviderCapabilities
}

/**
 * Resolve the data source of one session against a provider list
 * (registration order; first `match` wins). Throwing `match` /
 * `createSource` skip that provider; no match resolves `undefined` — the
 * caller then uses the default local host source. Pure: no React, no
 * registry access, fully unit-testable.
 */
export function resolveFileTreeSource(
  providers: readonly FileTreeProviderDescriptor[],
  sessionId: string,
  cwd: string | undefined,
): ResolvedFileTreeSource | undefined {
  for (const provider of providers) {
    let matched = false
    try {
      matched = provider.match(sessionId, cwd) === true
    } catch (error) {
      console.error('[dsh-better-sidebar] file tree provider match error:', error)
      continue
    }
    if (!matched) continue
    try {
      const source = provider.createSource(sessionId, cwd)
      return {
        providerId: provider.id,
        source,
        capabilities: provider.capabilities ?? {},
      }
    } catch (error) {
      console.error('[dsh-better-sidebar] file tree provider createSource error:', error)
      continue
    }
  }
  return undefined
}

/**
 * Resolve one session's multi-root declarations (v0.18.0+): every provider
 * whose `match` accepts the session AND whose `roots` settles to a
 * NON-EMPTY array contributes its roots, merged in registration order with
 * duplicate root ids dropped (the FIRST registration wins). Throwing /
 * rejecting `match` / `roots` / `createSource` skip that provider's
 * contribution — the tree never breaks. An empty result means the session
 * stays single-root (the v0.17 `resolveFileTreeSource` keeps running
 * untouched). `roots` may return a plain array (resolved synchronously) or
 * a promise. Pure: no React, no registry access, fully unit-testable.
 */
export async function resolveFileTreeRoots(
  providers: readonly FileTreeProviderDescriptor[],
  sessionId: string,
  cwd: string | undefined,
): Promise<ResolvedFileTreeRoot[]> {
  const seen = new Set<string>()
  const roots: ResolvedFileTreeRoot[] = []
  for (const provider of providers) {
    if (provider.roots === undefined) continue
    let matched = false
    try {
      matched = provider.match(sessionId, cwd) === true
    } catch (error) {
      console.error('[dsh-better-sidebar] file tree provider match error:', error)
      continue
    }
    if (!matched) continue
    let declared: FileTreeProviderRoot[]
    try {
      const result = provider.roots(sessionId, cwd)
      declared = Array.isArray(result) ? result : await result
    } catch (error) {
      console.error('[dsh-better-sidebar] file tree provider roots error:', error)
      continue
    }
    if (declared.length === 0) continue
    let source: FileTreeDataSource
    try {
      source = provider.createSource(sessionId, cwd)
    } catch (error) {
      console.error('[dsh-better-sidebar] file tree provider createSource error:', error)
      continue
    }
    const capabilities = provider.capabilities ?? {}
    for (const root of declared) {
      // Shape guard: a malformed root entry must never break the tree.
      if (root === null || typeof root !== 'object') continue
      if (typeof root.id !== 'string' || root.id === '' || typeof root.dir !== 'string' || root.dir === '') continue
      if (seen.has(root.id)) continue
      seen.add(root.id)
      roots.push({
        id: root.id,
        label: typeof root.label === 'string' ? root.label : root.dir,
        dir: root.dir,
        providerId: provider.id,
        source,
        capabilities,
      })
    }
  }
  return roots
}

/** Fill a provider listing's optional cosmetic fields with safe defaults,
 *  yielding the exact local host row shape the tree renders. `entry.meta`
 *  (v0.20.0) is passed through as-is (absent → absent), so provider stat
 *  detail can ride the same row the local fs.tree shape produces. */
export function normalizeFileTreeEntries(entries: readonly FileTreeEntry[]): FsEntry[] {
  return entries.map(entry => ({
    name: entry.name,
    path: entry.path,
    isDir: entry.isDir,
    hidden: entry.hidden === true,
    isSymlink: entry.isSymlink === true,
    broken: entry.broken === true,
    ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
  }))
}

/** Whether one local ability is on for the resolved mode: local sessions
 *  (resolved === undefined) always have every ability; provider sessions
 *  only the ones the provider declared `true`. */
export function fileTreeCapabilityOn(
  resolved: ResolvedFileTreeSource | undefined,
  key: keyof FileTreeProviderCapabilities,
): boolean {
  return resolved === undefined || resolved.capabilities[key] === true
}

/** The mode inputs of `referencablePathOf` — the tree's OWN effective
 *  mode, read at the call sites (single-source files, multi-root roots),
 *  so one pure mapper serves every surface. */
export interface ReferencablePathMode {
  /** The session cwd (the LOCAL root; only consulted in multi-root mode
   *  to keep the local subtree from ever mapping through a provider). */
  cwd?: string | undefined
  /** The session's effective single source (v0.17 single-source takeover
   *  and v0.20 sourceOverride section trees); undefined = default local. */
  singleSource?: ResolvedFileTreeSource | undefined
  /** The resolved remote roots (v0.18.0+ multi-root). Empty list or
   *  undefined = not multi-root. */
  roots?: readonly ResolvedFileTreeRoot[] | undefined
}

/** One row's reference text (v0.21.0): the row path mapped through the
 *  data source that OWNS the row — the source's `reference?(path)` — so
 *  the explorer's @-reference button inserts a path the session can
 *  actually read (a provider whose rows carry remote-absolute paths maps
 *  them to the local mirror path; local rows stay verbatim). The owning
 *  source is resolved exactly like the tree's open delegation:
 *   - multi-root (`roots` non-empty): rows under a REMOTE root map through
 *     that root's source — rows under the LOCAL `cwd` subtree never map
 *     (the local root is never taken over), and rows under no root keep
 *     the row path;
 *   - otherwise the session's `singleSource` maps every row (a provider
 *     that serves a mix of path forms decides internally — returning the
 *     row path unchanged is the identity escape hatch).
 * Absent `reference` / no owning source / a throwing `reference` → the
 * row path verbatim, byte for byte. Pure and throwing-safe — the pill
 * call sites stay synchronous and can never break the tree.
 */
export function referencablePathOf(path: string, mode: ReferencablePathMode): string {
  const { cwd, singleSource, roots } = mode
  if (roots !== undefined && roots.length > 0) {
    if (cwd !== undefined && (path === cwd || path.startsWith(cwd + '/') || path.startsWith(cwd + '\\'))) return path
    // Same prefix semantics as FileTree's underDir ('/' and '\' — remote-
    // absolute row paths may use either separator).
    const root = roots.find(r => path === r.dir || path.startsWith(r.dir + '/') || path.startsWith(r.dir + '\\'))
    if (root === undefined) return path
    return mapFilePathReference(root.source, path)
  }
  if (singleSource === undefined) return path
  return mapFilePathReference(singleSource.source, path)
}

/** Apply one source's `reference` mapping, throwing-safe: a throwing or
 *  missing mapping degrades to the row path verbatim. */
function mapFilePathReference(source: FileTreeDataSource, path: string): string {
  if (typeof source.reference !== 'function') return path
  try {
    return source.reference(path) ?? path
  } catch (error) {
    console.error('[dsh-better-sidebar] file tree reference error:', error)
    return path
  }
}

/**
 * The render-side resolver hook: the resolved data source for a session,
 * or undefined for the default local host. Live: re-resolves when the
 * provider registry changes (a provider registers/unregisters while the
 * tree is mounted — e.g. a plugin activates after the panel exists) and
 * when the session/cwd changes. Registry-less service stubs (tests, hosts
 * without the full service) degrade to the local path.
 */
export function useFileTreeSource(
  ctx: Context | undefined,
  sessionId: string,
  cwd: string | undefined,
): ResolvedFileTreeSource | undefined {
  const service = ctx?.betterSidebar
  // The tick is the SUBSCRIPTION state: the reducer's dispatch (`force`) is
  // stable, so the memo below must depend on the tick itself — otherwise a
  // registry notification re-renders the tree but never re-resolves the
  // source, and a provider registering after the panel exists would never
  // take over the visible tree.
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
      return resolveFileTreeSource(service.getFileTreeProviders(), sessionId, cwd)
    } catch {
      // A registry-less / partial service stub must not break the tree.
      return undefined
    }
  }, [service, sessionId, cwd, tick])
}

/**
 * The render-side multi-root resolver hook (v0.18.0+): the session's
 * resolved REMOTE roots — undefined while the first resolution is still
 * pending (the tree renders the v0.17 single-root path meanwhile, exactly
 * as if the slot were a plain provider session) and for registry-less
 * service stubs; an EMPTY array is a settled "no remote roots" (plain
 * single-root behavior). Live: re-resolves when the provider registry
 * changes (a provider registers roots while the tree is mounted) and when
 * the session/cwd changes. Between re-resolutions the LAST settled list
 * stays visible, so a registry tick never flashes back to the single-root
 * render while the new roots are in flight.
 */
export function useFileTreeRoots(
  ctx: Context | undefined,
  sessionId: string,
  cwd: string | undefined,
): ResolvedFileTreeRoot[] | undefined {
  const service = ctx?.betterSidebar
  const [tick, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (service === undefined) return
    const offs: Array<() => void> = []
    try { offs.push(service.subscribe(force)) } catch { /* registry-less stub */ }
    return () => { for (const off of offs) off() }
  }, [service, force])
  // Render-time fast path: while the registry contains NO provider that
  // declares `roots`, the session can never be multi-root — settle to an
  // empty list SYNCHRONOUSLY so ordinary local sessions and v0.17
  // provider sessions never enter the pending window (no mode-key flip,
  // no extra local read, zero drift on the single-root path). The read
  // re-runs on registry ticks (the subscription forces a re-render).
  const hasRootsProviders = ((): boolean => {
    if (service === undefined) return false
    try {
      return service.getFileTreeProviders().some(provider => provider.roots !== undefined)
    } catch {
      // A registry-less / partial service stub must not break the tree.
      return false
    }
  })()
  const [roots, setRoots] = useState<ResolvedFileTreeRoot[] | undefined>(hasRootsProviders ? undefined : [])
  useEffect(() => {
    // No service (registry-less stubs / hosts without the full service)
    // and no roots-declaring provider both settle to an empty list — the
    // session can never be multi-root, and the settled state must not
    // flip into a pending window (that would wipe the tree cache and
    // refetch for nothing).
    if (service === undefined || !hasRootsProviders) {
      setRoots(current => current === undefined || current.length > 0 ? [] : current)
      return
    }
    let cancelled = false
    // A new resolution starts: the previous list is stale (a provider
    // registered/unregistered), so the consumers re-enter the pending
    // state until the new roots settle.
    setRoots(undefined)
    void resolveFileTreeRoots(service.getFileTreeProviders(), sessionId, cwd)
      // The resolver never rejects by contract, but a hostile registry
      // must not be allowed to break the tree: settle to "no roots".
      .then(found => { if (!cancelled) setRoots(found) })
      .catch(() => { if (!cancelled) setRoots([]) })
    return () => { cancelled = true }
  }, [service, sessionId, cwd, tick, hasRootsProviders])
  return roots
}