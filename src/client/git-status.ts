/**
 * Git status decorations for the file explorer — the VSCode contract,
 * distilled from the VSCode git extension (extensions/git/src/repository.ts:
 * the porcelain XY → Status mapping, `getStatusLetter`, `getStatusColor` and
 * the Resource `priority` ranking; the workbench's folder aggregation honors
 * the decoration `propagate` flag, which the extension clears for deleted
 * resources).
 *
 * Everything here is pure and dependency-free so the mapping, the folder
 * aggregation and the tree-root scoping are unit-testable without React.
 *
 * Status letters: M modified / A added / D deleted / R renamed / C copied /
 * T type-changed / U untracked / I ignored / ! conflict. A row with BOTH an
 * index and a worktree letter ('AM') shows the WORKTREE letter — VSCode's
 * decoration provider writes the index decoration first and the worktree
 * decoration last, so the worktree wins for display.
 *
 * Folder aggregation picks the highest-priority descendant status (conflict >
 * ignored > modified/copied/type-changed > added/deleted/renamed/untracked —
 * the Resource `priority` ranking). Deleted files DO NOT propagate to their
 * parent folders, exactly like VSCode's `propagate: false` on deleted
 * decorations: a folder whose only change is a deleted file stays badge-less.
 *
 * The overlay is scoped to the tree root (the session cwd): entries outside
 * it are ignored, so a session inside a subdirectory of a repository only
 * decorates what that explorer can actually show.
 */
import type { GitStatusResult } from './api.ts'

/** The status families the explorer colors (each maps to one DSH token family). */
export type GitStatusKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflict'
  | 'ignored'
  | 'type'

/** One tree row's decoration (a file's own status or a folder's aggregate). */
export interface GitRowStatus {
  /** The VSCode letter ('M' / 'A' / 'D' / 'R' / 'C' / 'T' / 'U' / 'I' / '!'). */
  letter: string
  kind: GitStatusKind
  /** Deleted files render dimmed + struck through (never aggregated up). */
  deleted: boolean
}

/** One footer-summary chip (letter + how many changed files carry it). */
export interface GitStatusCount {
  letter: string
  kind: GitStatusKind
  count: number
}

/** The explorer overlay: per-path decorations + the cwd-scoped change counts. */
export interface GitStatusOverlay {
  /** Normalized absolute path → row status (files and aggregated folders). */
  map: ReadonlyMap<string, GitRowStatus>
  /** Changed files under the tree root, most severe first (footer chips). */
  counts: GitStatusCount[]
}

/** The porcelain unmerged (conflict) XY combos (git status --porcelain=v1). */
const CONFLICT_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** Whether a porcelain XY pair is an unmerged (conflict) entry. */
function isConflict(xy: string): boolean {
  return CONFLICT_XY.has(xy)
}

/**
 * The display letter of one porcelain entry. Worktree (Y) wins over index
 * (X) — VSCode's decoration bucket writes index first, worktree last — then
 * index, then untracked. Conflicts always show '!'.
 */
export function letterOf(xy: string): string {
  if (xy === '!!') return 'I'
  if (isConflict(xy)) return '!'
  const index = xy[0]
  const worktree = xy[1]
  if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree
  if (index !== undefined && index !== ' ' && index !== '?') return index
  return 'U'
}

/** The status family of one display letter. */
export function kindOfLetter(letter: string): GitStatusKind {
  switch (letter) {
    case 'M': return 'modified'
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'type'
    case 'I': return 'ignored'
    case '!': return 'conflict'
    default: return 'untracked'
  }
}

/** The VSCode Resource priority ranking: conflict > ignored > modified/copied/type-changed > the rest. */
function priorityOf(kind: GitStatusKind): number {
  switch (kind) {
    case 'conflict': return 4
    case 'ignored': return 3
    case 'modified':
    case 'copied':
    case 'type': return 2
    default: return 1
  }
}

/** Stable tie-break order for same-priority merges (deterministic chips). */
const LETTER_ORDER = ['!', 'M', 'C', 'T', 'A', 'R', 'D', 'U', 'I']

/** Merge two row statuses: the higher-priority kind wins, ties by letter order. */
export function mergeRowStatus(a: GitRowStatus, b: GitRowStatus): GitRowStatus {
  const pa = priorityOf(a.kind)
  const pb = priorityOf(b.kind)
  if (pa !== pb) return pa > pb ? a : b
  return LETTER_ORDER.indexOf(a.letter) <= LETTER_ORDER.indexOf(b.letter) ? a : b
}

/**
 * Normalize a path to a forward-slash lookup key (no trailing separator).
 * Keys are compared case-insensitively: on Windows (and macOS's
 * case-insensitive volumes) git may report a different case than the tree
 * listing, and the mismatch must not hide a badge.
 */
function normKey(path: string): string {
  return toPosix(path).toLowerCase()
}

/** Forward-slash form with no trailing separator (the walk/join form). */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Whether `target` lies under `base` (or equals it), separators and case tolerant. */
function isWithin(base: string, target: string): boolean {
  const norm = (value: string): string => toPosix(value).toLowerCase()
  const b = norm(base)
  const t = norm(target)
  return t === b || t.startsWith(`${b}/`)
}

/** Join an absolute root (native separators) with a repo-relative '/'-path. */
export function joinRoot(root: string, rel: string): string {
  const base = root.replace(/[\\/]+$/, '')
  return `${base}/${rel}`
}

/** The parent of a '/'-normalized path, or undefined at the filesystem root. */
function parentOf(path: string): string | undefined {
  const at = path.lastIndexOf('/')
  return at <= 0 ? undefined : path.slice(0, at)
}

/** The explorer overlay for one git status snapshot, scoped to the tree root. */
export function buildGitStatusMap(result: GitStatusResult | null, cwd: string | undefined): GitStatusOverlay {
  const map = new Map<string, GitRowStatus>()
  const empty: GitStatusOverlay = { map, counts: [] }
  if (result === null || !result.isRepo || result.root === undefined || result.root === '') return empty
  if (cwd === undefined || cwd === '') return empty

  const countByLetter = new Map<string, { letter: string; kind: GitStatusKind; count: number }>()
  for (const entry of result.entries) {
    const letter = letterOf(entry.xy)
    const kind = kindOfLetter(letter)
    const abs = toPosix(joinRoot(result.root, entry.path))
    // Entries outside the tree root cannot appear in this explorer — skip
    // them (and their ancestor aggregation) entirely.
    if (!isWithin(cwd, abs)) continue

    const row: GitRowStatus = { letter, kind, deleted: letter === 'D' }
    map.set(normKey(abs), row)

    const counted = countByLetter.get(letter)
    if (counted === undefined) countByLetter.set(letter, { letter, kind, count: 1 })
    else counted.count += 1

    // Folders aggregate their descendants — except deleted files, which do
    // not propagate (VSCode's `propagate: false` on deleted decorations).
    if (row.deleted) continue
    let dir = parentOf(abs)
    while (dir !== undefined && isWithin(cwd, dir)) {
      const key = normKey(dir)
      const existing = map.get(key)
      map.set(key, existing === undefined ? row : mergeRowStatus(existing, row))
      dir = parentOf(dir)
    }
  }

  const counts: GitStatusCount[] = [...countByLetter.values()]
    .sort((a, b) => priorityOf(b.kind) - priorityOf(a.kind)
      || LETTER_ORDER.indexOf(a.letter) - LETTER_ORDER.indexOf(b.letter))
  return { map, counts }
}

/** The decoration of one tree row path (undefined = clean). */
export function gitStatusAt(map: ReadonlyMap<string, GitRowStatus> | undefined, path: string): GitRowStatus | undefined {
  return map?.get(normKey(path))
}

// ── Change notification bus ──────────────────────────────────────────────
// The explorer has no file watcher (KISS, like the git panel). Instead the
// git panel bumps this bus after every refresh/mutation (stage, commit,
// discard…), and every mounted tree panel refetches — so a stage in the
// source-control view immediately recolors the explorer, and vice versa.

type GitStatusListener = () => void
const listeners = new Set<GitStatusListener>()

/** Notify every explorer that git status may have changed. */
export function notifyGitStatusChanged(): void {
  for (const listener of [...listeners]) listener()
}

/** Subscribe to git-status changes; returns a disposer. */
export function subscribeGitStatusChanged(listener: GitStatusListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
