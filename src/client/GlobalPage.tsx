/**
 * The FULL-PAGE "Global info" view: the complete-page face of the global
 * info content (vs the compact panel tab). It renders IN PLACE as the DSH
 * center column — the chat box's page area — by dynamically registering into
 * the official `conversation` slot at priority -1 (lowest renders → shadows
 * the shipped ui-conversation ConversationRoot), so the main content area
 * literally becomes the global info page; closing disposes the registration
 * and the chat comes back (session state lives in stores, untouched).
 *
 * The page is a plain column surface (no fixed overlay, no measurement): the
 * official layout gives it the conversation column's box. It reads the
 * global windows LIVE through the workspace windows store's subscription, so
 * bind/unbind while the page is open re-renders it in place.
 *
 * Content uses the same `GlobalInfoList` the panel tab uses, styled with the
 * DSH settings "icon card" recipe (SideCardSection) so the page reads
 * consistently with the app's settings UI. Closed by Escape (or by opening a
 * session — the page opens from the no-session hero).
 *
 * Card actions on the page: the page is a NO-SESSION surface (opening it
 * cleared the active session), so a card click has no session to attach the
 * window to — it closes the page, attaches the window to the session that
 * was current when the page opened (captured by openGlobalPage), and
 * re-activates that session ("take me back with this terminal"). The card ✕
 * unbinds the window from the whole instance (closes it everywhere) without
 * leaving the page — the list re-renders live.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { t } from './locales.ts'
import type { Context } from '../context-types.ts'
import type { WorkspaceWindow } from './state.ts'
import type { WorkspaceWindowsStore } from './workspace-windows.ts'
import { GlobalInfoList } from './GlobalView.tsx'
import { getGlobalPageSessionBeforeOpen, setGlobalPageOpen } from './global-page.ts'
import css from './sidebar.module.css'

/** The conversation-slot entry id (also the diagnostics label). */
export const GLOBAL_CONVERSATION_ENTRY = 'dsh-better-sidebar:global-info'

/** Stable empty snapshot for useSyncExternalStore (never re-allocated). */
const NO_WINDOWS: readonly WorkspaceWindow[] = []

/**
 * Take over the official `conversation` slot while the global page is open:
 * registers a surface entry at priority -1 — the ui-slots shadowing rule is
 * "lowest priority renders", and ui-conversation registers at the default 0
 * — so our entry wins the cell and the center column renders the global
 * page. The disposer restores the official conversation (session state is in
 * stores, untouched). No-op (undefined) when the slots service is absent.
 */
export function registerGlobalPageSurface(
  ctx: Context,
  windows: WorkspaceWindowsStore | undefined,
): (() => void) | undefined {
  if (ctx.slots === undefined) return undefined
  return ctx.slots.register({
    name: 'conversation',
    id: GLOBAL_CONVERSATION_ENTRY,
    priority: -1,
  }, (_props: unknown) => <GlobalPage ctx={ctx} windows={windows} />)
}

/** The full-page global info surface (rendered as the center column). */
export function GlobalPage(props: { ctx: Context; windows?: WorkspaceWindowsStore }) {
  const { ctx, windows } = props
  const close = (): void => { setGlobalPageOpen(false) }

  // Live global windows: subscribe to the windows store so a bind/unbind
  // while the page is open re-renders the list in place.
  const globalWindows = useSyncExternalStore(
    (callback: () => void) => windows?.subscribe(callback) ?? (() => {}),
    () => windows?.getSnapshot().global ?? NO_WINDOWS,
  )

  // Escape closes the page (the page owns the center area, so it owns its
  // dismissal key — no conflict with sidebar keybindings).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [])

  // A card click on the page has no CURRENT session (the page opened from
  // the hero): close the page and restore the session it was opened from,
  // with the clicked window attached there (attachGlobal targets that
  // session through the store's reduceFor path; re-activating it shows the
  // terminal). No session to restore (page opened from the hero with no
  // sessions at all) — the click is a no-op, the page stays as an overview.
  const attach = (window: WorkspaceWindow): void => {
    if (windows === undefined) return
    const before = getGlobalPageSessionBeforeOpen()
    if (before === undefined) return
    setGlobalPageOpen(false)
    windows.attachGlobal(window.id, before)
    try {
      ctx.sessions?.open?.(before)
    } catch {
      // Best-effort: a failed re-activation leaves the window attached in
      // that session's layout; the user opens the session themselves.
    }
  }

  const unbind = (window: WorkspaceWindow): void => {
    try {
      void windows?.unbindGlobal(window.id, false)
    } catch {
      // Never let a card ✕ take the page down (unknown/racing id).
    }
  }

  return (
    <div className={css.globalPage} role="main" aria-label={t('globalInfo')}>
      <div className={css.globalPageHeader}>
        <div className={css.globalPageHeaderText}>
          <span className={css.globalPageTitle}>{t('globalInfo')}</span>
          <span className={css.globalPageDesc}>{t('globalInfoDesc')}</span>
        </div>
      </div>
      <div className={css.globalPageBody}>
        <div className={css.globalGroup}>
          <div className={css.globalGroupHeading}>
            <span>{t('globalInfoSection')}</span>
            <span className={css.globalGroupCount}>{globalWindows.length}</span>
          </div>
          <GlobalInfoList ctx={ctx} globalWindows={globalWindows} onAttach={attach} onUnbind={unbind} />
        </div>
      </div>
    </div>
  )
}
