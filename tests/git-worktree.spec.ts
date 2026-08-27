import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { graphLog, parseWorktreeList, resolveWorktree, status, worktrees } from '../src/git.ts'

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
      // /private/var prefix — canonicalize every path handed to git APIs.
      const agentPath = realpathSync(agent)

      const listed = await worktrees(main)
      expect(listed).toHaveLength(2)
      expect(listed.find(entry => entry.current)).toMatchObject({ branch: 'main', changes: 0 })
      expect(listed.find(entry => !entry.current)).toMatchObject({ branch: 'agent', changes: 1 })
      expect(resolve(await resolveWorktree(main, agentPath))).toBe(resolve(agentPath))
      expect((await status(await resolveWorktree(main, agentPath))).entries).toEqual([
        { path: 'tracked.txt', xy: ' M' },
      ])
      await expect(resolveWorktree(main, root)).rejects.toThrow('unknown linked worktree')

      // Git retains administrative metadata after a checkout directory is
      // deleted, reporting the record as prunable. It must disappear from both
      // the selector inventory and the accepted command-target allowlist.
      rmSync(agent, { recursive: true, force: true })
      const remaining = await worktrees(main)
      expect(remaining).toHaveLength(1)
      expect(resolve(remaining[0]!.path)).toBe(resolve(realpathSync(main)))
      expect(remaining[0]!.current).toBe(true)
      await expect(resolveWorktree(main, agentPath)).rejects.toThrow('unknown linked worktree')
    } finally {
      try { git(main, ['worktree', 'remove', '--force', agent]) } catch { /* fixture may not be fully initialized */ }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('graphLog populates parents when pinned to a linked checkout (MR scenario)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-graph-worktree-'))
    const main = join(root, 'main')
    const feature = join(root, 'feature worktree')
    try {
      // Build an MR-shaped fixture: main has commits, a feature worktree
      // forks off and adds commits, then merges back into main via a
      // --no-ff merge. The merge is the key data point: it must carry
      // TWO parents and drive the merge arc the lane graph was missing.
      git(root, ['init', '-q', main])
      git(main, ['checkout', '-q', '-b', 'main'])
      writeFileSync(join(main, 'main.txt'), 'main\n')
      git(main, ['add', '-A'])
      git(main, ['commit', '-q', '-m', 'base'])
      writeFileSync(join(main, 'main2.txt'), 'main2\n')
      git(main, ['add', '-A'])
      git(main, ['commit', '-q', '-m', 'main ahead'])
      git(main, ['worktree', 'add', '-q', '-b', 'feature', feature])
      writeFileSync(join(feature, 'feature.txt'), 'feature\n')
      git(feature, ['add', '-A'])
      git(feature, ['commit', '-q', '-m', 'feature commit'])
      git(main, ['merge', '--no-ff', '-m', 'merge feature into main', 'feature'])

      const fromMain = await graphLog(main)
      expect(fromMain.length).toBeGreaterThanOrEqual(4)
      expect(fromMain[0]!.hashFull).toMatch(/^[0-9a-f]{40}$/)
      // The freshest commit on main is the merge — it MUST carry TWO parents
      // (the previous main tip + the feature tip). That parent data is what
      // the lane layout needs to render the fork/merge arc the screenshot
      // was missing (a flat single-column graph when parents came back as []).
      expect(fromMain[0]!.parents).toHaveLength(2)

      const featurePath = realpathSync(feature)
      const fromFeature = await graphLog(main, 30, 0, featurePath)
      expect(fromFeature.length).toBeGreaterThanOrEqual(3)
      // Pinned to the feature checkout, the feature tip still has its
      // single parent (main's previous tip) — i.e. parents survive the
      // resolveWorktree → git -C <worktree> indirection exactly as the
      // non-worktree path produces them.
      expect(fromFeature[0]!.parents).toHaveLength(1)

      // resolveWorktree refuses unrelated paths so the route cannot be aimed
      // at an arbitrary directory. graphLog must propagate the same guard.
      await expect(graphLog(main, 30, 0, root)).rejects.toThrow('unknown linked worktree')
    } finally {
      try { git(main, ['worktree', 'remove', '--force', feature]) } catch { /* fixture may not be fully initialized */ }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
