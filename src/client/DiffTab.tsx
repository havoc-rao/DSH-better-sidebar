/**
 * The diff tab: one change opened from the git panel, like VSCode's diff
 * editor. A worktree ref loads the file's unified diff (`git diff`, staged or
 * not; untracked files — which git diff never covers — render as a full-file
 * addition from their content), a commit ref loads the commit's full patch
 * (`git.show`-style). A REVIEW ref (opened from the intercepted produced-files
 * row's "review" button) loads the combined uncommitted diff of exactly the
 * paths a turn produced — one scrollable surface, source files expanded by
 * default, so the user can approve the turn's changes in a glance. The header
 * carries a refresh button because the tab stays mounted while the git
 * panel's staging/discard operations change the very content it shows.
 */
import { useCallback, useEffect, useState } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionScope } from './api.ts'
import { api } from './api.ts'
import type { SidebarDiffRef } from './state.ts'
import { DiffView } from './DiffView.tsx'
import { joinRoot, toPosix } from './git-status.ts'
import { t } from './locales.ts'
import { resolveSidebarPath } from './produced-files.ts'
import css from './sidebar.module.css'

/** The loaded diff surface (untracked content rendered as a full addition). */
interface DiffData {
  diff: string
  untracked?: string
}

/** Normalized absolute-path key (separator/case tolerant, like the explorer). */
function normKey(path: string): string {
  return toPosix(path).toLowerCase()
}

/**
 * One untracked file rendered as a unified-diff section of pure additions —
 * the multi-file twin of DiffView's single-file `untrackedFile`. The review
 * surface concatenates one such section per untracked produced file, so the
 * plain DiffView shows them as regular "added" file rows. `root` relativizes
 * the section paths against the repository top level, matching how `git diff`
 * names tracked files (absolute produced paths would otherwise show up in the
 * header while every tracked section stays repo-relative).
 */
export function synthesizeAdditionPatch(path: string, content: string, root?: string): string {
  const shown = root !== undefined && normKey(path).startsWith(`${normKey(root)}/`)
    ? toPosix(path).slice(toPosix(root).length + 1)
    : path
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const lines = body === '' ? [] : body.split('\n')
  const head =
    `diff --git a/${shown} b/${shown}\n` +
    'new file mode 100644\n' +
    'index 0000000..0000000\n' +
    `--- /dev/null\n+++ b/${shown}\n` +
    `@@ -0,0 +1,${lines.length} @@`
  if (lines.length === 0) return `${head}\n`
  return `${head}\n${lines.map(line => `+${line}`).join('\n')}\n`
}

/**
 * Load the combined review patch for a review ref: the concatenated uncommitted
 * diffs of exactly `diff.paths`, in produced order. `git status` classifies the
 * paths (untracked new files — which `git diff` never lists — render as
 * full-file additions from their content); a tracked change is fetched on the
 * unstaged side first with a staged fallback, like the per-file diff tab. A
 * produced path with NO uncommitted change anymore (already committed or
 * reverted) contributes nothing. All-failed surfaces surface the first error
 * instead of an empty diff.
 */
export async function loadReviewPatch(
  scope: SessionScope,
  diff: Extract<SidebarDiffRef, { kind: 'review' }>,
): Promise<{ diff: string }> {
  const base = diff.repoRoot ?? diff.worktree ?? scope.cwd
  const paths = diff.paths.map(path => resolveSidebarPath(base, path))
  if (paths.length === 0) return { diff: '' }
  const scopeWithRepo = { ...scope, ...(diff.repoRoot !== undefined ? { repoRoot: diff.repoRoot } : {}) }
  const status = await api.gitStatus(scopeWithRepo, diff.worktree)
  if (!status.isRepo || status.root === undefined || status.root === '') {
    throw new Error(t('notRepo'))
  }
  const untracked = new Set<string>()
  for (const entry of status.entries) {
    if (entry.xy === '??') untracked.add(normKey(joinRoot(status.root, entry.path)))
  }
  const patches: string[] = []
  let failures = 0
  let firstError: string | undefined
  for (const path of paths) {
    try {
      if (untracked.has(normKey(path))) {
        const text = await api.fsRead(scopeWithRepo, path)
        if (text.kind === 'text' && text.content !== '') patches.push(synthesizeAdditionPatch(path, text.content, status.root))
        continue
      }
      const result = await api.gitDiff(scopeWithRepo, path, false, diff.worktree)
      if (result.diff !== '') {
        patches.push(result.diff)
        continue
      }
      // The change may sit on the OTHER side (staged after the tab opened).
      const other = await api.gitDiff(scopeWithRepo, path, true, diff.worktree)
      if (other.diff !== '') patches.push(other.diff)
    } catch (reason) {
      failures += 1
      firstError ??= reason instanceof Error ? reason.message : String(reason)
    }
  }
  if (patches.length === 0) {
    if (failures === paths.length && firstError !== undefined) throw new Error(firstError)
    return { diff: '' }
  }
  return { diff: patches.join('\n') }
}

export function DiffTab(props: { sessionId: string; cwd: string | undefined; diff: SidebarDiffRef }) {
  const { sessionId, cwd, diff } = props
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DiffData | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback((): void => { setTick(value => value + 1) }, [])

  useEffect(() => {
    let cancelled = false
    const scope: SessionScope = { sessionId, cwd, ...(diff.repoRoot !== undefined ? { repoRoot: diff.repoRoot } : {}) }
    setLoading(true)
    setError(null)
    setData(null)
    const load = async (): Promise<void> => {
      try {
        if (diff.kind === 'review') {
          const result = await loadReviewPatch(scope, diff)
          if (!cancelled) setData({ diff: result.diff })
          return
        }
        if (diff.kind === 'commit') {
          const result = await api.gitCommitDiff(scope, diff.hashFull, diff.worktree)
          if (!cancelled) setData({ diff: result.diff })
          return
        }
        let result = await api.gitDiff(scope, diff.path, diff.staged, diff.worktree)
        if (result.diff === '') {
          // The requested side is empty — try the OTHER side once: the ref
          // may predate the staged-flag fix, or the change moved sides (a
          // file staged after its tab opened). Both sides empty means the
          // file genuinely has no text changes.
          const other = await api.gitDiff(scope, diff.path, !diff.staged, diff.worktree)
          if (other.diff !== '') result = other
        }
        if (result.diff !== '') {
          if (!cancelled) setData({ diff: result.diff })
          return
        }
        // Empty diff: an untracked file (git diff never lists it) falls back
        // to a full-file addition; anything else is a genuine no-text-change.
        if (diff.untracked === true && !diff.staged) {
          // A child-repo path is relative to diff.repoRoot, not the session
          // cwd or the linked-worktree root; resolve against whichever the
          // diff ref carries so the untracked fallback reads the right file.
          const text = await api.fsRead(scope, resolveSidebarPath(diff.repoRoot ?? diff.worktree ?? cwd, diff.path))
          if (!cancelled) {
            setData(text.kind === 'text' ? { diff: '', untracked: text.content } : { diff: '' })
          }
          return
        }
        if (!cancelled) setData({ diff: '' })
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [sessionId, cwd, diff, tick])

  const title = diff.kind === 'review'
    ? `${t('review')} · ${diff.paths.length}`
    : diff.kind === 'worktree' ? diff.path : `${diff.hash} ${diff.subject}`

  return (
    <div className={css.gitDiffTab}>
      <div className={css.gitDiffTabHeader}>
        <span className={css.gitDiffTabTitle} title={title}>
          {title}
        </span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={refresh}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>
      {loading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && <div className={css.gitError}>{t('diffLoadError')}: {error}</div>}
      {!loading && error === null && data !== null && (
        <>
          {data.untracked !== undefined
            ? <DiffView diff="" untrackedPath={diff.kind === 'worktree' ? diff.path : ''} untrackedContent={data.untracked} />
            : <DiffView diff={data.diff} />}
          {data.diff === '' && data.untracked === undefined && (
            <div className={css.gitEmpty}>{t('diffEmpty')}</div>
          )}
        </>
      )}
    </div>
  )
}