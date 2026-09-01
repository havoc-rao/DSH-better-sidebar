/**
 * The git header upstream pill + fetch: `branchStatus` computes the
 * upstream relationship (ahead/behind + gone) from plumbing config reads,
 * and `fetch` pulls remote refs (optionally pruning deleted ones) with the
 * typed `git-no-remote` code for remotes repositories. Real git fixtures
 * (bare origin + local checkout) so the full tracking-ref lifecycle —
 * configure upstream → count → delete on the remote → prune → gone — is
 * exercised against actual git, not mocks.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchStatus, fetch, type GitBranchStatus } from '../src/git.ts'

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

/** Whether a ref exists in `repo` (exit-0 `show-ref --verify --quiet`). */
function refExists(repo: string, ref: string): boolean {
  const result = spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', ref], { encoding: 'utf8' })
  return result.status === 0
}

/** Initialize a local repo with one commit on `main` and return its
 *  canonical path (macOS tmpdir() keeps the /var → /private/var symlink;
 *  every path handed to git APIs is resolved after creation). */
function initRepo(root: string, name: string): string {
  const repo = join(root, name)
  git(root, ['init', '-q', repo])
  git(repo, ['checkout', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])
  return realpathSync(repo)
}

function writeCommit(repo: string, file: string, message: string): void {
  writeFileSync(join(repo, file), `${message}\n`)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', message])
}

describe('git upstream relationship (branchStatus)', () => {
  it('reports no upstream for a fresh repository (and for detached HEAD)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upstream-none-'))
    try {
      const repo = initRepo(root, 'repo')
      await expect(branchStatus(repo)).resolves.toEqual({ ahead: 0, behind: 0, gone: false })
      git(repo, ['checkout', '-q', '--detach'])
      await expect(branchStatus(repo)).resolves.toEqual({ ahead: 0, behind: 0, gone: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts ahead/behind against the configured upstream', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upstream-count-'))
    try {
      const bare = join(root, 'origin.git')
      git(root, ['init', '-q', '--bare', bare])
      const local = initRepo(root, 'local')
      git(local, ['remote', 'add', 'origin', bare])
      git(local, ['push', '-q', '-u', 'origin', 'main'])
      await expect(branchStatus(local)).resolves.toEqual({ upstream: 'origin/main', ahead: 0, behind: 0, gone: false })

      // The remote gains a commit (via a second clone); local gains two more.
      const other = initRepo(root, 'other')
      git(other, ['remote', 'add', 'origin', bare])
      git(other, ['fetch', '-q', 'origin'])
      // A fresh init already holds an unborn `main`; -B resets it onto the
      // remote-tracking ref instead of failing on the name collision.
      git(other, ['checkout', '-q', '-B', 'main', 'origin/main'])
      git(other, ['push', '-q', '-u', 'origin', 'HEAD:main'])
      writeCommit(other, 'remote.txt', 'remote work')
      git(other, ['push', '-q', 'origin', 'HEAD:main'])

      writeCommit(local, 'local1.txt', 'local one')
      writeCommit(local, 'local2.txt', 'local two')
      git(local, ['fetch', '-q', 'origin'])

      await expect(branchStatus(local)).resolves.toEqual({ upstream: 'origin/main', ahead: 2, behind: 1, gone: false })
      // The tracking ref itself now lags; the pill must not invent ahead
      // counts for a branch that never pushed.
      await expect(branchStatus(other)).resolves.toEqual({ upstream: 'origin/main', ahead: 0, behind: 0, gone: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('marks the upstream gone when the remote branch disappeared (post-prune state)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upstream-gone-'))
    try {
      const repo = initRepo(root, 'repo')
      git(repo, ['config', 'branch.main.remote', 'origin'])
      git(repo, ['config', 'branch.main.merge', 'refs/heads/main'])
      // No refs/remotes/origin/main exists — exactly what a prune fetch
      // leaves behind after the remote branch was deleted.
      await expect(branchStatus(repo)).resolves.toEqual({ upstream: 'origin/main', ahead: 0, behind: 0, gone: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('git fetch', () => {
  it('fails with the typed git-no-remote code when no remote is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fetch-noremote-'))
    try {
      const repo = initRepo(root, 'repo')
      await expect(fetch(repo, false)).rejects.toMatchObject({ code: 'git-no-remote' })
      await expect(fetch(repo, true)).rejects.toMatchObject({ code: 'git-no-remote' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates tracking refs, and --prune drops the ones whose remote branch was deleted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-fetch-prune-'))
    try {
      const bare = join(root, 'origin.git')
      git(root, ['init', '-q', '--bare', bare])
      const local = initRepo(root, 'local')
      git(local, ['remote', 'add', 'origin', bare])
      git(local, ['push', '-q', '-u', 'origin', 'main'])

      // A second clone pushes a second branch so the local repo has a
      // remote-tracking ref that can go stale.
      const other = initRepo(root, 'other')
      git(other, ['remote', 'add', 'origin', bare])
      git(other, ['fetch', '-q', 'origin'])
      git(other, ['checkout', '-q', '-b', 'wip', 'origin/main'])
      writeCommit(other, 'wip.txt', 'wip work')
      git(other, ['push', '-q', '-u', 'origin', 'wip'])

      await fetch(local, false)
      expect(refExists(local, 'refs/remotes/origin/main')).toBe(true)
      expect(refExists(local, 'refs/remotes/origin/wip')).toBe(true)

      // The remote branch disappears; a plain fetch keeps the stale tracking
      // ref, the prune fetch drops it.
      git(bare, ['update-ref', '-d', 'refs/heads/wip'])
      await fetch(local, false)
      expect(refExists(local, 'refs/remotes/origin/wip')).toBe(true)
      await fetch(local, true)
      expect(refExists(local, 'refs/remotes/origin/wip')).toBe(false)
      expect(refExists(local, 'refs/remotes/origin/main')).toBe(true)

      // The full lifecycle: deleting `main` remotely + prune leaves the
      // configured upstream ref missing → the pill shows gone.
      git(bare, ['update-ref', '-d', 'refs/heads/main'])
      await fetch(local, true)
      expect(refExists(local, 'refs/remotes/origin/main')).toBe(false)
      const status = await branchStatus(local) as GitBranchStatus
      expect(status).toMatchObject({ upstream: 'origin/main', gone: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})