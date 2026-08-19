/**
 * The explorer's git status overlay (VSCode-contract mapping): porcelain XY →
 * display letter/kind, the Resource priority ranking for folder aggregation
 * (deleted files never propagate), and the tree-root scoping that joins the
 * repo-relative status paths onto the session cwd.
 */
import { describe, expect, it } from 'vitest'
import type { GitStatusResult } from '../src/client/api.ts'
import {
  buildGitStatusMap, gitStatusAt, kindOfLetter, letterOf, mergeRowStatus,
} from '../src/client/git-status.ts'

/** A repo-relative status entry. */
function entry(path: string, xy: string): GitStatusResult['entries'][number] {
  return { path, xy }
}

/** The tree-root-scoped overlay of one status snapshot. */
function overlayOf(result: GitStatusResult, cwd?: string) {
  return buildGitStatusMap(result, cwd)
}

describe('letterOf (porcelain XY → display letter)', () => {
  it('maps the plain index/worktree letters', () => {
    expect(letterOf('M ')).toBe('M')
    expect(letterOf(' M')).toBe('M')
    expect(letterOf('A ')).toBe('A')
    expect(letterOf(' D')).toBe('D')
    expect(letterOf('D ')).toBe('D')
    expect(letterOf('R ')).toBe('R')
    expect(letterOf('C ')).toBe('C')
    expect(letterOf('T ')).toBe('T')
  })

  it('shows the WORKTREE letter when both sides are set (VSCode writes index first, worktree last)', () => {
    expect(letterOf('MM')).toBe('M')
    expect(letterOf('AM')).toBe('M')
    expect(letterOf('AD')).toBe('D')
    expect(letterOf('MD')).toBe('D')
  })

  it('maps untracked and ignored', () => {
    expect(letterOf('??')).toBe('U')
    expect(letterOf('!!')).toBe('I')
  })

  it('maps every unmerged (conflict) combo to !', () => {
    for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      expect(letterOf(xy), xy).toBe('!')
    }
  })
})

describe('kindOfLetter', () => {
  it('maps every display letter to its status family', () => {
    expect(kindOfLetter('M')).toBe('modified')
    expect(kindOfLetter('A')).toBe('added')
    expect(kindOfLetter('D')).toBe('deleted')
    expect(kindOfLetter('R')).toBe('renamed')
    expect(kindOfLetter('C')).toBe('copied')
    expect(kindOfLetter('T')).toBe('type')
    expect(kindOfLetter('U')).toBe('untracked')
    expect(kindOfLetter('I')).toBe('ignored')
    expect(kindOfLetter('!')).toBe('conflict')
  })
})

describe('mergeRowStatus (VSCode Resource priority)', () => {
  const status = (letter: string) => ({ letter, kind: kindOfLetter(letter), deleted: false })

  it('modified beats added/untracked; conflict beats everything', () => {
    expect(mergeRowStatus(status('M'), status('A')).letter).toBe('M')
    expect(mergeRowStatus(status('M'), status('U')).letter).toBe('M')
    expect(mergeRowStatus(status('!'), status('M')).letter).toBe('!')
  })

  it('breaks same-priority ties deterministically (added before deleted before untracked)', () => {
    expect(mergeRowStatus(status('A'), status('D')).letter).toBe('A')
    expect(mergeRowStatus(status('D'), status('A')).letter).toBe('A')
    expect(mergeRowStatus(status('D'), status('U')).letter).toBe('D')
  })
})

describe('buildGitStatusMap', () => {
  it('decorates files and aggregates their ancestor folders (modified wins)', () => {
    const result: GitStatusResult = {
      isRepo: true, branch: 'main', root: '/repo',
      entries: [
        entry('src/a.ts', ' M'),
        entry('src/deep/b.ts', 'A '),
        entry('src/new.ts', '??'),
      ],
    }
    const overlay = overlayOf(result, '/repo')
    expect(gitStatusAt(overlay.map, '/repo/src/a.ts')).toEqual({ letter: 'M', kind: 'modified', deleted: false })
    expect(gitStatusAt(overlay.map, '/repo/src/deep/b.ts')).toEqual({ letter: 'A', kind: 'added', deleted: false })
    expect(gitStatusAt(overlay.map, '/repo/src/new.ts')).toEqual({ letter: 'U', kind: 'untracked', deleted: false })
    // The src folder aggregates M (priority 2) over A and U (priority 1).
    expect(gitStatusAt(overlay.map, '/repo/src')).toEqual({ letter: 'M', kind: 'modified', deleted: false })
    expect(gitStatusAt(overlay.map, '/repo/src/deep')).toEqual({ letter: 'A', kind: 'added', deleted: false })
    // Counts: one file per letter, most severe first (M, then A/U by letter order).
    expect(overlay.counts).toEqual([
      { letter: 'M', kind: 'modified', count: 1 },
      { letter: 'A', kind: 'added', count: 1 },
      { letter: 'U', kind: 'untracked', count: 1 },
    ])
  })

  it('never propagates deleted files to folders (VSCode propagate=false), but still counts them', () => {
    const result: GitStatusResult = {
      isRepo: true, branch: 'main', root: '/repo',
      entries: [entry('old/gone.ts', ' D')],
    }
    const overlay = overlayOf(result, '/repo')
    expect(gitStatusAt(overlay.map, '/repo/old/gone.ts')).toEqual({ letter: 'D', kind: 'deleted', deleted: true })
    // The folder holds ONLY a deleted file → stays badge-less.
    expect(gitStatusAt(overlay.map, '/repo/old')).toBeUndefined()
    expect(overlay.counts).toEqual([{ letter: 'D', kind: 'deleted', count: 1 }])
  })

  it('merges same-letter counts and dedupes identical statuses', () => {
    const result: GitStatusResult = {
      isRepo: true, branch: 'main', root: '/repo',
      entries: [entry('a.ts', ' M'), entry('b.ts', ' M')],
    }
    const overlay = overlayOf(result, '/repo')
    expect(overlay.counts).toEqual([{ letter: 'M', kind: 'modified', count: 2 }])
    expect(gitStatusAt(overlay.map, '/repo')).toEqual({ letter: 'M', kind: 'modified', deleted: false })
  })

  it('scopes to the tree root: entries outside the cwd are invisible', () => {
    const result: GitStatusResult = {
      isRepo: true, branch: 'main', root: '/repo',
      entries: [entry('src/a.ts', ' M'), entry('README.md', ' M')],
    }
    const overlay = overlayOf(result, '/repo/src')
    expect(gitStatusAt(overlay.map, '/repo/src/a.ts')).toEqual({ letter: 'M', kind: 'modified', deleted: false })
    expect(gitStatusAt(overlay.map, '/repo/README.md')).toBeUndefined()
    expect(overlay.counts).toEqual([{ letter: 'M', kind: 'modified', count: 1 }])
  })

  it('matches tree rows regardless of separator style and case', () => {
    const result: GitStatusResult = {
      isRepo: true, branch: 'main', root: 'C:\\repo',
      entries: [entry('src\\a.ts', ' M')],
    }
    const overlay = overlayOf(result, 'C:\\repo')
    // The tree lists rows with native separators and possibly different case.
    expect(gitStatusAt(overlay.map, 'C:/repo/src/a.ts')).toEqual({ letter: 'M', kind: 'modified', deleted: false })
    expect(gitStatusAt(overlay.map, 'c:\\repo\\src\\a.ts')).toEqual({ letter: 'M', kind: 'modified', deleted: false })
    expect(gitStatusAt(overlay.map, 'C:\\repo\\src')).toEqual({ letter: 'M', kind: 'modified', deleted: false })
  })

  it('returns an empty overlay outside a repo or without a tree root', () => {
    expect(overlayOf({ isRepo: false, entries: [] }, '/repo').counts).toEqual([])
    expect(overlayOf({ isRepo: false, entries: [] }, '/repo').map.size).toBe(0)
    const repo: GitStatusResult = { isRepo: true, branch: 'main', root: '/repo', entries: [entry('a.ts', ' M')] }
    expect(overlayOf(repo, undefined).map.size).toBe(0)
    expect(buildGitStatusMap(null, '/repo').map.size).toBe(0)
  })
})
