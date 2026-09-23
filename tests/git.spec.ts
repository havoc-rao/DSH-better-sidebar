import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../src/client/diff/rows.ts'
import { parseLogLines, log, parsePorcelainZ, repoRoots, status, type GitLogPage } from '../src/git.ts'

const execFileAsync = promisify(execFile)
const normalizePath = (path: string): string => path.replaceAll('\\', '/')
// macOS tmpdir() is the /var symlink while git reports the resolved
// /private/var prefix; on Windows TEMP is often the 8.3 short form
// (C:\Users\RUNNER~1\...) while git reports the long path. The NATIVE
// realpath resolves both aliasings (libuv canonicalizes on Windows via
// GetFinalPathNameByHandle, which expands 8.3 names) — canonicalize both
// sides before comparing.
const canonical = (path: string): string => normalizePath(realpathSync.native(path))

describe('git parsing', () => {
  it('discovers and selects direct child repositories under a workspace directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-better-sidebar-git-'))
    const first = join(workspace, 'first-repo')
    const second = join(workspace, 'second-repo')
    try {
      await Promise.all([mkdir(first), mkdir(second)])
      await Promise.all([
        execFileAsync('git', ['-C', first, 'init']),
        execFileAsync('git', ['-C', second, 'init']),
      ])

      await expect(repoRoots(workspace)).resolves.toEqual([canonical(first), canonical(second)])
      await expect(status(workspace, canonical(second))).resolves.toMatchObject({
        isRepo: true,
        root: canonical(second),
        repositories: [canonical(first), canonical(second)],
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('parses porcelain -z entries including renames', () => {
    const output = ['M  src/a.ts', ' M src/b.ts', '?? src/c.ts', 'R  src/new.ts', 'src/old.ts', ''].join('\0')
    const entries = parsePorcelainZ(output)
    expect(entries).toEqual([
      { path: 'src/a.ts', xy: 'M ' },
      { path: 'src/b.ts', xy: ' M' },
      { path: 'src/c.ts', xy: '??' },
      { path: 'src/new.ts', xy: 'R ' },
    ])
  })

  it('keeps untracked files inside new directories as individual rows (status --untracked-files=all)', () => {
    // status() runs with --untracked-files=all, so a new folder must surface
    // as one entry PER FILE (?? newdir/a.ts), never a collapsed ?? newdir/
    // row that has no diff and cannot be read (regression: new folders showed
    // as a single folder row whose diff tab failed with "is a directory").
    const output = ['?? newdir/a.ts', '?? newdir/sub/b.ts', ''].join('\0')
    expect(parsePorcelainZ(output)).toEqual([
      { path: 'newdir/a.ts', xy: '??' },
      { path: 'newdir/sub/b.ts', xy: '??' },
    ])
  })

  it('keeps untracked files inside new directories as individual rows (real git)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-status-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root })
      mkdirSync(join(root, 'newdir'))
      writeFileSync(join(root, 'newdir', 'a.ts'), 'x')
      const result = await status(root)
      const paths = result.entries.map(entry => entry.path)
      expect(paths).toContain('newdir/a.ts')
      expect(paths.some(path => path.endsWith('/'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('caps status entries at the truncation limit (issue #369)', async () => {
    // A pathological untracked set — e.g. a repository discovered under a
    // home-directory cwd — must ship a bounded payload: the browser main
    // thread froze when one status response carried tens of thousands of
    // rows into response.json() and the unvirtualized change list.
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-truncate-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      const many = join(root, 'many')
      mkdirSync(many)
      for (let index = 0; index <= 2_000; index += 1) writeFileSync(join(many, `f${index}.ts`), 'x')
      const result = await status(root)
      expect(result.entries).toHaveLength(2_000)
      expect(result.truncated).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves ordinary statuses untruncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-untruncated-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(root, name), 'x')
      const result = await status(root)
      expect(result.entries).toHaveLength(3)
      expect(result.truncated).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shares one in-flight discovery scan between concurrent callers and caches the result (issue #369)', async () => {
    // The panel fires gitStatus/gitBranch/gitLog in parallel and then polls
    // every 2s; without sharing/caching, each call re-probed every visible
    // child directory of the cwd (the home-directory spawn storm of #369).
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-git-cache-'))
    const repo = join(workspace, 'a-repo')
    try {
      await mkdir(repo)
      await execFileAsync('git', ['-C', repo, 'init'])
      const first = repoRoots(workspace)
      // A second call while the first scan is still running joins it…
      expect(repoRoots(workspace)).toBe(first)
      const roots = await first
      expect(roots).toEqual([canonical(repo)])
      // …and once settled, the cached array (same reference) is served
      // without re-probing for the TTL window.
      await expect(repoRoots(workspace)).resolves.toBe(roots)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('parses log rows with unit separators (full hash + refs)', () => {
    const rows = parseLogLines(
      'abc1234\x1fFirst subject\x1fAlice\x1f2024-01-01 10:00:00 +0800\x1fabc1234def5678abc1234def5678abc1234def5678\x1fHEAD -> main, origin/main\n'
      + 'def5678\x1fSecond subject\x1fBob\x1f2024-01-02 10:00:00 +0800\x1fdef5678abc1234def5678abc1234def5678abc1234\x1f\n',
    )
    expect(rows).toEqual([
      {
        hash: 'abc1234',
        subject: 'First subject',
        author: 'Alice',
        date: '2024-01-01 10:00:00 +0800',
        hashFull: 'abc1234def5678abc1234def5678abc1234def5678',
        refs: 'HEAD -> main, origin/main',
        parents: [],
      },
      {
        hash: 'def5678',
        subject: 'Second subject',
        author: 'Bob',
        date: '2024-01-02 10:00:00 +0800',
        hashFull: 'def5678abc1234def5678abc1234def5678abc1234',
        refs: '',
        parents: [],
      },
    ])
  })

  it('parses the real %P parent list (multi-parent merge row)', () => {
    const p1 = '1111111111111111111111111111111111111111'
    const p2 = '2222222222222222222222222222222222222222'
    const rows = parseLogLines(
      `abc1234\x1fMerge branch\x1fAlice\x1f2024-01-03 10:00:00 +0800\x1fabc1234def5678abc1234def5678abc1234def5678\x1fHEAD -> main\x1f${p1} ${p2}\n`
      + `def5678\x1fRoot\x1fBob\x1f2024-01-02 10:00:00 +0800\x1fdef5678abc1234def5678abc1234def5678abc1234\x1f\x1f`,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]!.parents).toEqual([p1, p2])
    // A root commit carries an EMPTY %P segment → [].
    expect(rows[1]!.parents).toEqual([])
  })

  it('parses a multi-file unified diff with aligned line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,4 +1,5 @@ section with @@ inside',
      ' line1',
      '-line2',
      '+line2b',
      ' context',
      '+trailing',
      'diff --git a/README.md b/README.md',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/README.md',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n')
    const parsed = parseUnifiedDiff(diff)
    expect(parsed.files).toHaveLength(2)
    const first = parsed.files[0]!
    expect(first.oldPath).toBe('a/src/a.ts')
    expect(first.newPath).toBe('b/src/a.ts')
    expect(first.binary).toBe(false)
    expect(first.hunks).toHaveLength(1)
    expect(first.hunks[0]!.oldStart).toBe(1)
    expect(first.hunks[0]!.newStart).toBe(1)
    expect(first.hunks[0]!.header).toBe(' section with @@ inside')
    expect(first.hunks[0]!.lines).toEqual([
      { kind: 'ctx', text: 'line1', oldNum: 1, newNum: 1 },
      { kind: 'del', text: 'line2', oldNum: 2, newNum: null },
      { kind: 'add', text: 'line2b', oldNum: null, newNum: 2 },
      { kind: 'ctx', text: 'context', oldNum: 3, newNum: 3 },
      { kind: 'add', text: 'trailing', oldNum: null, newNum: 4 },
    ])
    const second = parsed.files[1]!
    expect(second.oldPath).toBe('/dev/null')
    expect(second.hunks[0]!.lines[0]).toEqual({ kind: 'add', text: 'hello', oldNum: null, newNum: 1 })
    expect(second.hunks[0]!.lines[1]).toEqual({ kind: 'add', text: 'world', oldNum: null, newNum: 2 })
  })

  it('parses binary, deletion and no-newline markers', () => {
    const diff = [
      'diff --git a/img.png b/img.png',
      'index 111..222 100644',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const parsed = parseUnifiedDiff(diff)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]!.binary).toBe(true)
    expect(parsed.files[0]!.hunks).toHaveLength(0)
    const gone = parsed.files[1]!
    expect(gone.newPath).toBe('/dev/null')
    expect(gone.hunks[0]!.lines).toEqual([
      { kind: 'del', text: 'one', oldNum: 1, newNum: null },
      { kind: 'del', text: 'two', oldNum: 2, newNum: null },
      { kind: 'meta', text: ' No newline at end of file', oldNum: null, newNum: null },
    ])
  })

  it('keeps mode/rename-only sections hunkless', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '',
    ].join('\n'))
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]!.oldPath).toBe('')
    expect(parsed.files[0]!.hunks).toHaveLength(0)
    expect(parsed.files[1]!.hunks).toHaveLength(0)
  })

  it('parses an empty or junk diff into no files', () => {
    expect(parseUnifiedDiff('').files).toEqual([])
    expect(parseUnifiedDiff('no diff here\n').files).toEqual([])
  })
})

describe('git.log fixed-roots + cursor pagination (gitGraph data layer)', () => {
  /** Build a real repo: A → B → (side: S) & (main: C) → merge M → D → E.
   *  Commit order (newest first): E D M {C,S} B A. Sibling order in
   *  --topo-order output within one level is timestamp-tied, so assertions
   *  never depend on C-vs-S ordering. */
  async function buildRepo(): Promise<{ root: string; hashes: Record<string, string> }> {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-git-log-'))
    const root = join(workspace, 'repo')
    mkdirSync(root)
    const git = (args: string[]) => execFileAsync('git', ['-C', root, ...args])
    await git(['init'])
    await git(['config', 'user.email', 't@example.com'])
    await git(['config', 'user.name', 'Test'])
    const commit = async (name: string, message: string) => {
      // A distinct file per commit keeps the later cross-branch merge
      // conflict-free (both branches touched different paths).
      writeFileSync(join(root, `file-${name}.txt`), `${name}\n`)
      await git(['add', '-A'])
      await git(['commit', '-m', message])
      return (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
    }
    const hashes: Record<string, string> = {}
    try {
      hashes.A = await commit('a', 'base one')
      hashes.B = await commit('b', 'base two')
      await git(['checkout', '-b', 'side'])
      hashes.S = await commit('s', 'side fork')
      await git(['checkout', 'main'])
      hashes.C = await commit('c', 'main after fork')
      await git(['merge', 'side', '-m', 'merge side'])
      hashes.M = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
      hashes.D = await commit('d', 'tip one')
      hashes.E = await commit('e', 'tip two')
      return { root, hashes }
    } catch (error) {
      await rm(workspace, { recursive: true, force: true })
      throw error
    }
  }

  async function withRepo(fn: (ctx: { root: string; hashes: Record<string, string> }) => Promise<void>): Promise<void> {
    const built = await buildRepo()
    try {
      await fn(built)
    } finally {
      await rm(built.root, { recursive: true, force: true })
    }
  }

  it('reports the real %P parents on a merge commit (multi-parent)', async () => {
    await withRepo(async ({ root, hashes }) => {
      const rows = await log(root, 10, 0, undefined, { roots: [], sessionId: 's1' })
      expect(Array.isArray(rows)).toBe(false)
      const page = rows as GitLogPage
      const merge = page.entries.find(entry => entry.hashFull === hashes.M)
      expect(merge).toBeDefined()
      expect(merge!.parents).toEqual([hashes.C!, hashes.S!])
      // The root commit has no parents.
      const rootRow = page.entries.find(entry => entry.hashFull === hashes.A)
      expect(rootRow!.parents).toEqual([])
    })
  })

  it('pages are pinned to the snapshot: new commits and force-resets cannot shift them', async () => {
    await withRepo(async ({ root, hashes }) => {
      const git = (args: string[]) => execFileAsync('git', ['-C', root, ...args])
      const first = await log(root, 2, 0, undefined, { roots: [], sessionId: 's1' })
      const page1 = first as GitLogPage
      expect(page1.entries.map(entry => entry.hashFull)).toEqual([hashes.E, hashes.D])
      expect(page1.hasMore).toBe(true)
      expect(page1.cursor).toBeTypeOf('string')

      // A NEW commit lands on top of the tips AFTER the anchor…
      writeFileSync(join(root, 'file-tip.txt'), 'f\n')
      await git(['add', '-A'])
      await git(['commit', '-m', 'tip three'])
      const newTip = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
      // …and the current branch is then force-reset to an older commit.
      await git(['reset', '--hard', hashes.D!])

      // The old snapshot's cursor still walks the PINNED history: page 2 is
      // exactly the old snapshot's next window — never the new tip, never
      // shifted rows.
      const second = await log(root, 2, 0, undefined, { cursor: page1.cursor!, sessionId: 's1' })
      const page2 = second as GitLogPage
      expect(page2.entries[0]!.hashFull).toBe(hashes.M)
      expect([hashes.C, hashes.S]).toContain(page2.entries[1]!.hashFull)
      expect(page2.entries.map(entry => entry.hashFull)).not.toContain(newTip)

      // A fresh anchor (roots: []) reflects the NEW reality (reset tip first).
      const fresh = await log(root, 2, 0, undefined, { roots: [], sessionId: 's1' })
      const freshPage = fresh as GitLogPage
      expect(freshPage.entries.map(entry => entry.hashFull)).toEqual([hashes.D, hashes.M])
    })
  })

  it('rejects invalid roots, unknown cursors and cross-session/repo cursors', async () => {
    await withRepo(async ({ root, hashes }) => {
      const session = 's1'
      const anchored = await log(root, 2, 0, undefined, { roots: [hashes.E!], sessionId: session })
      const page = anchored as { cursor?: string; hasMore: boolean }
      expect(page.cursor).toBeTypeOf('string')

      // Invalid root shapes: not a 40-hex hash (even a resolvable ref name),
      // an unknown object id, and an over-long list.
      await expect(log(root, 2, 0, undefined, { roots: ['main'], sessionId: session }))
        .rejects.toThrow(/invalid log root/)
      await expect(log(root, 2, 0, undefined, { roots: ['9'.repeat(40)], sessionId: session }))
        .rejects.toThrow(/unknown log root/)
      await expect(log(root, 2, 0, undefined, { roots: Array.from({ length: 201 }, () => 'a'.repeat(40)), sessionId: session }))
        .rejects.toThrow(/too many log roots/)

      // Unknown / expired cursor.
      await expect(log(root, 2, 0, undefined, { cursor: 'no-such-cursor', sessionId: session }))
        .rejects.toThrow(/unknown or expired log cursor/)

      // The cursor is bound to its session…
      await expect(log(root, 2, 0, undefined, { cursor: page.cursor!, sessionId: 'other-session' }))
        .rejects.toThrow(/does not belong to this session/)
      // …and to its repository: a second repo must not consume it.
      const other = await mkdtemp(join(tmpdir(), 'dsh-git-log-other-'))
      try {
        mkdirSync(join(other, 'repo2'))
        await execFileAsync('git', ['-C', join(other, 'repo2'), 'init'])
        await execFileAsync('git', ['-C', join(other, 'repo2'), 'config', 'user.email', 't@example.com'])
        await execFileAsync('git', ['-C', join(other, 'repo2'), 'config', 'user.name', 'Test'])
        writeFileSync(join(other, 'repo2', 'f.txt'), 'x\n')
        await execFileAsync('git', ['-C', join(other, 'repo2'), 'add', '-A'])
        await execFileAsync('git', ['-C', join(other, 'repo2'), 'commit', '-m', 'x'])
        await expect(log(join(other, 'repo2'), 2, 0, undefined, { cursor: page.cursor!, sessionId: session }))
          .rejects.toThrow(/does not belong to this session/)
      } finally {
        await rm(other, { recursive: true, force: true })
      }
    })
  })

  it('plain skip/count mode is unchanged (an array, now with parents) and count is bounded', async () => {
    await withRepo(async ({ root, hashes }) => {
      const plain = await log(root)
      expect(Array.isArray(plain)).toBe(true)
      expect(plain[0]!.hashFull).toBe(hashes.E)
      expect(plain[0]!.parents).toHaveLength(1)
      // A huge count never escapes the 200 cap (the repo has 7 commits).
      const capped = await log(root, 500, 0, undefined, { roots: [], sessionId: 's1' })
      expect((capped as { entries: unknown[] }).entries).toHaveLength(7)
    })
  })
})
