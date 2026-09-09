/**
 * The FULL-PAGE "Global Workspace" view: the complete-page face of the global
 * info content (vs the compact panel tab). It renders IN PLACE as the DSH
 * center column — the chat box's page area — by dynamically registering into
 * the official `conversation` slot at priority -1 (lowest renders → shadows
 * the shipped ui-conversation ConversationRoot), so the main content area
 * literally becomes the global workspace page; closing disposes the
 * registration and the chat comes back (session state lives in stores,
 * untouched).
 *
 * THE GLOBAL WORKSPACE IS A SPECIAL SESSION. It occupies the chat box's
 * layout position (the conversation slot) but owns its OWN sidebar state —
 * the virtual `global-workspace` session (GLOBAL_WORKSPACE_SESSION_ID) in
 * the sidebar store — including a WORKBENCH that no real session touches. A
 * globally shared window is NOT opened in the current session: clicking its
 * strip tab ATTACHES it into this page's workbench (attachGlobal → the stub
 * lands in the virtual session's `bottomSplits` and attaches to the same
 * `shared:gb:<n>` pty), and the terminal renders live right here.
 * Attachments persist in the virtual session's layout and survive reloads.
 *
 * THE PAGE READS LIKE A TABBY-STYLE GLOBAL TERMINAL. Chrome is minimal:
 *
 *   - a slim toolbar (title + one-line desc);
 *   - the TAB STRIP below it — every global window is a tab. Windows already
 *     attached into the workbench lead the strip; PARKED windows (defined in
 *     the global blob but not attached) sit at the tail behind a divider,
 *     dimmed. Attached tab: click → activate; ✕ → DETACH (the window keeps
 *     its pty and returns to the parked group — non-destructive). Parked
 *     tab: click → attach + open; ✕ → UNBIND from the whole instance
 *     (closes it everywhere, releasing its shared pty). The strip's trailing
 *     + mints a brand-new global terminal (tabby-style quick-add) and opens
 *     it immediately;
 *   - the WORKBENCH fills everything below the strip (no more fixed-height
 *     bottom box): the active terminal renders full-bleed, all attached
 *     terminals stay mounted (their pty connections survive tab switches),
 *     and the per-pane tab strips are suppressed (hideTabBar) — the page's
 *     own strip drives the tabs.
 *
 * The body falls back to a hero when nothing is attached yet: a "new
 * terminal" CTA when the Global Workspace is empty, or a hint to click a
 * parked tab above when windows exist but none is attached.
 *
 * Closed by Escape (or by opening a session — the page opens from the
 * no-session hero).
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconCloseFill14, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './locales.ts'
import type { Context } from '../context-types.ts'
import {
  GLOBAL_WORKSPACE_SESSION_ID, activateTab, isBoundTabId, isGlobalTabId, leafWithTab, resizeSplitIn,
  type SidebarLeaf, type SidebarStore, type SidebarTab, type SplitNode, type WorkspaceWindow,
} from './state.ts'
import type { WorkspaceWindowsStore } from './workspace-windows.ts'
import { LazyTerminal } from './builtins/tabs.tsx'
import { setGlobalPageOpen } from './global-page.ts'
import { IconGlobalWorkspaceOutline16, IconTerminalOutline16 } from './icons.tsx'
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

/** The full-page global workspace surface (rendered as the center column). */
export function GlobalPage(props: { ctx: Context; store: SidebarStore; windows?: WorkspaceWindowsStore }) {
  const { ctx, store, windows } = props
  const close = (): void => { setGlobalPageOpen(false) }

  // Live global windows: subscribe to the windows store so a bind/unbind
  // while the page is open re-renders the strip in place.
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

  // Resolve a stub to its LIVE definition (title/… from the global blob), so
  // a retitle in any attached view re-renders the strip's label.
  const resolveTab = useCallback((tab: SidebarTab): SidebarTab => {
    if (!isBoundTabId(tab.id)) return tab
    const known = globalWindows.find(window => window.id === tab.id)
    return known === undefined ? tab : { ...tab, ...known }
  }, [globalWindows])

  // The attached terminal stubs in the page's workbench (the virtual
  // session's bottom tree — flattened across leaves), each resolved to its
  // live definition. The workbench keeps every attached window MOUNTED, so
  // switching strips tabs never tears a pty connection down.
  const attachedTabs = useMemo(() => {
    if (globalState === undefined) return []
    return allTabsOf(globalState.bottomSplits)
      .filter(tab => isGlobalTabId(tab.id))
      .map(resolveTab)
  }, [globalState, resolveTab])

  // The ACTIVE stub per leaf (a multi-leaf tree has one active per pane —
  // the strip highlights them all).
  const activeStubIds = useMemo(() => {
    const set = new Set<string>()
    if (globalState !== undefined) {
      walkLeaves(globalState.bottomSplits, leaf => { if (leaf.active !== null) set.add(leaf.active) })
    }
    return set
  }, [globalState])

  // Parked windows: defined in the global blob but NOT attached into the
  // workbench — they render at the strip's tail, dimmed.
  const attachedIds = useMemo(() => new Set(attachedTabs.map(tab => tab.id)), [attachedTabs])
  const parkedWindows = useMemo(
    () => globalWindows.filter(window => !attachedIds.has(window.id)),
    [globalWindows, attachedIds],
  )

  // The workbench renders whenever the tree holds ANY tab (attached stubs;
  // a legacy stray non-global tab still gets shown, not swallowed by the
  // hero).
  const hasWorkbenchContent = useMemo(
    () => globalState !== undefined && allTabsOf(globalState.bottomSplits).length > 0,
    [globalState],
  )

  // Activate an attached stub wherever it sits (strip click / workbench).
  const activateStub = (tabId: string): void => {
    store.reduceFor(GLOBAL_WORKSPACE_SESSION_ID, s => {
      const leaf = leafWithTab(s.bottomSplits, tabId)
      if (leaf === undefined) return s
      return activateTab(s, leaf.id, tabId)
    })
  }

  // The workbench's actions: every mutation targets the virtual
  // global-workspace session via reduceFor (no UI switch, page re-renders
  // through its per-session subscription). Closing a stub DETACHES it from
  // the workspace (the window and its shared pty live on).
  const actions: WorkbenchActions = useMemo(() => ({
    closeTab: (_paneId, tabId) => { windows?.detachGlobal(tabId, GLOBAL_WORKSPACE_SESSION_ID) },
    activateTab: (_paneId, tabId) => activateStub(tabId),
    renameTab: () => {},
    focusPane: (paneId) => {
      store.reduceFor(GLOBAL_WORKSPACE_SESSION_ID, s => ({ ...s, activePane: paneId }))
    },
    moveTabToEdge: () => {},
    moveTabBefore: () => {},
    resizeSplit: (splitId, index, deltaFrac) => {
      store.reduceFor(GLOBAL_WORKSPACE_SESSION_ID, s => resizeSplitIn(s, splitId, index, deltaFrac))
    },
  }), [store, windows, activateStub])

  const newTerminal = (): void => {
    try { windows?.createGlobalTerminal() } catch { /* best-effort */ }
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
      {/* Slim toolbar: title + one-line desc (the tabby-style chrome — no
          big hero header, no count (the tab strip already shows every
          window), no close button: Esc / opening a session dismiss the
          page). */}
      <div className={css.globalToolbar}>
        <div className={css.globalToolbarText}>
          <span className={css.globalToolbarTitle}>{t('globalInfo')}</span>
          <span className={css.globalToolbarDesc}>{t('globalInfoDesc')}</span>
        </div>
      </div>

      {/* The TAB STRIP: attached windows lead, parked windows dim at the
          tail behind a divider, + mints a fresh global terminal. */}
      <div className={css.globalStrip}>
        <div className={css.globalStripTabs}>
          {attachedTabs.map(tab => (
            <GlobalStripTab
              key={tab.id}
              id={tab.id}
              title={tab.title}
              attached
              active={activeStubIds.has(tab.id)}
              tooltip={tab.title}
              closeLabel={t('globalInfoDetach')}
              onActivate={() => activateStub(tab.id)}
              onClose={() => { windows?.detachGlobal(tab.id, GLOBAL_WORKSPACE_SESSION_ID) }}
            />
          ))}
          {parkedWindows.length > 0 && <div className={css.tabBarDivider} />}
          {parkedWindows.map(window => (
            <GlobalStripTab
              key={window.id}
              id={window.id}
              title={window.title}
              attached={false}
              active={false}
              tooltip={`${window.title} — ${t('globalInfoParked')}`}
              closeLabel={t('unbindGlobal')}
              onActivate={() => { windows?.attachGlobal(window.id) }}
              onClose={() => { windows?.unbindGlobal(window.id, false) }}
            />
          ))}
          <button
            type="button"
            className={css.tabBarPlus}
            aria-label={t('newTerminal')}
            title={t('newTerminal')}
            onClick={newTerminal}
          >
            <IconPlusOutline16 size={14} />
          </button>
        </div>
      </div>

      {/* The WORKBENCH fills the page below the strip (no fixed-height box):
          the active terminal renders full-bleed; every attached terminal
          stays mounted. No attached window → a hero guides the next step. */}
      <div className={css.globalPageMain}>
        {hasWorkbenchContent && globalState !== undefined ? (
          <Workbench
            state={globalState}
            tree={globalState.bottomSplits}
            newTabOptions={[]}
            actions={actions}
            onNewTab={() => {}}
            renderTab={(tab) => renderGlobalTab(ctx, tab, store, windows, resolveTab)}
            getTabIcon={globalTabIconOf}
            // The page workbench holds ONLY global-window stubs, and its ✕
            // DETACHES (the window stays in the strip — non-destructive):
            // never treat them as "bound". The page's own strip hides the
            // per-pane tab bars (hideTabBar) — it IS the tab surface.
            isBoundTabId={() => false}
            resolveTab={resolveTab}
            hideTabBar
          />
        ) : (
          <GlobalPageHero
            hasWindows={globalWindows.length > 0}
            onNewTerminal={newTerminal}
          />
        )}
      </div>
    </div>
  )
}

/** One strip tab: the label button (click = activate/attach) plus the close
 *  button (✕ = detach when attached, unbind when parked). Attached tabs are
 *  live (normal ink, active highlight); parked tabs are dimmed. */
function GlobalStripTab(props: {
  id: string
  title: string
  attached: boolean
  active: boolean
  tooltip: string
  closeLabel: string
  onActivate: () => void
  onClose: () => void
}) {
  const { id, title, attached, active, tooltip, closeLabel, onActivate, onClose } = props
  return (
    <div
      className={clsx(css.tab, active && css.tabActive, !attached && css.globalStripParked)}
      data-dsh-tab-id={id}
      title={tooltip}
    >
      <button
        type="button"
        className={css.globalStripTabMain}
        onClick={onActivate}
      >
        <span className={css.globalStripTabIcon}>
          {attached ? <IconTerminalOutline16 size={13} /> : <IconGlobalWorkspaceOutline16 size={13} />}
        </span>
        <span className={css.tabTitle}>{title}</span>
      </button>
      <button
        type="button"
        className={css.tabClose}
        aria-label={closeLabel}
        title={closeLabel}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <IconCloseFill14 />
      </button>
    </div>
  )
}

/** The main-area hero: a "new terminal" CTA when the Global Workspace holds
 *  nothing yet, or a hint to click a parked tab above when windows exist but
 *  none is attached into the workbench. */
function GlobalPageHero(props: { hasWindows: boolean; onNewTerminal: () => void }) {
  const { hasWindows, onNewTerminal } = props
  return (
    <div className={css.globalEmpty}>
      <span className={css.globalEmptyIcon}><IconGlobalWorkspaceOutline16 size={22} /></span>
      <span className={css.globalEmptyTitle}>
        {hasWindows ? t('globalInfoWorkbenchEmpty') : t('globalInfoEmptyTitle')}
      </span>
      <span className={css.globalEmptyHint}>
        {hasWindows ? t('globalInfoWorkbenchEmptyHint') : t('globalInfoEmpty')}
      </span>
      <button type="button" className={css.globalEmptyAction} onClick={onNewTerminal}>
        <IconPlusOutline16 size={13} />
        {t('newTerminal')}
      </button>
    </div>
  )
}

/** The terminal tab body in the page's workbench: the chunk-loaded
 *  TerminalView attaches to the stub's shared `gb:` pty. */
function renderGlobalTab(
  ctx: Context,
  tab: SidebarTab,
  store: SidebarStore,
  windows: WorkspaceWindowsStore | undefined,
  resolveTab: (tab: SidebarTab) => SidebarTab,
): React.ReactNode {
  const resolved = resolveTab(tab)
  if (tab.type === 'terminal' && isGlobalTabId(tab.id)) {
    return (
      <LazyTerminal
        ctx={ctx}
        scope={{ sessionId: GLOBAL_WORKSPACE_SESSION_ID }}
        store={store}
        tabId={tab.id}
        infoBar
        onTitleChange={(title) => { try { windows?.update(tab.id, { title }) } catch { /* best-effort retitle */ } }}
      />
    )
  }
  return <div className={css.globalPageTabFallback}>{resolved.title}</div>
}

/** The tab strip icon in the page's workbench (terminals only). */
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

/** Visit every leaf of a split tree, depth-first. */
function walkLeaves(node: SplitNode, visit: (leaf: SidebarLeaf) => void): void {
  if (node.kind === 'leaf') { visit(node); return }
  for (const child of node.children) walkLeaves(child, visit)
}