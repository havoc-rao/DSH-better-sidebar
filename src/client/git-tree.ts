/**
 * The changed-file TREE of the Git panel ("tree" list layout): one status
 * entry list is grouped under collapsible directory rows — files render at
 * their real depth (the panel draws the FileTree's indent guides), directory
 * rows carry the number of changed files in their subtree and start
 * collapsed (the whole point of the grouping: a 20-file change in `src/`
 * reads as one row until expanded). Repository-root files stay flat rows.
 *
 * Pure and dependency-light (works on the wire entry shape) so the grouping
 * logic is unit-testable without a component mount.
 */
import type { GitStatusEntry } from './api.ts'

/** One row of the changed-file tree. */
export type GitTreeNode =
  | {
      kind: 'dir'
      /** The directory's full status path (tooltip title). */
      path: string
      /** The last path segment (row label). */
      name: string
      /** Tree depth: root directories are 0 (guides start at 1). */
      depth: number
      /** Number of changed FILE entries in this directory's subtree. */
      count: number
      children: GitTreeNode[]
    }
  | {
      kind: 'file'
      /** The entry's full status path (tooltip title). */
      path: string
      /** The basename (row label; at depth 0 this equals `path`). */
      name: string
      /** Tree depth: repository-root files are 0. */
      depth: number
      entry: GitStatusEntry
    }

/** The accumulation node: entries land in dirs by segments, counts bubble up
 *  through the parent chain after every file placement. */
interface InternalDir {
  path: string
  name: string
  depth: number
  parent: InternalDir | undefined
  count: number
  dirs: Map<string, InternalDir>
  files: GitStatusEntry[]
}

/** Split one status path into segments ('a/b/c.ts' → ['a', 'b', 'c.ts']).
 *  Git reports '/' on every platform; backslashes are normalized defensively
 *  (mirror of the FileTree's baseName). Empty segments (trailing/double
 *  separators) are dropped — git never emits them, but tolerating them keeps
 *  the grouping total. */
function segmentsOf(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(segment => segment !== '')
}

/** The basename of one status path ('a/b/c.ts' → 'c.ts'; root files keep
 *  their full path — the basename of a single segment is the whole path). */
function nameOf(path: string): string {
  const segments = segmentsOf(path)
  return segments.length === 0 ? path : segments[segments.length - 1] as string
}

/** Case-insensitive name order with a byte-order tiebreak: deterministic
 *  across environments (localeCompare collations differ per ICU build). */
function compareByName(a: string, b: string): number {
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  if (al < bl) return -1
  if (al > bl) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** One directory → its public node list: directories first, then files (the
 *  explorer's ordering), each alphabetically by name. */
function toNodes(dir: InternalDir): GitTreeNode[] {
  const nodes: GitTreeNode[] = []
  for (const child of [...dir.dirs.values()].sort((a, b) => compareByName(a.name, b.name))) {
    nodes.push({
      kind: 'dir',
      path: child.path,
      name: child.name,
      depth: child.depth,
      count: child.count,
      children: toNodes(child),
    })
  }
  for (const entry of [...dir.files].sort((a, b) => compareByName(nameOf(a.path), nameOf(b.path)))) {
    nodes.push({ kind: 'file', path: entry.path, name: nameOf(entry.path), depth: dir.depth + 1, entry })
  }
  return nodes
}

/**
 * Group one changed-file entry list into the tree row set. The root is
 * implicit (the repository root, always "expanded"): its DIRECTORY children
 * become collapsible dir rows, its direct FILE entries become plain rows at
 * depth 0. Empty input yields an empty list.
 */
export function buildGitTree(entries: readonly GitStatusEntry[]): GitTreeNode[] {
  const roots: InternalDir[] = []
  const all = new Map<string, InternalDir>()
  const rootFiles: GitStatusEntry[] = []

  for (const entry of entries) {
    const segments = segmentsOf(entry.path)
    if (segments.length === 0) continue
    // Materialize (or walk) the directory chain above the file, top-down —
    // creation order guarantees every ancestor exists before its children.
    let dir: InternalDir | undefined
    for (let i = 0; i < segments.length - 1; i += 1) {
      const path = segments.slice(0, i + 1).join('/')
      const existing = all.get(path)
      if (existing !== undefined) {
        dir = existing
        continue
      }
      const created: InternalDir = {
        path,
        name: segments[i] as string,
        depth: i,
        parent: dir,
        count: 0,
        dirs: new Map(),
        files: [],
      }
      all.set(path, created)
      if (dir === undefined) roots.push(created)
      else dir.dirs.set(created.name, created)
      dir = created
    }
    if (dir === undefined) {
      rootFiles.push(entry)
    } else {
      dir.files.push(entry)
    }
    // The file counts toward every ancestor directory's subtree total.
    let cursor = dir
    while (cursor !== undefined) {
      cursor.count += 1
      cursor = cursor.parent
    }
  }

  const nodes: GitTreeNode[] = []
  for (const root of [...roots].sort((a, b) => compareByName(a.name, b.name))) {
    nodes.push({
      kind: 'dir',
      path: root.path,
      name: root.name,
      depth: 0,
      count: root.count,
      children: toNodes(root),
    })
  }
  for (const entry of [...rootFiles].sort((a, b) => compareByName(nameOf(a.path), nameOf(b.path)))) {
    nodes.push({ kind: 'file', path: entry.path, name: nameOf(entry.path), depth: 0, entry })
  }
  return nodes
}