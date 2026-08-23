/**
 * The FULL-PAGE "Global info" view: the complete-page face of the global
 * info content (vs the compact panel tab). It renders IN PLACE as the DSH
 * center column — the chat box's page area — by dynamically registering into
 * the official `conversation` slot at priority -1 (lowest renders → shadows
 * the shipped ui-conversation ConversationRoot), so the main content area
 * literally becomes the global info page; closing disposes the registration
 * and the chat comes back (session state lives in stores, untouched).
 *
 * THE GLOBAL WORKSPACE IS A SPECIAL SESSION. It occupies the chat box's
 * layout position (the conversation slot) but owns its OWN sidebar state —
 * the virtual `global-workspace` session (GLOBAL_WORKSPACE_SESSION_ID) in
 * the sidebar store — including a BOTTOM WORKBENCH ("下方的 box") that no
 * real session touches. A globally shared window is NOT opened in the
 * current session: clicking its card ATTACHES it into this page's bottom
 * workbench (attachGlobal → the stub lands in the virtual session's
 * `bottomSplits` and attaches to the same `shared:gb:<n>` pty), and the
 * terminal renders live right here. Attachments persist in the virtual
 * session's layout and survive reloads.
 *
 * Card actions:
 * - card click → attach the window into the page's own bottom workbench
 *   (the page stays open; real sessions are never touched);
 * - card ✕ → unbind the window from the whole instance (closes it
 *   everywhere, releasing its shared pty).
 *
 * The bottom workbench renders the virtual session's bottom tree through
 * the same Workbench the sidebar uses; a terminal stub's ✕ DETACHES it from
 * the global workspace only (the window and its pty stay alive in the
 * card list).
 *
 * Content uses the same `GlobalInfoList` the panel tab uses, styled with the
 * DSH settings "icon card" recipe (SideCardSection) so the page reads
 * consistently with the app's settings UI. Closed by Escape (or by opening a
 * session — the page opens from the no-session hero).
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './locales.ts'
import type { Context } from '../context-types.ts'
import {
  GLOBAL_WORKSPACE_SESSION_ID, activateTab, isBoundTabId, isGlobalTabId, leafWithTab, resizeSplitIn,
  type SidebarStore, type SidebarTab, type SplitNode, type WorkspaceWindow,
} from './state.ts'
import type { WorkspaceWindowsStore } from './workspace-windows.ts'
import { GlobalInfoList } from './GlobalView.tsx'
import { LazyTerminal } from './builtins/tabs.tsx'
import { setGlobalPageOpen } from './global-page.ts'
import { IconTerminalOutline16, IconPanelBottomOutline16 } from './icons.tsx'
import { Workbench, type WorkbenchActions } from './split-pane.tsx'
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
  store: SidebarStore,
  windows: WorkspaceWindowsStore | undefined,
): (() => void) | undefined {
  if (ctx.slots === undefined) return undefined
  return ctx.slots.register({
    name: 'conversation',
    id: GLOBAL_CONVERSATION_ENTRY,
    priority: -1,
  }, (_props: unknown) => <GlobalPage ctx={ctx} store={store} windows={windows} />)
}

/** The full-page global info surface (rendered as the center column). */
export function GlobalPage(props: { ctx: Context; store: SidebarStore; windows?: WorkspaceWindowsStore }) {
  const { ctx, store, windows } = props
  const close = (): void => { setGlobalPageOpen(false) }

  // Live global windows: subscribe to the windows store so a bind/unbind
  // while the page is open re-renders the list in place.
  const globalWindows = useSyncExternalStore(
    (callback: () => void) => windows?.subscribe(callback) ?? (() => {}),
    () => windows?.getSnapshot().global ?? NO_WINDOWS,
  )

  // The virtual `global-workspace` session's state: the page IS this
  // session's view, so it subscribes to THAT session (per-session
  // subscription — targeted attach/detach changes re-render the page
  // without disturbing the sidebar's active session).
  const globalState = useSyncExternalStore(
    (callback: () => void) => store.subscribeOf(GLOBAL_WORKSPACE_SESSION_ID, callback),
    () => store.getStateOf(GLOBAL_WORKSPACE_SESSION_ID),
  )

  // The attached terminal stubs in the page's bottom workbench (the virtual
  // session's bottom tree — only terminal windows ever attach here).
  const bottomTabs = useMemo(() => {
    if (globalState === undefined) return []
    return allTabsOf(globalState.bottomSplits).filter(tab => isGlobalTabId(tab.id))
  }, [globalState])
  const bottomOpen = globalState?.bottomOpen === true

  // Resolve a stub to its LIVE definition (title/… from the global blob), so
  // a retitle in any attached view re-renders the page's tab strip.
  const resolveTab = (tab: SidebarTab): SidebarTab => {
    if (!isBoundTabId(tab.id)) return tab
    const known = globalWindows.find(window => window.id === tab.id)
    return known === undefined ? tab : { ...tab, ...known }
  }

  // The bottom workbench's actions: every mutation targets the virtual
  // global-workspace session via reduceFor (no UI switch, page re-renders
  // through its per-session subscription). Closing a stub DETACHES it from
  // the global workspace (the window and its shared pty live on).
  const actions: WorkbenchActions = useMemo(() => ({
    closeTab: (_paneId, tabId) => { windows?.detachGlobal(tabId, GLOBAL_WORKSPACE_SESSION_ID) },
    activateTab: (_paneId, tabId) => {
      store.reduceFor(GLOBAL_WORKSPACE_SESSION_ID, s => {
        const leaf = leafWithTab(s.bottomSplits, tabId)
        if (leaf === undefined) return s
        return activateTab(s, leaf.id, tabId)
      })
    },
    renameTab: () => {},
    focusPane: (paneId) => {
      store.reduceFor(GLOBAL_WORKSPACE_SESSION_ID, s => ({ ...s, activePane: paneId }))
    },
    moveTabToEdge: () => {},
    moveTabBefore: () => {},
    resizeSplit: (splitId, index, deltaFrac) => {
      store.reduceFor(GLOBAL_WORKSPACE_SESSION_ID, s => resizeSplitIn(s, splitId, index, deltaFrac))
    },
  }), [store, windows])

  const toggleBottom = (): void => {
    store.reduceFor(GLOBAL_WORKSPACE_SESSION_ID, s => ({ ...s, bottomOpen: !s.bottomOpen }))
  }

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
          <GlobalInfoList
            ctx={ctx}
            globalWindows={globalWindows}
            onAttach={(window) => { windows?.attachGlobal(window.id) }}
            onUnbind={(window) => { windows?.unbindGlobal(window.id, false) }}
          />
        </div>
      </div>
      {bottomTabs.length > 0 && (
        <div className={css.globalPageBottom}>
          <div className={css.globalPageBottomHeader}>
            <span className={css.globalPageBottomTitle}>{t('globalInfoBottomWorkbench')}</span>
            <span className={css.globalGroupCount}>{bottomTabs.length}</span>
            {bottomOpen ? (
              <button
                type="button"
                className={css.globalPageBottomToggle}
                aria-label={t('collapseBottomPanel')}
                title={t('collapseBottomPanel')}
                onClick={toggleBottom}
              >
                <IconCloseFill14 />
              </button>
            ) : (
              <button
                type="button"
                className={css.globalPageBottomToggle}
                aria-label={t('expandBottomPanel')}
                title={t('expandBottomPanel')}
                onClick={toggleBottom}
              >
                <IconPanelBottomOutline16 size={14} />
              </button>
            )}
          </div>
          {bottomOpen && (
            <div className={css.globalPageBottomBody}>
              <Workbench
                state={globalState!}
                tree={globalState!.bottomSplits}
                newTabOptions={[]}
                actions={actions}
                onNewTab={() => {}}
                renderTab={(tab) => renderGlobalTab(tab, store, windows, resolveTab)}
                getTabIcon={globalTabIconOf}
                isBoundTabId={isBoundTabId}
                resolveTab={resolveTab}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The terminal tab body in the page's bottom workbench: the chunk-loaded
 *  TerminalView attaches to the stub's shared `gb:` pty. */
function renderGlobalTab(
  tab: SidebarTab,
  store: SidebarStore,
  windows: WorkspaceWindowsStore | undefined,
  resolveTab: (tab: SidebarTab) => SidebarTab,
): React.ReactNode {
  const resolved = resolveTab(tab)
  if (tab.type === 'terminal' && isGlobalTabId(tab.id)) {
    return (
      <LazyTerminal
        scope={{ sessionId: GLOBAL_WORKSPACE_SESSION_ID }}
        store={store}
        tabId={tab.id}
        onTitleChange={(title) => { try { windows?.update(tab.id, { title }) } catch { /* best-effort retitle */ } }}
      />
    )
  }
  return <div className={css.globalPageTabFallback}>{resolved.title}</div>
}

/** The tab strip icon in the page's bottom workbench (terminals only). */
function globalTabIconOf(tab: SidebarTab): React.ReactNode {
  return tab.type === 'terminal'
    ? <IconTerminalOutline16 size={14} />
    : <IconCloseFill14 size={14} />
}

/** All tabs of a split tree, depth-first. */
function allTabsOf(node: SplitNode): SidebarTab[] {
  if (node.kind === 'leaf') return node.tabs
  return node.children.flatMap(allTabsOf)
}
