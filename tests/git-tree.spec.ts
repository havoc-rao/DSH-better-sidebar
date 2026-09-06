/**
 * The changed-file TREE builder of the Git panel's "tree" list layout:
 * entries group under collapsible directory rows (each carrying the number
 * of changed files in its subtree), repository-root files stay flat rows,
 * directories sort before files and both order alphabetically
 * (case-insensitive, byte-order tiebreak).
 */
import { describe, expect, it } from 'vitest'
import { buildGitTree, type GitTreeNode } from '../src/client/git-tree.ts'
import type { GitStatusEntry } from '../src/client/api.ts'

/** One status entry with the working-tree-modified letter by default. */
function entry(path: string, xy = ' M'): GitStatusEntry {
  return { path, xy }
}

/** The tree flattened into a path/depth/count signature:
 *  `'dir src d0 n3'` then its children, `'file src/a.ts d1'`. */
function signature(nodes: GitTreeNode[]): string[] {
  const out: string[] = []
  for (const node of nodes) {
    if (node.kind === 'dir') {
      out.push(`dir ${node.path} d${node.depth} n${node.count}`)
      out.push(...signature(node.children))
    } else {
      out.push(`file ${node.path} d${node.depth}`)
    }
  }
  return out
}

describe('buildGitTree', () => {
  it('returns an empty list for no entries', () => {
    expect(buildGitTree([])).toEqual([])
  })

  it('keeps repository-root files as plain rows at depth 0 (name = path)', () => {
    expect(buildGitTree([entry('README.md'), entry('a.ts')])).toEqual([
      { kind: 'file', path: 'a.ts', name: 'a.ts', depth: 0, entry: entry('a.ts') },
      { kind: 'file', path: 'README.md', name: 'README.md', depth: 0, entry: entry('README.md') },
    ])
  })

  it('groups files under a directory row whose count covers the whole subtree', () => {
    const tree = buildGitTree([
      entry('src/a.ts'),
      entry('src/b.ts'),
      entry('src/sub/c.ts'),
      entry('docs/x.md'),
    ])
    expect(signature(tree)).toEqual([
      'dir docs d0 n1',
      'file docs/x.md d1',
      'dir src d0 n3',
      'dir src/sub d1 n1',
      'file src/sub/c.ts d2',
      'file src/a.ts d1',
      'file src/b.ts d1',
    ])
  })

  it('sorts directories first, then files — both alphabetically case-insensitive', () => {
    const tree = buildGitTree([
      entry('zfile.ts'),
      entry('afile.ts'),
      entry('src/sub/c.ts'),
      entry('src/z.ts'),
      entry('src/a.ts'),
      entry('docs/x.md'),
    ])
    expect(signature(tree)).toEqual([
      'dir docs d0 n1',
      'file docs/x.md d1',
      'dir src d0 n3',
      'dir src/sub d1 n1',
      'file src/sub/c.ts d2',
      'file src/a.ts d1',
      'file src/z.ts d1',
      'file afile.ts d0',
      'file zfile.ts d0',
    ])
  })

  it('normalizes backslash paths (Windows status output) into the same tree', () => {
    // The file NODES keep the original entry.path verbatim (it is what the
    // diff/stage routes receive); only the grouping segments are normalized.
    const tree = buildGitTree([entry('a\\b\\c.ts'), entry('a\\x.ts')])
    expect(signature(tree)).toEqual([
      'dir a d0 n2',
      'dir a/b d1 n1',
      'file a\\b\\c.ts d2',
      'file a\\x.ts d1',
    ])
  })

  it('groups entries regardless of input order (directory chains materialize top-down)', () => {
    const tree = buildGitTree([entry('a/b/c.ts'), entry('top.ts'), entry('a/x.ts')])
    expect(signature(tree)).toEqual([
      'dir a d0 n2',
      'dir a/b d1 n1',
      'file a/b/c.ts d2',
      'file a/x.ts d1',
      'file top.ts d0',
    ])
  })
})