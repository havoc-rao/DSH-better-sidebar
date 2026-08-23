/**
 * The "Global info" content: records all INSTANCE-level global state — today
 * the globally shared windows (the `gb:` "all projects" terminals created via
 * the tab right-click → "全局共享"), each shown as a settings-style icon card
 * (the DSH "icon 设置" recipe: responsive grid, icon chip + title + a
 * live/shared badge).
 *
 * A global window's ENTIRE lifecycle (its one shared PTY / xterm session)
 * lives in the Global Workspace: binding it parks the window here as a card
 * and it is NOT merged into any session's tab bar. One-click card actions:
 * - clicking a card ATTACHES the window to the current session (the `gb:`
 *   stub lands in this session's first leaf and focuses it — the terminal
 *   view attaches to the same shared pty; an already-attached session just
 *   focuses the stub);
 * - the card's ✕ unbinds the window from the whole instance (closes it
 *   everywhere, releasing the shared pty).
 *
 * Two faces share one body (`GlobalInfoList`):
 * - `GlobalView` — the panel TAB face (TabComponentProps): the card grid with
 *   an "expand to full page" affordance.
 * - `GlobalPage` — the FULL-PAGE face: the same card grid under a page header
 *   (the "core page / complete page" the official left sidebar's footer
 *   button opens).
 *
 * The list rides the host-side `globalWindows` extra on TabComponentProps
 * (the renderer feeds it from the workspace windows store's instance-level
 * blob), so both faces always reflect the same source of truth the attached
 * stubs render from — no duplicated state.
 */
import { useMemo } from 'react'
import { IconCheckOutline16, IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** Attach a window to the session this face is bound to (card click). */
  onAttach?: (window: WorkspaceWindow) => void
  /** Unbind a window from the whole instance (card ✕). */
  onUnbind?: (window: WorkspaceWindow) => void
}) {
  const { ctx, globalWindows, onAttach, onUnbind } = props
  const global = useMemo(() => globalWindows ?? [], [globalWindows])
  const count = global.length

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
            title={onAttach === undefined ? undefined : t('globalInfoAttach')}
            onClick={() => { onAttach?.(window) }}
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
          {onUnbind !== undefined && (
            <button
              type="button"
              className={css.globalCardClose}
              aria-label={t('unbindGlobal')}
              title={t('unbindGlobal')}
              onClick={(event) => {
                event.stopPropagation()
                onUnbind(window)
              }}
            >
              <IconCloseFill14 />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** The "Global info" TAB body (the compact panel face). */
export function GlobalView(props: TabComponentProps) {
  const { ctx, globalWindows, onAttachGlobal, onUnbindGlobal } = props
  return (
    <div className={css.globalTab}>
      <GlobalInfoList
        ctx={ctx}
        globalWindows={globalWindows}
        onAttach={onAttachGlobal === undefined ? undefined : (window) => { onAttachGlobal(window.id) }}
        onUnbind={onUnbindGlobal === undefined ? undefined : (window) => { onUnbindGlobal(window.id) }}
      />
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
