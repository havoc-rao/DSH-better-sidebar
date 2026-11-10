import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkout, parseWorktreeList, resolveWorktree, runGit, status, worktrees } from '../src/git.ts'
import { removeTree } from './temp-tree.ts'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

describe('linked Git worktrees', () => {
  it('parses porcelain records with spaces in checkout paths', () => {
    expect(parseWorktreeList([
      'worktree C:/repo/main checkout',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree C:/repo/agent checkout',
      'HEAD def',
      'detached',
      '',
    ].join('\n'))).toEqual([
      { path: 'C:/repo/main checkout', branch: 'main', locked: false, prunable: false },
      { path: 'C:/repo/agent checkout', branch: 'HEAD', locked: false, prunable: false },
    ])
  })

  it('preserves locked metadata and marks stale records prunable', () => {
    expect(parseWorktreeList([
      'worktree C:/repo/locked',
      'HEAD abc',
      'branch refs/heads/locked',
      'locked in use',
      '',
      'worktree C:/repo/missing',
      'HEAD def',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\0'))).toEqual([
      { path: 'C:/repo/locked', branch: 'locked', locked: true, prunable: false },
      { path: 'C:/repo/missing', branch: 'HEAD', locked: false, prunable: true },
    ])
  })

  it('discovers dirty linked checkouts and fences selected targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-worktrees-'))
    const main = join(root, 'main')
    const agent = join(root, 'agent worktree')
    try {
      git(root, ['init', '-q', main])
      git(main, ['checkout', '-q', '-b', 'main'])
      writeFileSync(join(main, 'tracked.txt'), 'base\n')
      git(main, ['add', '-A'])
      git(main, ['commit', '-q', '-m', 'base'])
      git(main, ['worktree', 'add', '-q', '-b', 'agent', agent])
      writeFileSync(join(agent, 'tracked.txt'), 'changed by agent\n')
      // macOS tmpdir() keeps the /var symlink while git reports the resolved
      // /private/var prefix; on Windows TEMP is often the 8.3 short form
      // (C:\Users\RUNNER~1\...) while git reports the long path. The NATIVE
      // realpath resolves both aliasings (libuv's GetFinalPathNameByHandle
      // expands 8.3 names) — canonicalize every path handed to git APIs.
      const agentPath = realpathSync.native(agent)

      const listed = await worktrees(main)
      expect(listed).toHaveLength(2)
      expect(listed.find(entry => entry.current)).toMatchObject({ branch: 'main', changes: 0 })
      expect(listed.find(entry => !entry.current)).toMatchObject({ branch: 'agent', changes: 1 })
      expect(resolve(await resolveWorktree(main, agentPath))).toBe(resolve(agentPath))
      // The line counts ride the same status answer (#131): 'base' →
      // 'changed by agent' is exactly one line replaced, on the worktree side
      // (nothing is staged here, so the index side has no reading at all).
      expect((await status(await resolveWorktree(main, agentPath))).entries).toEqual([
        { path: 'tracked.txt', xy: ' M', unstaged: { additions: 1, deletions: 1 } },
      ])
      await expect(resolveWorktree(main, root)).rejects.toThrow('unknown linked worktree')

      // Git retains administrative metadata after a checkout directory is
      // deleted, reporting the record as prunable. It must disappear from both
      // the selector inventory and the accepted command-target allowlist.
      removeTree(agent)
      const remaining = await worktrees(main)
      expect(remaining).toHaveLength(1)
      expect(resolve(remaining[0]!.path)).toBe(resolve(realpathSync.native(main)))
      expect(remaining[0]!.current).toBe(true)
      await expect(resolveWorktree(main, agentPath)).rejects.toThrow('unknown linked worktree')
    } finally {
      try { git(main, ['worktree', 'remove', '--force', agent]) } catch { /* fixture may not be fully initialized */ }
      removeTree(root)
    }
  })

  it('shares a branch another worktree holds instead of letting git refuse the switch', async () => {
    // The SCM panel's branch menu is repo-wide, so a branch checked out in the
    // primary checkout is still listed while a linked checkout is selected.
    // git answers `fatal: '<branch>' is already used by worktree at ...`; the
    // explicit switch must win by sharing the branch, and the host must name
    // the other checkout so the UI can say which session it now follows.
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-worktree-switch-'))
    const main = join(root, 'main')
    const linked = join(root, 'linked')
    const linkedPath = (): string => realpathSync.native(linked)
    try {
      git(root, ['init', '-q', main])
      git(main, ['checkout', '-q', '-b', 'main'])
      writeFileSync(join(main, 'tracked.txt'), 'base\n')
      git(main, ['add', '-A'])
      git(main, ['commit', '-q', '-m', 'base'])
      git(main, ['worktree', 'add', '-q', '-b', 'feat', linked])

      // Whatever the locale, plain git refuses: this is the fatal the panel
      // used to hand to the user as a dead end.
      expect(() => git(linked, ['checkout', 'main'])).toThrow()

      // The panel targets the LINKED checkout through `cwd` (the host route
      // resolves the selected worktree before calling in); `selected` here is
      // the child-repository selector, not a worktree target.
      const shared = await checkout(linkedPath(), 'main')
      expect(resolve(shared.forcedFrom ?? '')).toBe(resolve(realpathSync.native(main)))
      expect(git(linked, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
      // Both checkouts now point at the SAME branch — that is the accepted
      // cost of an explicit switch.
      expect(git(main, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')

      // No occupancy ⇒ no flag and no report: the plain switch is unchanged.
      const plain = await checkout(linkedPath(), 'feat')
      expect(plain.forcedFrom).toBeUndefined()
      expect(git(linked, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat')
    } finally {
      removeTree(root)
    }
  })

  it('stashes only the changes that block a switch, and keeps the rest', async () => {
    // `git checkout main` refuses with "Your local changes ... would be
    // overwritten" when a dirty path also differs on the target branch. The
    // panel's switch is explicit, so those exact paths are stashed first — the
    // work is preserved (and recoverable), never discarded — and the rest of
    // the working tree is left alone.
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-worktree-stash-'))
    const repo = join(root, 'repo')
    const read = (name: string): string => readFileSync(join(repo, name), 'utf8')
    try {
      git(root, ['init', '-q', repo])
      git(repo, ['checkout', '-q', '-b', 'main'])
      writeFileSync(join(repo, 'colliding.txt'), 'main\n')
      writeFileSync(join(repo, 'other.txt'), 'base\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'base'])
      git(repo, ['checkout', '-q', '-b', 'feat'])
      writeFileSync(join(repo, 'colliding.txt'), 'feat\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'feat'])

      // Dirty on BOTH branches' spelling: `colliding.txt` differs between
      // branches, `other.txt` does not.
      writeFileSync(join(repo, 'colliding.txt'), 'local feat\n')
      writeFileSync(join(repo, 'other.txt'), 'local other\n')
      expect(() => git(repo, ['checkout', 'main'])).toThrow()

      const outcome = await checkout(repo, 'main')
      expect(outcome.stashedFiles).toEqual(['colliding.txt'])
      expect(outcome.forcedFrom).toBeUndefined()
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
      // The blocking edit left the tree (it is in the stash), the unrelated
      // edit is untouched.
      expect(read('colliding.txt')).toBe('main\n')
      expect(read('other.txt')).toBe('local other\n')
      expect(git(repo, ['stash', 'list'])).toContain('dsh: switch to main')
    } finally {
      removeTree(root)
    }
  })

  it('counts an untracked directory as ONE entry in the inventory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-worktree-count-'))
    const main = join(root, 'main')
    try {
      git(root, ['init', '-q', main])
      git(main, ['checkout', '-q', '-b', 'main'])
      writeFileSync(join(main, 'tracked.txt'), 'base\n')
      git(main, ['add', '-A'])
      git(main, ['commit', '-q', '-m', 'base'])
      // A large untracked tree. The inventory used to answer this by calling
      // the full `status()` — FOUR processes per linked checkout, including the
      // `--untracked-files=all` walk — on a 30 s poll, only to read
      // `.entries.length`. "Does this checkout have changes" is the question,
      // and one directory row is its answer: cheaper, and not silently capped
      // at GIT_STATUS_LIMIT the way the expanded count was.
      mkdirSync(join(main, 'vendor/nested'), { recursive: true })
      for (let index = 0; index < 50; index += 1) {
        writeFileSync(join(main, `vendor/nested/f${index}.txt`), 'x\n')
      }

      const listed = await worktrees(main)
      expect(listed).toHaveLength(1)
      expect(listed[0]!.changes).toBe(1)

      // The per-file answer is untouched: the tree's ink and the changes page
      // still expand the same tree file by file.
      expect((await status(main)).entries).toHaveLength(50)
    } finally {
      removeTree(root)
    }
  })

  /**
   * The status read feeds the two `--numstat` diffs a pathspec built from its
   * OWN porcelain output (the untracked walk that produced 9.24 MB of numstat
   * in a repository with an unignored nested `node_modules` must not reach the
   * diff walks at all). This pins the part that is easy to get wrong: every
   * path a row can carry counts for has to stay in that pathspec — including
   * the ORIGIN name of a rename, without which git cannot pair the two sides
   * and `0 0` silently becomes a full-file add.
   */
  it('keeps every per-file count and the group total under the numstat pathspec', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-numstat-pathspec-'))
    const main = join(root, 'main')
    try {
      git(root, ['init', '-q', main])
      git(main, ['checkout', '-q', '-b', 'main'])
      // Rename detection is a user config; pin it so this fixture means the
      // same thing on every machine (same convention as tests/git.spec.ts).
      git(main, ['config', 'diff.renames', 'true'])
      git(main, ['config', 'status.renames', 'true'])
      writeFileSync(join(main, 'both-sides.txt'), 'one\ntwo\n')
      writeFileSync(join(main, 'worktree-only.txt'), 'alpha\n')
      writeFileSync(join(main, 'moved.txt'), 'same\n')
      git(main, ['add', '-A'])
      git(main, ['commit', '-q', '-m', 'base'])

      // One file changed on BOTH sides (each side keeps its OWN reading), one
      // changed in the worktree only, a staged rename, and an untracked file.
      writeFileSync(join(main, 'both-sides.txt'), 'one\ntwo\nthree\n')
      git(main, ['add', 'both-sides.txt'])
      writeFileSync(join(main, 'both-sides.txt'), 'one\ntwo\nthree\nfour\n')
      writeFileSync(join(main, 'worktree-only.txt'), 'alpha\nbeta\n')
      git(main, ['mv', 'moved.txt', 'renamed.txt'])
      writeFileSync(join(main, 'untracked.txt'), 'brand new\n')

      const result = await status(main)
      const byPath = new Map(result.entries.map(entry => [entry.path, entry]))
      expect(byPath.get('both-sides.txt')).toMatchObject({
        xy: 'MM',
        staged: { additions: 1, deletions: 0 },
        unstaged: { additions: 1, deletions: 0 },
      })
      expect(byPath.get('worktree-only.txt')).toMatchObject({ xy: ' M', unstaged: { additions: 1, deletions: 0 } })
      // A rename that loses its origin from the pathspec reports `1 0` here.
      expect(byPath.get('renamed.txt')).toMatchObject({ xy: 'R ', staged: { additions: 0, deletions: 0 } })
      // No numstat row exists for an untracked file, pathspec or not.
      expect(byPath.get('untracked.txt')).toEqual({ path: 'untracked.txt', xy: '??' })

      // The group totals the changes tree sums, each group reading its own
      // side: dropping ANY of the paths above (or the rename origin) changes
      // one of these numbers.
      const totals = result.entries.reduce((sum, entry) => {
        for (const counts of [entry.staged, entry.unstaged]) {
          if (counts !== undefined && 'additions' in counts) {
            sum.additions += counts.additions
            sum.deletions += counts.deletions
          }
        }
        return sum
      }, { additions: 0, deletions: 0 })
      expect(totals).toEqual({ additions: 3, deletions: 0 })
    } finally {
      removeTree(root)
    }
  })

  /**
   * The row cap's field budget is twice `GIT_STATUS_LIMIT` because porcelain
   * frames TWO fields per rename record: a rename-heavy tree inside the row cap
   * must not be cut short (and mislabelled `truncated`) by a budget that only
   * counts ROWS.
   *
   * The fixture is sized so the budget is observable: the names are long and
   * the count high enough that the status answer arrives in several 64 KiB
   * reads, which is where a `limit + 1` budget — 2 001 fields for 1 800 rename
   * records, i.e. before the answer ends — cuts the list off mid-stream.
   */
  it('does not cut a rename-heavy tree inside the row cap short', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-rename-budget-'))
    const main = join(root, 'main')
    try {
      git(root, ['init', '-q', main])
      git(main, ['checkout', '-q', '-b', 'main'])
      git(main, ['config', 'status.renames', 'true'])
      const renames = 1_800
      const pad = 'x'.repeat(140)
      for (let index = 0; index < renames; index += 1) {
        writeFileSync(join(main, `a${index}-${pad}.txt`), 'x\n')
      }
      git(main, ['add', '-A'])
      git(main, ['commit', '-q', '-m', 'base'])
      for (let index = 0; index < renames; index += 1) {
        renameSync(join(main, `a${index}-${pad}.txt`), join(main, `b${index}-${pad}.txt`))
      }
      git(main, ['add', '-A'])

      const result = await status(main)
      // 1 800 rename records = 3 600 porcelain fields: under the row cap, and
      // under the (2x) field budget, so nothing is dropped or flagged.
      expect(result.entries).toHaveLength(renames)
      expect(result.truncated).toBe(false)
    } finally {
      removeTree(root)
    }
  })

  it('kills a command whose stdout passes the byte cap, and keeps the default ceiling generous', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-git-cap-'))
    try {
      git(root, ['init', '-q'])
      git(root, ['checkout', '-q', '-b', 'main'])
      writeFileSync(join(root, 'big.txt'), 'x'.repeat(256 * 1024))
      git(root, ['add', '-A'])
      git(root, ['commit', '-q', '-m', 'big'])

      await expect(runGit(root, ['show', 'HEAD:big.txt'], 30_000, { maxBytes: 4_096 }))
        .rejects.toThrow(/git show output exceeded 4096 bytes/)
      // The default ceiling is far above any legitimate answer: the same read
      // is unaffected without the option.
      await expect(runGit(root, ['show', 'HEAD:big.txt'])).resolves.toHaveLength(256 * 1024)
    } finally {
      removeTree(root)
    }
  })

  it('stops producing once the NUL field cap is reached', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-field-cap-'))
    try {
      git(root, ['init', '-q'])
      // Long names, so the status answer spans several 64 KiB pipe reads: the
      // cap is checked per chunk, which is exactly how a runaway untracked
      // walk is cut off mid-stream. They are long enough that ONE 64 KiB chunk
      // carries at most ~500 fields, so "the capped answer is shorter than the
      // whole one" is a real bound (cap 1,000 plus at most that one crossing
      // chunk) rather than a race against the kill: `runGit` ignores every
      // chunk that arrives after the cap trips. The kill itself is pinned
      // deterministically against a mocked child in tests/git-spawn.spec.ts.
      const files = 2_500
      for (let index = 0; index < files; index += 1) {
        writeFileSync(join(root, `f${index}-${'x'.repeat(120)}.ts`), 'x')
      }
      const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all']
      const all = await runGit(root, args)
      expect(all.split('\0').filter(field => field !== '')).toHaveLength(files)

      const capped = await runGit(root, args, 30_000, { maxNulFields: 1_000 })
      const fields = capped.split('\0').filter(field => field !== '')
      expect(fields.length).toBeGreaterThanOrEqual(1_000)
      expect(fields.length).toBeLessThan(files)
      // A complete prefix of the same answer, not a scrambled one.
      expect(all.startsWith(fields.slice(0, 1_000).join('\0'))).toBe(true)
    } finally {
      removeTree(root)
    }
  })
})
