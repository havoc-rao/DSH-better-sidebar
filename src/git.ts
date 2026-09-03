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
  /** The repository top level (absolute), present when `isRepo` — the
   *  explorer overlay joins it onto the repo-relative entry paths to map
   *  status onto tree rows (the session cwd may sit below the root). */
  root?: string
  entries: GitStatusEntry[]
  /** True when the working tree had more rows than `GIT_STATUS_LIMIT`; the
   *  panel shows a truncation notice instead of freezing on a huge untracked
   *  set (issue #369). */
  truncated?: boolean
  /** Selected repository root, or the discovered roots when the cwd is a container. */
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

/** One branch's relationship to its upstream (remote-tracking) ref. */
export interface GitBranchStatus {
  /** Short upstream ref name (e.g. `origin/main`); undefined when the branch tracks nothing. */
  upstream?: string
  /** Commits the local branch is ahead of the upstream (0 when it has no upstream). */
  ahead: number
  /** Commits the local branch is behind the upstream (0 when it has no upstream). */
  behind: number
  /** True when the upstream is CONFIGURED but its remote-tracking ref no longer
   *  exists locally — the branch was deleted on the remote and pruned (or never
   *  fetched). The user must decide to push (re-create) or abandon the branch. */
  gone: boolean
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
}

/** One `git log` row with parent hashes (for the graph view's lane layout).
 *  `parents` are FULL 40-char hashes, first-parent first (git's `%P` order),
 *  so a merge commit carries 2+ entries and a root commit carries none. */
export interface GitGraphEntry extends GitLogEntry {
  parents: string[]
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

/** Parse `git log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D` rows. */
export function parseLogLines(output: string): GitLogEntry[] {
  const rows: GitLogEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hash, subject, author, date, hashFull, refs] = line.split('\x1f')
    if (hash === undefined || subject === undefined) continue
    rows.push({
      hash,
      subject,
      author: author ?? '',
      date: date ?? '',
      hashFull: hashFull ?? hash,
      refs: refs ?? '',
    })
  }
  return rows
}

/**
 * Parse `git log --pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%ai%x1f%D` rows
 * (graph flavor): the second field is `%P` — the FULL parent hashes, space
 * separated, first-parent first. A root commit has an empty parent field →
 * `parents: []`. The row's own hash is `%H` (full); the short hash for
 * display is derived as the first 7 chars (git's default short length).
 *
 * The refs field is `%D` with `--decorate=full`: FULL ref names
 * (`HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1`)
 * so the client can classify local vs remote vs tag without ambiguity —
 * short decorations cannot tell a local branch `feature/foo` from a
 * remote-tracking ref of a remote named `feature`.
 */
export function parseGraphLines(output: string): GitGraphEntry[] {
  const rows: GitGraphEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hashFull, parentsRaw, subject, author, date, refs] = line.split('\x1f')
    if (hashFull === undefined || parentsRaw === undefined || subject === undefined) continue
    const parents = parentsRaw === '' ? [] : parentsRaw.split(' ').filter(hash => hash !== '')
    rows.push({
      hash: hashFull.slice(0, 7),
      hashFull,
      subject,
      author: author ?? '',
      date: date ?? '',
      refs: refs ?? '',
      parents,
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

/** Raw usable checkout records, shared by inventory and target validation.
 * Prunable records point at missing paths and are deliberately excluded from
 * both the selector and the command-target allowlist. */
async function listedWorktrees(cwd: string): Promise<GitWorktreeRecord[]> {
  const raw = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'])
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

/** One `git diff --cached --numstat` row; binary entries carry null counts. */
export interface StagedNumstatRow {
  path: string
  added: number | null
  deleted: number | null
}

/**
 * Parse `git diff --numstat` output (tab-separated `added\tdeleted\tpath`
 * lines; binary entries report `-` for both counts). Row paths may contain
 * tabs, so only the two leading fields split — the remainder is the path.
 */
export function parseNumstat(output: string): StagedNumstatRow[] {
  const rows: StagedNumstatRow[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [addedRaw, deletedRaw, ...pathParts] = line.split('\t')
    if (addedRaw === undefined || deletedRaw === undefined || pathParts.length === 0) continue
    const count = (raw: string): number | null => raw === '-' ? null : Number(raw)
    rows.push({
      path: pathParts.join('\t'),
      added: count(addedRaw),
      deleted: count(deletedRaw),
    })
  }
  return rows
}

/** Per-file staged line counts (`git diff --cached --numstat`). */
export async function stagedNumstat(cwd: string): Promise<StagedNumstatRow[]> {
  const raw = await runGit(cwd, ['diff', '--cached', '--numstat'])
  return parseNumstat(raw)
}

/** Per-file unstaged line counts for tracked working-tree changes. Untracked
 * files are represented by {@link status}; Git has no diff for them until
 * they enter the index. */
export async function unstagedNumstat(cwd: string): Promise<StagedNumstatRow[]> {
  const raw = await runGit(cwd, ['diff', '--numstat'])
  return parseNumstat(raw)
}

/** The `--stat` summary of the staged changes ('' when nothing is staged). */
export async function stagedStat(cwd: string): Promise<string> {
  return runGit(cwd, ['diff', '--cached', '--stat'])
}

/** `--stat` summary of tracked unstaged changes. Untracked paths are carried
 * separately by {@link status}. */
export async function unstagedStat(cwd: string): Promise<string> {
  return runGit(cwd, ['diff', '--stat'])
}

/** The subjects of the most recent commits, newest first — the style
 *  reference the AI commit draft imports into its prompt. */
export async function recentSubjects(cwd: string, count: number): Promise<string[]> {
  if (count <= 0) return []
  const raw = await runGit(cwd, ['log', '-n', String(count), '--pretty=format:%s'])
  return raw.split('\n').filter(line => line !== '')
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

/**
 * The current branch's upstream relationship. `git rev-parse
 * --symbolic-full-name @{upstream}` RESOLVES the tracking ref, so it fails
 * both when the branch has no upstream AND when the tracking ref is gone
 * (pruned). The two cases are told apart by reading the branch's configured
 * upstream (`%(upstream:short)` survives a missing tracking ref): an absent
 * config means the branch tracks nothing; a surviving name means the
 * upstream was deleted on the remote.
 *
 * Counts: `rev-list --left-right --count HEAD...<upstream>` — left = HEAD
 * side = ahead, right = upstream side = behind.
 */
export async function branchStatus(cwd: string, selected?: string): Promise<GitBranchStatus> {
  const root = await repoRoot(cwd, selected)
  const live = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    .then(out => out.trim(), () => '')
  const name = live !== '' && live !== '@{upstream}' ? live : await configuredUpstream(root)
  if (name === undefined) return { upstream: undefined, ahead: 0, behind: 0, gone: false }
  const counts = await runGit(root, ['rev-list', '--left-right', '--count', `HEAD...${name}`])
    .then(out => out.trim(), () => null)
  if (counts === null) {
    // Upstream configured, but its tracking ref does not exist here (deleted
    // on the remote / never fetched since) — the dashboard calls this `gone`.
    return { upstream: name, ahead: 0, behind: 0, gone: true }
  }
  const [left, right] = counts.split(/\s+/)
  return { upstream: name, ahead: Number(left ?? 0), behind: Number(right ?? 0), gone: false }
}

/** The branch's configured upstream name (`%(upstream:short)`), or undefined.
 *  The config entry outlives the tracking ref, which is exactly what lets
 *  {@link branchStatus} distinguish "no upstream" from "upstream gone". */
async function configuredUpstream(root: string): Promise<string | undefined> {
  const branch = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).then(out => out.trim(), () => '')
  if (branch === '' || branch === 'HEAD') return undefined
  const raw = await runGit(root, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`])
    .then(out => out.trim(), () => '')
  return raw === '' ? undefined : raw
}

/** Fetch budget: network I/O needs far more than the local-command default. */
const FETCH_TIMEOUT_MS = 120_000

/**
 * Fetch remote refs into the local remote-tracking refs (the worktree is
 * untouched). `prune` additionally deletes locally tracked refs whose remote
 * branch disappeared — without it `git fetch` never surfaces deletions, so
 * the panel's `gone` state would stay stale. A repository without any
 * configured remote fails with the typed `git-no-remote` code — the panel
 * maps that to its own copy.
 */
export async function fetch(cwd: string, selected?: string, prune = false): Promise<void> {
  const root = await repoRoot(cwd, selected)
  const remotes = await runGit(root, ['remote']).then(out => out.split('\n'), () => [''])
  if (remotes.every(name => name.trim() === '')) {
    throw new GitCommandError('no remote configured', 'git-no-remote', 'fetch')
  }
  await runGit(root, prune ? ['fetch', '--prune'] : ['fetch'], FETCH_TIMEOUT_MS)
}

/** Switch to an existing branch. */
export async function checkout(cwd: string, branch: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['checkout', branch])
}

/** One watched branch's tip position relative to the current checkout HEAD. */
export interface GitBranchTip {
  /** The local branch's short name. */
  name: string
  /** The branch tip's full 40-char hash. */
  hash: string
  /** Commits in the branch that HEAD does not have (the target is AHEAD —
   *  its tip is above the graph; the top bubble shows this count). */
  ahead: number
  /** Commits in HEAD that the branch does not have (the target is BEHIND —
   *  its tip sits somewhere below in HEAD's history; the bottom bubble shows
   *  this count when the tip is outside the loaded page). */
  behind: number
}

/**
 * The tips of the watched (重点关注) local branches — the divergence marker
 * data behind the graph's top/bottom bubbles and row rings. Names are
 * allowlisted against the repository's own `refs/heads` inventory (a stale
 * watch entry — branch deleted, workspace switched — is silently dropped,
 * never an error). `ahead`/`behind` are `rev-list --count` both ways against
 * the resolved checkout's HEAD; the current branch itself reports 0/0.
 */
export async function branchTips(
  cwd: string,
  branches: readonly string[],
  selected?: string,
): Promise<GitBranchTip[]> {
  const root = await repoRoot(cwd, selected)
  if (branches.length === 0) return []
  const raw = await runGit(root, ['for-each-ref', '--format=%(refname:short)%00%(objectname)', 'refs/heads'])
  const byName = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const [name, hash] = line.split('\0')
    if (name !== undefined && hash !== undefined) byName.set(name, hash)
  }
  const current = await currentBranch(root).catch(() => 'HEAD')
  const tips: GitBranchTip[] = []
  for (const name of branches) {
    const hash = byName.get(name)
    if (hash === undefined) continue
    if (name === current) {
      tips.push({ name, hash, ahead: 0, behind: 0 })
      continue
    }
    const ref = `refs/heads/${name}`
    const [ahead, behind] = await Promise.all([
      runGit(root, ['rev-list', '--count', `HEAD..${ref}`]).then(out => Number(out.trim()) || 0, () => 0),
      runGit(root, ['rev-list', '--count', `${ref}..HEAD`]).then(out => Number(out.trim()) || 0, () => 0),
    ])
    tips.push({ name, hash, ahead, behind })
  }
  return tips
}

/** Recent commit history (newest first), lazily pageable via skip/count. */
export async function log(cwd: string, count = 30, skip = 0, selected?: string): Promise<GitLogEntry[]> {
  const raw = await runGit(await repoRoot(cwd, selected), [
    'log', '-n', String(count), '--skip', String(skip), '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D',
  ])
  return parseLogLines(raw)
}

/**
 * Recent commit history with parent hashes (newest first), pageable via
 * skip/count. `--topo-order` guarantees no parent appears before its child
 * (the lane layout algorithm's precondition), at the cost of a less strictly
 * chronological order when branches diverge — which is the conventional
 * arrangement for a commit graph (parallel branches stay visually grouped).
 *
 * `worktree` may pin the log to one of the repo's linked checkouts (passed
 * through `resolveWorktree`'s allowlist — a caller cannot point this seam at
 * an unrelated repository). The previous behavior — falling back to
 * `parents: []` for linked worktrees — collapsed the lane graph to a single
 * column because the plain `git.log` route has no parent info; the host now
 * supports `git.log-graph` for every checkout so the panel keeps its lane
 * structure even when an MR review toggles the worktree selector.
 *
 * `--decorate=full` keeps the ref field self-describing (full ref names —
 * see {@link parseGraphLines}) so the client can color local vs remote refs.
 */
export async function graphLog(cwd: string, count = 30, skip = 0, worktree?: string): Promise<GitGraphEntry[]> {
  const targetCwd = await resolveWorktree(cwd, worktree)
  const raw = await runGit(targetCwd, [
    'log', '-n', String(count), '--skip', String(skip), '--topo-order', '--decorate=full',
    '--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%ai%x1f%D',
  ])
  return parseGraphLines(raw)
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
