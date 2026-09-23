/**
 * Git operations for the sidebar source-control panel. Everything goes
 * through the system `git` binary spawned per request (no library, no state),
 * with porcelain-parseable output formats (`-z` NUL framing, unit separators)
 * so parsing never depends on locale or color config. All commands run with
 * `-C <cwd>` on the session's working directory and `--no-pager` /
 * `-c color.ui=false` so output stays machine-readable.
 *
 * Commits use the user's git global identity untouched (never sets
 * user.name/user.email).
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

/** A parsed `git status --porcelain=v1 -z` entry. */
export interface GitStatusEntry {
  path: string
  /** Two-letter index/worktree status (X Y), e.g. 'M ', ' M', 'A ', '??'. */
  xy: string
}

/** The source-control panel snapshot. */
export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
  /** True when the working tree had more rows than `GIT_STATUS_LIMIT`; the
   *  panel shows a truncation notice instead of freezing on a huge untracked
   *  set (issue #369). */
  truncated?: boolean
  /** Selected repository root, or the discovered roots when the cwd is a container. */
  root?: string
  repositories?: string[]
}

/** One linked checkout returned by `git worktree list --porcelain`. */
export interface GitWorktree {
  /** Absolute checkout root. */
  path: string
  /** Branch name without `refs/heads/`, or `HEAD` when detached. */
  branch: string
  /** Whether this checkout contains the session cwd. */
  current: boolean
  /** Number of staged + unstaged status rows (a file changed on both sides counts once). */
  changes: number
}

/** One `git log` row. */
export interface GitLogEntry {
  /** Short hash (7+ chars, display). */
  hash: string
  /** Full 40-char hash (advanced operations: revert / cherry-pick). */
  hashFull: string
  subject: string
  author: string
  /** ISO 8601 author date (`%ai`), e.g. `2024-01-01 10:00:00 +0800`. */
  date: string
  /** Ref decorations (`%D` with --decorate=short), e.g. `HEAD -> main, origin/main`; '' when none. */
  refs: string
  /** Full parent object ids (`%P`), newest-parent first; [] for root commits. */
  parents: string[]
}

/**
 * One fixed-roots pagination page. In this mode the revision set never
 * moves between pages (the snapshot pins its tip hashes), so pages fetched
 * before/after new commits or a force-reset cannot shift rows under the
 * graph framework's lane layout.
 */
export interface GitLogPage {
  entries: GitLogEntry[]
  /** Opaque cursor for the NEXT page (binds session/repository/offset
   *  server-side); absent when the log ended. */
  cursor?: string
  hasMore: boolean
}

/** Optional fixed-roots + cursor paging switch for {@link log} (absent =
 *  legacy skip/count behavior, unchanged). */
export interface GitLogRequest {
  /** Pin the paged revision set on these tip hashes. Every candidate is
   *  re-verified by the server itself (40-hex + `rev-parse`); anything else
   *  is rejected. An EMPTY array asks the server to pin its own HEAD tip —
   *  the client never invents roots from heuristics. */
  roots?: readonly string[]
  /** Opaque cursor from a previous GitLogPage response. */
  cursor?: string
  /** The requesting session id (internal): cursors are bound to
   *  session + repository and rejected on mismatch. */
  sessionId?: string
}

/** One git failure (stderr text as the message). */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code = 'git-error',
    readonly command: string,
  ) {
    super(message)
  }
}

/** Parse porcelain v1 -z output into entries (rename/copy pairs collapse to one row). */
export function parsePorcelainZ(output: string): GitStatusEntry[] {
  const tokens = output.split('\0')
  const entries: GitStatusEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    index += 1
    if (token === '') continue
    const xy = token.slice(0, 2)
    const rest = token.slice(3)
    entries.push({ path: rest, xy })
    // Rename/copy entries carry the ORIGIN path as the next NUL field; the
    // new path (the file as it exists now) is the display path.
    if ((xy[0] === 'R' || xy[0] === 'C') && tokens[index] !== undefined && tokens[index] !== '') {
      index += 1
    }
  }
  return entries
}

/** One raw porcelain worktree record. Prunable checkouts are retained by
 * Git's administrative metadata after their directory disappears and must not
 * become selectable command targets. Locked checkouts remain usable. */
export interface GitWorktreeRecord {
  path: string
  branch: string
  locked: boolean
  prunable: boolean
}

/** Parse `git worktree list --porcelain` records. Production requests use
 * `-z` so even newlines and non-ASCII bytes in checkout paths stay lossless;
 * newline framing remains accepted for small fixtures and older Git output. */
export function parseWorktreeList(output: string): GitWorktreeRecord[] {
  const rows: GitWorktreeRecord[] = []
  let path: string | undefined
  let branch = 'HEAD'
  let locked = false
  let prunable = false
  const flush = (): void => {
    if (path !== undefined) rows.push({ path, branch, locked, prunable })
    path = undefined
    branch = 'HEAD'
    locked = false
    prunable = false
  }
  const sep = output.includes('\0') ? '\0' : '\n'
  const framed = output.endsWith(sep) ? output : `${output}${sep}`
  for (const line of framed.split(sep)) {
    if (line === '') {
      flush()
    } else if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      branch = line.slice('branch refs/heads/'.length)
    } else if (line === 'locked' || line.startsWith('locked ')) {
      locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      prunable = true
    }
  }
  return rows
}

/** Parse `git log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D%x1f%P` rows. */
export function parseLogLines(output: string): GitLogEntry[] {
  const rows: GitLogEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hash, subject, author, date, hashFull, refs, parents] = line.split('\x1f')
    if (hash === undefined || subject === undefined) continue
    rows.push({
      hash,
      subject,
      author: author ?? '',
      date: date ?? '',
      hashFull: hashFull ?? hash,
      refs: refs ?? '',
      parents: parents === undefined || parents === '' ? [] : parents.split(' '),
    })
  }
  return rows
}

/** Run one git command; resolves with stdout, rejects with GitCommandError. */
function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const full = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args]
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', full, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new GitCommandError(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`, 'git-error', args.join(' ')))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new GitCommandError(`cannot run git: ${error.message}`, 'git-error', args.join(' ')))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise(stdout)
      } else {
        reject(new GitCommandError(stderr.trim() || `git exited with ${String(code)}`, 'git-error', args.join(' ')))
      }
    })
  })
}

/** Cap on child directories probed by the workspace-container fallback scan.
 *  A home-directory cwd can hold hundreds of visible folders (Library, iCloud
 *  mounts…); probing them all serially is what froze the panel in #369. */
const DISCOVERY_LIMIT = 200
/** Per-probe and direct-discovery budget. `rev-parse` is millisecond-scale on
 *  a healthy checkout; a probe that needs longer is a stalled mount and is
 *  better abandoned than waited on. */
const DISCOVERY_TIMEOUT_MS = 5_000
/** Discovery results are cheap to recompute but expensive to storm: the panel
 *  polls every 2s and each poll fans out into several git.* calls that all
 *  resolve the same roots. A short TTL keeps fan-out at one scan per cwd. */
const DISCOVERY_CACHE_TTL_MS = 60_000

const repoRootsCache = new Map<string, { roots: string[]; expires: number }>()
const repoRootsInFlight = new Map<string, Promise<string[]>>()

/** Whether the directory is inside a git work tree (exit-0 `git rev-parse`).
 *  Probe timeout is short: a cwd on a stalled mount must not hold the panel
 *  hostage for the full command budget (issue #369). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], DISCOVERY_TIMEOUT_MS)
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** The repository top level containing `cwd` (`git rev-parse --show-toplevel`). */
async function directRepoRoot(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--show-toplevel'], DISCOVERY_TIMEOUT_MS)
  return out.trim()
}

/** Discover the current repository or direct child repositories. Results are
 *  cached per cwd and concurrent callers share one in-flight scan, so opening
 *  the panel (three parallel git.* requests) costs a single discovery pass. */
export function repoRoots(cwd: string): Promise<string[]> {
  const cached = repoRootsCache.get(cwd)
  if (cached !== undefined && cached.expires > Date.now()) return Promise.resolve(cached.roots)
  const pending = repoRootsInFlight.get(cwd)
  if (pending !== undefined) return pending
  const promise = discoverRepoRoots(cwd).then(
    (roots) => {
      repoRootsCache.set(cwd, { roots, expires: Date.now() + DISCOVERY_CACHE_TTL_MS })
      repoRootsInFlight.delete(cwd)
      return roots
    },
    (error: unknown) => {
      repoRootsInFlight.delete(cwd)
      throw error
    },
  )
  repoRootsInFlight.set(cwd, promise)
  return promise
}

async function discoverRepoRoots(cwd: string): Promise<string[]> {
  try {
    return [await directRepoRoot(cwd)]
  } catch {
    const entries = await readdir(cwd, { withFileTypes: true }).catch(() => [])
    const roots: string[] = []
    for (const entry of entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, DISCOVERY_LIMIT)) {
      try {
        const root = await directRepoRoot(join(cwd, entry.name))
        if (!roots.some(existing => pathIdentity(existing) === pathIdentity(root))) roots.push(root)
      } catch {
        // Ordinary child directory; keep discovering sibling repositories.
      }
    }
    return roots
  }
}

/** Resolve the selected repository, defaulting to the first discovered root. */
export async function repoRoot(cwd: string, selected?: string): Promise<string> {
  const roots = await repoRoots(cwd)
  if (roots.length === 0) throw new GitCommandError('not a git repository', 'not-repo', 'rev-parse')
  // Git for Windows may return forward-slash roots while callers pass
  // backslashes (or vice-versa); compare via the platform-aware identity.
  if (selected !== undefined) {
    const identity = pathIdentity(selected)
    const match = roots.find(root => pathIdentity(root) === identity)
    if (match !== undefined) return match
  }
  return roots[0]!
}

/** The current branch name (`git rev-parse --abbrev-ref HEAD`; 'HEAD' when detached). */
export async function currentBranch(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out.trim()
}

/** Upper bound on status rows shipped to the client. Beyond this the result
 *  is truncated (with `truncated: true`) so a pathological untracked set —
 *  e.g. the working tree discovered under a home-directory cwd — cannot
 *  freeze the browser main thread on JSON parse or list render (#369). */
const GIT_STATUS_LIMIT = 2_000

/**
 * Working-tree status (untracked included). `--untracked-files=all` lists
 * the contents of new directories as individual entries, while preserving
 * repository discovery and explicit repository selection for workspace roots.
 */
export async function status(cwd: string, selected?: string): Promise<GitStatusResult> {
  const repositories = await repoRoots(cwd)
  if (repositories.length === 0) return { isRepo: false, entries: [], repositories: [] }
  const root = await repoRoot(cwd, selected)
  const [branch, raw] = await Promise.all([
    currentBranch(root).catch(() => 'HEAD'),
    runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ])
  const parsed = parsePorcelainZ(raw)
  const truncated = parsed.length > GIT_STATUS_LIMIT
  return {
    isRepo: true,
    branch,
    entries: truncated ? parsed.slice(0, GIT_STATUS_LIMIT) : parsed,
    truncated,
    root,
    repositories,
  }
}

/** Platform-aware identity used only for comparing absolute checkout roots. */
function pathIdentity(path: string): string {
  const absolute = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Whether the current Git binary supports NUL-framed `worktree list` output.
 * Git < 2.36 rejects `-z`; cache the capability after the first attempt so
 * the SCM panel's polling does not repeatedly spawn a command known to fail. */
let worktreeListSupportsZ: boolean | undefined

/** Raw usable checkout records, shared by inventory and target validation.
 * Prunable records point at missing paths and are deliberately excluded from
 * both the selector and the command-target allowlist. */
async function listedWorktrees(cwd: string): Promise<GitWorktreeRecord[]> {
  let raw: string
  if (worktreeListSupportsZ === false) {
    raw = await runGit(cwd, ['worktree', 'list', '--porcelain'])
  } else {
    try {
      raw = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'])
      worktreeListSupportsZ = true
    } catch {
      worktreeListSupportsZ = false
      raw = await runGit(cwd, ['worktree', 'list', '--porcelain'])
    }
  }
  return parseWorktreeList(raw).filter(entry => !entry.prunable)
}

/** All linked checkouts of the repository containing `cwd`, enriched with a
 * live change count. The current checkout is first so a single-worktree repo
 * preserves the old UI ordering. */
export async function worktrees(cwd: string): Promise<GitWorktree[]> {
  if (!await isGitRepo(cwd)) return []
  const currentRoot = await repoRoot(cwd)
  const listed = await listedWorktrees(cwd)
  const rows = await Promise.all(listed.map(async (entry): Promise<GitWorktree> => ({
    path: entry.path,
    branch: entry.branch,
    current: pathIdentity(entry.path) === pathIdentity(currentRoot),
    // One stale/permission-raced linked checkout must not hide the valid
    // current repository from the panel. Targeted operations still fail loud.
    changes: await status(entry.path).then(result => result.entries.length, () => 0),
  })))
  return rows.sort((left, right) => Number(right.current) - Number(left.current))
}

/** Resolve an optional client-selected linked checkout. A caller may never use
 * this seam to point Git operations at an unrelated repository: the target
 * must occur in the authoritative session repository's worktree list. */
export async function resolveWorktree(cwd: string, requested?: string): Promise<string> {
  if (requested === undefined || requested === '') return cwd
  const identity = pathIdentity(requested)
  const match = (await listedWorktrees(cwd)).find(entry => pathIdentity(entry.path) === identity)
  if (match === undefined) {
    throw new GitCommandError(`unknown linked worktree: ${requested}`, 'git-worktree', 'worktree list')
  }
  return match.path
}

/** Diff text of the worktree (unstaged) or the index (staged). */
export async function diff(cwd: string, path: string | undefined, staged: boolean, selected?: string): Promise<string> {
  const root = await repoRoot(cwd, selected)
  const args = ['diff', '--no-ext-diff', '--no-color', '-U3']
  if (staged) args.push('--cached')
  if (path !== undefined) args.push('--', path)
  return runGit(root, args)
}

/** Stage paths (all when path is undefined). */
export async function stage(cwd: string, path: string | undefined, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['add', '-A', ...(path !== undefined ? ['--', path] : [])])
}

/** Unstage paths (all when path is undefined). */
export async function unstage(cwd: string, path: string | undefined, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['reset', '-q', ...(path !== undefined ? ['--', path] : [])])
}

/** Commit the staged changes with a message (global identity untouched). */
export async function commit(cwd: string, message: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['commit', '-m', message])
}

/** Branch names (current first). */
export async function branches(cwd: string, selected?: string): Promise<{ current: string; names: string[] }> {
  const root = await repoRoot(cwd, selected)
  const [current, raw] = await Promise.all([
    currentBranch(root).catch(() => 'HEAD'),
    runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const names = raw.split('\n').filter(line => line !== '')
  return { current, names: names.includes(current) ? names : [current, ...names] }
}

/** Switch to an existing branch. */
export async function checkout(cwd: string, branch: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['checkout', branch])
}

/** Recent commit history (newest first). Default: lazily pageable via
 *  skip/count, exactly as before (rows now also carry real parents).
 *  With `roots` / `cursor` in {@link GitLogRequest} the REVISION SET is
 *  fixed (pinned tip hashes, `--topo-order`) and paging rides opaque
 *  cursors — the stable-pagination mode the gitGraph framework needs. */
export function log(
  cwd: string,
  count?: number,
  skip?: number,
  selected?: string,
): Promise<GitLogEntry[]>
export function log(
  cwd: string,
  count: number | undefined,
  skip: number | undefined,
  selected: string | undefined,
  request: GitLogRequest,
): Promise<GitLogEntry[] | GitLogPage>
export async function log(
  cwd: string,
  count = 30,
  skip = 0,
  selected?: string,
  request?: GitLogRequest,
): Promise<GitLogEntry[] | GitLogPage> {
  // Bounded pages: the panel and the framework both page lazily, and a
  // runaway count must never flood a single response (nor the git child).
  const safeCount = Math.max(1, Math.min(LOG_COUNT_LIMIT, count))
  const root = await repoRoot(cwd, selected)
  const { cursor, roots, sessionId } = request ?? {}
  if (cursor === undefined && roots === undefined) {
    // Legacy skip/count paging — unchanged behavior, now with parents.
    const raw = await runGit(root, [
      'log', '-n', String(safeCount), '--skip', String(skip), '--decorate=short',
      '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D%x1f%P',
    ])
    return parseLogLines(raw)
  }
  const session = sessionId ?? ''
  const repoKey = pathIdentity(root)
  if (cursor !== undefined) {
    return logPageFromCursor(root, cursor, safeCount, session, repoKey)
  }
  // Anchor page: pin the revision set on the requested roots (the server
  // re-resolves and verifies every hash) or, with an empty list, on the
  // server's own currently checked-out HEAD tip — never on client-side
  // heuristics.
  return fetchLogPage(root, await resolveLogRoots(root, roots), skip, safeCount, session, repoKey)
}

/** Hard cap on `max-count` per page (any mode) — see `log`. */
const LOG_COUNT_LIMIT = 200
/** Cursors expire after 10 minutes and are evicted lazily (and on overflow). */
const LOG_CURSOR_TTL_MS = 10 * 60_000
/** Live cursor upper bound; at capacity the OLDEST cursors are evicted (a
 *  stale cursor then fails with `git-cursor` and the client re-anchors). */
const LOG_CURSOR_LIMIT = 64
/** A root candidate must be a full object id — ref names / revision syntax
 *  (`HEAD~2`, `:path`, …) are rejected before ever reaching `git log`. */
const LOG_ROOT_HASH = /^[0-9a-f]{40}$/

/** cursor token → bound snapshot slice (session/repository/roots/offset). */
const logCursors = new Map<string, { sessionId: string; repoKey: string; roots: string[]; offset: number; expiresAt: number }>()

/** Resolve the pinned roots for one snapshot: every client-provided hash is
 *  verified by the server itself (`rev-parse`); an empty request pins the
 *  server's own HEAD tip. `[]` back means an unborn HEAD (empty repository). */
async function resolveLogRoots(root: string, requested: readonly string[] | undefined): Promise<string[]> {
  if (requested === undefined || requested.length === 0) {
    try {
      const head = (await runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
      return head === '' ? [] : [head]
    } catch {
      return []
    }
  }
  if (requested.length > LOG_COUNT_LIMIT) {
    throw new GitCommandError(`too many log roots (limit ${LOG_COUNT_LIMIT})`, 'git-roots', 'log')
  }
  const resolved: string[] = []
  for (const candidate of requested) {
    if (typeof candidate !== 'string' || !LOG_ROOT_HASH.test(candidate)) {
      throw new GitCommandError(`invalid log root: ${String(candidate)}`, 'git-roots', 'log')
    }
    let hash: string
    try {
      hash = (await runGit(root, ['rev-parse', '--verify', `${candidate}^{commit}`])).trim()
    } catch {
      throw new GitCommandError(`unknown log root: ${candidate}`, 'git-roots', 'log')
    }
    if (!LOG_ROOT_HASH.test(hash)) {
      throw new GitCommandError(`unknown log root: ${candidate}`, 'git-roots', 'log')
    }
    if (!resolved.includes(hash)) resolved.push(hash)
  }
  return resolved.sort()
}

/** Issue one random cursor token bound to the next page slice. */
function issueLogCursor(
  sessionId: string,
  repoKey: string,
  roots: string[],
  offset: number,
): string {
  for (const [token, state] of logCursors) {
    if (state.expiresAt <= Date.now()) logCursors.delete(token)
  }
  const token = randomUUID()
  logCursors.set(token, { sessionId, repoKey, roots, offset, expiresAt: Date.now() + LOG_CURSOR_TTL_MS })
  while (logCursors.size > LOG_CURSOR_LIMIT) {
    const oldest = logCursors.keys().next().value
    if (oldest === undefined) break
    logCursors.delete(oldest)
  }
  return token
}

/** Resume paging through a previous cursor: session + repository must match
 *  the binding, otherwise the cursor is rejected (never silently reused). */
async function logPageFromCursor(
  root: string,
  token: string,
  count: number,
  sessionId: string,
  repoKey: string,
): Promise<GitLogPage> {
  const state = logCursors.get(token)
  if (state === undefined || state.expiresAt <= Date.now()) {
    logCursors.delete(token)
    throw new GitCommandError('unknown or expired log cursor', 'git-cursor', 'log')
  }
  if (state.sessionId !== sessionId || state.repoKey !== repoKey) {
    throw new GitCommandError('log cursor does not belong to this session/repository', 'git-cursor', 'log')
  }
  return fetchLogPage(root, state.roots, state.offset, count, sessionId, repoKey)
}

async function fetchLogPage(
  root: string,
  roots: string[],
  offset: number,
  count: number,
  sessionId: string,
  repoKey: string,
): Promise<GitLogPage> {
  if (roots.length === 0) return { entries: [], hasMore: false }
  const safeOffset = Math.max(0, Math.floor(offset))
  const raw = await runGit(root, [
    'log', '--topo-order', '-n', String(count), '--skip', String(safeOffset), '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D%x1f%P',
    ...roots, '--',
  ])
  const entries = parseLogLines(raw)
  const hasMore = entries.length === count
  return {
    entries,
    ...(hasMore ? { cursor: issueLogCursor(sessionId, repoKey, roots, safeOffset + count) } : {}),
    hasMore,
  }
}

/**
 * Content of a file at a revision (`git show <rev>:<path>`), or null when the
 * revision has no such path (a new/untracked file has no HEAD side).
 */
export async function show(cwd: string, rev: string, path: string, selected?: string): Promise<string | null> {
  try {
    return await runGit(await repoRoot(cwd, selected), ['show', `${rev}:${path}`])
  } catch {
    return null
  }
}

/** Full patch text of one commit (`git show` with the commit header suppressed).
 *  Merge commits show their diff against the first parent (`-m --first-parent`
 *  is a no-op for regular commits), so a history click always has content. */
export async function commitDiff(cwd: string, hash: string, selected?: string): Promise<string> {
  return runGit(await repoRoot(cwd, selected), ['show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', hash])
}

/** Discard the worktree changes of one path (`git checkout -- <path>`; the index is untouched). */
export async function discard(cwd: string, path: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['checkout', '--', path])
}

/** Revert one commit onto the current branch with an auto-generated message. */
export async function revert(cwd: string, hash: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['revert', '--no-edit', hash])
}

/** Cherry-pick one commit onto the current branch. */
export async function cherryPick(cwd: string, hash: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['cherry-pick', hash])
}
