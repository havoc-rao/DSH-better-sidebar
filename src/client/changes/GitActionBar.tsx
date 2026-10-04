import { createElement, useEffect, useState, type ReactNode } from 'react'
import { Button, IconEllipsisOutlineRegular, Input, Menu, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitCommitActionDescriptor, GitCommitActionProps } from '../service.ts'
import { RenderBoundary } from '../RenderBoundary.tsx'
import { t } from '../locales.ts'
import { GitActionSlotHost, type GitActionSlotProps } from './git-action-slot.tsx'
import css from './changes.module.css'

/** Only Commit / More stay in reach. Every secondary command and plugin
 * control lives in More, without scraping DOM or synthesizing clicks. */
export function GitActionBar(props: {
  owner: GitActionSlotProps
  canCommit: boolean
  canPush: boolean
  loadingLabel?: string | null
  commit(): void
  push(): void
  commitAndPush(): void
  stageAll(staged: boolean): void
  actions: readonly { descriptor: GitCommitActionDescriptor; props: GitCommitActionProps }[]
  error: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  const { owner } = props
  useEffect(() => { setOpen(false) }, [owner.scope.sessionId, owner.repoRoot, owner.worktree, owner.busy])
  const renderAction = ({ descriptor, props: actionProps }: typeof props.actions[number]): ReactNode => (
    <RenderBoundary key={descriptor.id} className={css.gitCommitActionBoundary}>
      {createElement(descriptor.component, actionProps)}
    </RenderBoundary>
  )
  return (
    <div className={css.commitBar} data-git-action-bar aria-busy={owner.busy}>
      <div className={css.commitRow}>
        <Input className={css.commitInput} placeholder={t('commitPlaceholder')}
          value={owner.commitMessage} disabled={owner.busy}
          onChange={event => { owner.setCommitMessage(event.target.value) }}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && props.canCommit) {
              event.preventDefault()
              props.commit()
            }
          }} />
        <Button variant="primary" size="sm" disabled={!props.canCommit} onClick={props.commit}>{t('commit')}</Button>
        <Menu open={open && !owner.busy} onClose={() => { setOpen(false) }} portal side="top" align="end"
          listClassName={css.gitMoreMenu}
          anchor={<Button variant="outline" size="sm" icon={<IconEllipsisOutlineRegular size={16} />}
            disabled={owner.busy} aria-label={t('gitMoreActions')} title={t('gitMoreActions')}
            aria-haspopup="menu" aria-expanded={open && !owner.busy}
            onClick={() => { setOpen(value => !value) }} />}
          items={[
            { id: 'push', label: t('gitPush'), disabled: !props.canPush },
            { id: 'commit-push', label: t('gitCommitAndPush'), disabled: !props.canCommit || !props.canPush },
            { id: 'stage-all', label: t('stageAll'), disabled: owner.busy || !owner.status.entries.some(entry => entry.xy === '??' || entry.xy[1] !== ' ') },
            { id: 'unstage-all', label: t('unstageAll'), disabled: owner.busy || owner.staged.length === 0 },
          ]}
          onSelect={id => {
            setOpen(false)
            if (id === 'push') props.push()
            else if (id === 'commit-push') props.commitAndPush()
            else props.stageAll(id === 'unstage-all')
          }}>
          {props.actions.map(renderAction)}
          <GitActionSlotHost owner={{ ...owner, close: () => { setOpen(false) } }} />
        </Menu>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" hidden={!owner.busy || props.loadingLabel == null}>
        {owner.busy && props.loadingLabel != null && (
          <span className={css.gitActionLoading}>
            <StateDot state="ongoing" size={14} aria-hidden="true" />
            {props.loadingLabel}…
          </span>
        )}
      </div>
      {props.error}
    </div>
  )
}
