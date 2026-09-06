/**
 * The SOURCE-form file-tree section renderer (v0.20.0, feature
 * `'fileTreeSectionSource'`): the HOST draws the upper module with its own
 * FileTree, bound EXPLICITLY to the plugin's data source — the plugin
 * supplies only data, the tree reuses the full local-row surface (icons,
 * git decorations, context menus, copy paths, drops…) with zero second
 * tree implementation to maintain.
 *
 * Contract: the section descriptor (`FileTreeSectionDescriptor.source`)
 * declares
 * - `createSource(sessionId, cwd)` — one session's live data source;
 * - `roots?(sessionId, cwd)` — the section's remote starting points; the
 *   FIRST entry of the settled (possibly async) list becomes the tree
 *   root. Absent / empty / rejected → the upper module renders nothing;
 * - `capabilities?` — the source's capability face (absent = all off).
 *
 * The tree renders SINGLE-SOURCE: `cwd` is the root's `dir` verbatim
 * (remote semantics — every expansion calls the source's `list(dir)`
 * with the path passed through unchanged), the root row shows the remote
 * root's basename, and the relative-copy base is the root dir (naturally
 * correct). The override is passed through `FileTree.sourceOverride` and
 * the component pins `roots={[]}`, so no global provider registry is ever
 * consulted — the section tree can never become multi-root and the lower
 * module's LOCAL tree can never be taken over (the hard constraint behind
 * this form).
 *
 * Failure policy: every throwing/rejecting step (roots, createSource, a
 * rejected promise) degrades to null — the tree never crashes, the upper
 * module just stays unrendered. The `expanded` set is component-owned and
 * resets on session/root changes (no stale remote paths across switches).
 *
 * File opens: when `capabilities.open` is declared AND the source provides
 * `open(path)`, FileTree delegates file-row clicks / Enter / Space to it;
 * otherwise the row is inert (`onOpenFile` is a no-op — the plugin owns
 * every open escape by design).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { FileTree } from './FileTree.tsx'
import type {
  FileTreeDataSource, FileTreeProviderRoot,
} from './file-tree-source.ts'
import type { FileTreeSectionDescriptor, FileTreeSectionScope } from './file-tree-section.ts'
import css from './sidebar.module.css'

/** One settled resolution: the live source plus the rendered root. */
interface ResolvedSectionTree {
  source: FileTreeDataSource
  root: FileTreeProviderRoot
}

/**
 * Render one source-form section's upper module (see the file header for
 * the contract). `section.source` is guaranteed by the registration
 * validation; a defensive check keeps a hostile descriptor from crashing.
 */
export function SectionSourceTree(props: {
  section: FileTreeSectionDescriptor
  scope: FileTreeSectionScope
}): ReactNode {
  const { section, scope } = props
  const descriptor = section.source
  const { sessionId, cwd } = scope

  /** The settled source + root; null while resolving / when no root or a
   *  factory failure leaves the section without a renderable tree. */
  const [resolved, setResolved] = useState<ResolvedSectionTree | null>(null)
  /** Whether the section EVER settled a real root. A re-settle (session
   *  switch / root change) must bump the tree's refreshTick — FileTree's
   *  tick wipe drops the OLD level cache, so paths from a previous session
   *  can never resurface when the user re-expands the same-looking dirs.
   *  The FIRST settle must NOT bump: the tree is brand new, wiping would
   *  double-load its first listing. */
  const hasSettled = useRef(false)

  useEffect(() => {
    if (descriptor === undefined) return
    let cancelled = false
    const finish = (root: FileTreeProviderRoot | null): void => {
      if (cancelled || root === null) return
      try {
        const source = descriptor.createSource(sessionId, cwd)
        // A NEW settle while a previous root is live swaps the tree's
        // session/root: reset the expansion AND bump the tree's
        // refreshTick in the SAME commit as the new root — FileTree then
        // wipes the OLD level cache, so neither stale paths nor stale
        // expansions can resurface under the new root (the first settle
        // skips the bump: the tree is brand new, wiping would double-load).
        setExpanded([])
        if (hasSettled.current) setRefreshTick(tick => tick + 1)
        hasSettled.current = true
        setResolved({ source, root })
      } catch (error) {
        console.error('[dsh-better-sidebar] file tree section createSource error:', error)
      }
    }
    setResolved(null)
    try {
      const declared = descriptor.roots?.(sessionId, cwd)
      if (declared === undefined) return // no roots → the upper module stays unrendered
      if (Array.isArray(declared)) {
        finish(declared.length > 0 ? declared[0]! : null)
      } else {
        declared
          .then(list => { finish(list.length > 0 ? list[0]! : null) })
          .catch((error: unknown) => {
            console.error('[dsh-better-sidebar] file tree section roots error:', error)
          })
      }
    } catch (error) {
      console.error('[dsh-better-sidebar] file tree section roots error:', error)
    }
    return () => { cancelled = true }
  }, [descriptor, sessionId, cwd])

  /** The tree's wipe signal (see the resolve effect's re-settle bump). */
  const [refreshTick, setRefreshTick] = useState(0)
  /** The section tree's own expansion set (never the panel's local set).
   *  Reset inside the resolve effect's settle, together with the new root,
   *  so no stale remote paths can linger across sessions/roots. */
  const [expanded, setExpanded] = useState<string[]>([])

  const toggleExpanded = useCallback((path: string): void => {
    setExpanded(current => current.includes(path) ? current.filter(p => p !== path) : [...current, path])
  }, [])

  // A STABLE override object: the FileTree's single-source selection and
  // load effect key on the source identity — a fresh object per render
  // would re-fire loads while a level is still pending.
  const sourceOverride = useMemo(() => (resolved === null ? null : {
    providerId: section.id,
    source: resolved.source,
    capabilities: descriptor?.capabilities ?? {},
  }), [section.id, resolved, descriptor])

  if (resolved === null) return null
  return (
    /*
     * The tree container fills the upper module (height: 100% — the
     * splitter gives the section a definite height on definite hosts) and
     * lets FileTree's own explorerBody flex to the remainder + scroll —
     * the same container structure the LOCAL tree uses inside the panel.
     */
    <div className={css.sectionSourceTree} data-dsh-file-tree-section-source={section.id}>
      <FileTree
        sessionId={sessionId}
        cwd={resolved.root.dir}
        sourceOverride={sourceOverride!}
        roots={[]}
        expanded={expanded}
        onToggle={toggleExpanded}
        onOpenFile={() => {}}
        onReferenceFile={() => {}}
        refreshTick={refreshTick}
      />
    </div>
  )
}