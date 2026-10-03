/**
 * The diff tab: one change opened from the changes tab, like VSCode's diff
 * editor. A worktree ref loads the file's unified diff (`git diff`, staged or
 * not; untracked files — which git diff never covers — render as a full-file
 * addition from their content), a commit ref loads the commit's full patch
 * (`git.show`-style). The header carries a refresh button because the tab
 * stays mounted while the changes tab's staging/discard operations change the
 * very content it shows. Loading IS the shared `useGitDiffTarget` hook (the
 * changes tab's inline preview runs the same one, so the staged-side and
 * untracked fallbacks and the per-file fold cache cannot drift apart);
 * rendering goes through the shared {@link DiffFiles} renderer.
 */
import { useMemo } from 'react'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionScope } from './api.ts'
import type { SidebarDiffRef } from './state.ts'
import { DiffFiles } from './diff/DiffFiles.tsx'
import { parseUnifiedDiff } from './diff/rows.ts'
import { useGitDiffTarget } from './diff/use-git-diff.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

function diffRefTitle(diff: SidebarDiffRef): string {
  return diff.kind === 'proposed' ? diff.title : diff.kind === 'worktree' ? diff.path : `${diff.hash} ${diff.subject}`
}
export function DiffTab(props: { sessionId: string; cwd: string | undefined; diff: SidebarDiffRef; onOpenFile?: (path: string) => void; onOpenRow?: (path: string, newLine: number | null) => void }) {
  const { sessionId, cwd, diff } = props
  const scope = useMemo<SessionScope>(() => ({ sessionId, cwd }), [sessionId, cwd])
  const { loading, error, diffText, untracked, refresh, resolveFold } = useGitDiffTarget(diff, scope)

  const isProposed = diff.kind === 'proposed'
  const invalidPatch = isProposed && diff.patch.trim() !== '' && parseUnifiedDiff(diff.patch).files.length === 0
  return (
    <div className={css.gitDiffTab}>
      <div className={css.gitDiffTabHeader}>
        <span className={css.gitDiffTabTitle} title={diffRefTitle(diff)}>
          {diffRefTitle(diff)}
        </span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={refresh}
        >
          <IconRefreshOutlineRegular size={14} />
        </button>
      </div>
      {isProposed && (
        <div className={css.gitProposedNote}>
          {t('diffProposedNote')}
          {typeof diff.sourceRef === 'string' && diff.sourceRef !== ''
            ? ` · ${diff.sourceRef}`
            : null}
          {diff.truncated === true ? ` · ${t('diffProposedTruncated')}` : null}
        </div>
      )}
      {invalidPatch && <div className={css.gitError}>{t('diffUnparseable')}</div>}
      {loading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && <div className={css.gitError}>{t('diffLoadError')}: {error}</div>}
      {!loading && error === null && diffText !== null && (
        <>
          {untracked !== undefined
            ? <DiffFiles diff="" untrackedPath={diff.kind === 'worktree' ? diff.path : ''} untrackedContent={untracked} />
            : <DiffFiles diff={diffText} resolveFold={resolveFold} onOpenFile={props.onOpenFile} onOpenRow={props.onOpenRow} />}
          {diffText === '' && untracked === undefined && (
            <div className={css.gitEmpty}>{t('diffEmpty')}</div>
          )}
        </>
      )}
    </div>
  )
}
