/**
 * The "Global info" content: records all INSTANCE-level global state — today
 * the globally shared windows (the `gb:` "all projects" terminals created via
 * the tab right-click → "全局共享"), each shown as a settings-style icon card
 * (the DSH "icon 设置" recipe: responsive grid, icon chip + title + a
 * live/shared badge) and one-click activatable to focus its stub in the
 * current session's tree.
 *
 * Two faces share one body (`GlobalInfoList`):
 * - `GlobalView` — the panel TAB face (TabComponentProps): the card grid with
 *   an "expand to full page" affordance.
 * - `GlobalPage` — the FULL-PAGE face: the same card grid under a page header
 *   with a close button (the "core page / complete page" the official left
 *   sidebar's footer button opens).
 *
 * The list rides the host-side `globalWindows` extra on TabComponentProps
 * (the renderer feeds it from the workspace windows store's instance-level
 * blob), so both faces always reflect the same source of truth the pinned
 * stubs render from — no duplicated state.
 */
import { useMemo } from 'react'
import { IconCheckOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconGlobeOutline16, IconTerminalOutline16 } from './icons.tsx'
import { t } from './locales.ts'
import type { Context } from '../context-types.ts'
import type { WorkspaceWindow } from './state.ts'
import type { TabComponentProps } from './service.ts'
import { openGlobalPage } from './global-page.ts'
import css from './sidebar.module.css'

/** The shared global-windows list body (both the tab and the full page). */
export function GlobalInfoList(props: {
  ctx: Context
  globalWindows?: readonly WorkspaceWindow[]
}) {
  const { ctx, globalWindows } = props
  const global = useMemo(() => globalWindows ?? [], [globalWindows])
  const count = global.length

  // Focus the shared window's stub in the current session: the `gb:` stub is
  // already merged into every session's tree by the workspace windows
  // reconcile, so activation is a pure focus (no open, no dedupe logic).
  const activate = (window: WorkspaceWindow): void => {
    try {
      ctx.betterSidebar?.activateTab(window.id)
    } catch {
      // The tab may have been unbound meanwhile; ignore.
    }
  }

  if (count === 0) {
    return (
      <div className={css.globalEmpty}>
        <span className={css.globalEmptyIcon}><IconGlobeOutline16 size={22} /></span>
        <span className={css.globalEmptyTitle}>{t('globalInfoEmptyTitle')}</span>
        <span className={css.globalEmptyHint}>{t('globalInfoEmpty')}</span>
      </div>
    )
  }

  // The settings "icon card" recipe: a responsive grid of small cards, each
  // card a live shared window (lit "on" like an enabled settings card).
  return (
    <div className={css.globalGrid}>
      {global.map(window => (
        <div key={window.id} className={`${css.globalCard} ${css.globalCardOn}`}>
          <button
            type="button"
            className={css.globalCardMain}
            onClick={() => { activate(window) }}
          >
            <span className={css.globalCardTop}>
              <span className={css.globalCardIconChip}>
                {window.type === 'terminal'
                  ? <IconTerminalOutline16 size={16} />
                  : <IconGlobeOutline16 size={16} />}
              </span>
              <span className={css.globalCardTitle}>{window.title}</span>
              <IconCheckOutline16 size={14} className={css.globalCardCheck} />
            </span>
            <span className={css.globalCardBadge}>{t('globalInfoSharedAll')}</span>
          </button>
        </div>
      ))}
    </div>
  )
}

/** The "Global info" TAB body (the compact panel face). */
export function GlobalView(props: TabComponentProps) {
  const { ctx, globalWindows } = props
  return (
    <div className={css.globalTab}>
      <GlobalInfoList ctx={ctx} globalWindows={globalWindows} />
      <button
        type="button"
        className={css.gitLink}
        onClick={() => { openGlobalPage(ctx) }}
      >
        {t('globalInfoExpand')}
      </button>
    </div>
  )
}
