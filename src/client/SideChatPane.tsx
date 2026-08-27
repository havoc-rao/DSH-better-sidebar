/**
 * The IDE-FULLSCREEN CHAT COLUMN (⌘⌥⇧B): the Side Chat section docked at the
 * panel's RIGHT edge — Cursor-style, the main conversation sits BEHIND the
 * fullscreen panel, so the chat column is the mode's conversation surface.
 *
 * The column MIRRORS the active pane's side-chat tabs instead of being a
 * separate thread store: whichever `sidechat` tab is active (or the most
 * recently opened one — the last in strip order) renders here, and a tab
 * click in the header strip switches the column's thread. The tab's full
 * lifecycle (create/thread/reopen/close) stays the regular tab flow; the
 * column is only its presentation surface inside the IDE. With NO sidechat
 * tab open the column shows the Side Chat hero, whose start button routes
 * through `openTab` (heroAction) so the click mints a REAL tab — the
 * synthetic hero tab cannot own a thread itself.
 *
 * The resize handle rides the column's LEFT edge (the editor|chat boundary):
 * dragging right widens the chat (and squeezes the editor group). The width
 * persists into `state.chatWidth` (per-session, like the panel width); the
 * drag uses a local width while active and commits on release (the panel-drag
 * contract). Collapse (`state.chatOpen` false) renders the column at width 0
 * with the same animated transition as the explorer drawer — the view stays
 * MOUNTED (a running thread keeps streaming and the transcript never reloads);
 * the Activity Bar's chat icon and the header's collapse button toggle it.
 *
 * The whole column exists ONLY inside IDE mode — outside it the shell never
 * renders this component (side-chat tabs keep their regular workbench cells).
 */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import { IconChevronRightOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { clampChatWidth, CHAT_WIDTH_DEFAULT, setChatWidth, type SidebarStore, type SidebarState, type SidebarTab } from './state.ts'
import { SideChatView } from './SideChatView.tsx'
import { RenderBoundary } from './RenderBoundary.tsx'
import { t } from './locales.ts'
import { panelHotkeyHint } from './hotkeys.ts'
import type { SessionScope } from './api.ts'
import css from './sidebar.module.css'

/**
 * The synthetic hero tab: an UNBOUND sidechat tab (no threadId in meta) that
 * renders SideChatView's hero. Its id is a stable constant — nothing in the
 * hero path keys effects on it.
 */
const HERO_TAB: SidebarTab = {
  id: 'sidechat:hero',
  type: 'sidechat',
  title: 'Side Chat',
  meta: {},
}

export function SideChatPane(props: {
  ctx: Context
  store: SidebarStore
  state: SidebarState
  scope: SessionScope
  /** The sidechat tab to mirror (the active pane's), or null for the hero. */
  tab: SidebarTab | null
  /** Collapse/expand the column (toggled by the header button and the
   *  Activity Bar's chat icon). */
  onToggleChat: () => void
  /** Mint a NEW sidechat tab (the hero's start button — the tab becomes the
   *  pane's active tab and the column mirrors it). */
  onNewThread: () => void
}) {
  const { ctx, store, state, scope, tab, onToggleChat, onNewThread } = props
  const open = state.chatOpen !== false

  // Local width while dragging; the persisted width otherwise. A collapsed
  // column renders at width 0 (the CSS width transition animates it), so the
  // drag state stays inert while collapsed.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const width = open ? (dragWidth ?? clampChatWidth(state.chatWidth ?? CHAT_WIDTH_DEFAULT)) : 0
  const dragging = dragWidth !== null

  const onResizeStart = useCallback((event: ReactPointerEvent): void => {
    event.preventDefault()
    // jsdom lacks setPointerCapture — tests dispatch plain MouseEvents.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { startX: event.clientX, startWidth: width }
  }, [width])

  const onResizeMove = useCallback((event: ReactPointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) return
    // Handle on the LEFT edge: dragging RIGHT (clientX grows) widens the
    // chat column (and squeezes the editor group to its left).
    setDragWidth(clampChatWidth(drag.startWidth + (event.clientX - drag.startX)))
  }, [])

  const onResizeEnd = useCallback((event: ReactPointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) return
    dragRef.current = null
    setDragWidth(null)
    const finalWidth = clampChatWidth(drag.startWidth + (event.clientX - drag.startX))
    store.reduce(s => setChatWidth(s, finalWidth))
  }, [store])

  const contentTab = tab ?? HERO_TAB
  // With a real mirrored tab the view drives itself; the hero (no tab) routes
  // its start button through openTab (heroAction).
  const heroAction = tab === null ? onNewThread : undefined

  // The pane's mirror is the session's chat surface: while the panel is open
  // (always true inside IDE mode) the view stays live — a collapsed column
  // keeps streaming and a running thread never pauses mid-turn.
  const visible = state.panelOpen

  return (
    <div
      className={clsx(
        css.chatPane,
        !open && css.chatPaneCollapsed,
        dragging && css.chatPaneDragging,
      )}
      style={{ width }}
      data-dsh-ide-chat
    >
      {open && (
        <div
          className={css.chatResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('sideChat')}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        />
      )}
      <div className={css.chatHeader}>
        <span className={css.chatHeaderTitle}>{t('sideChat')}</span>
        <Tooltip label={`${t('sideChatCollapse')} (${panelHotkeyHint('chat')})`} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.chatCollapse}
            aria-label={t('sideChatCollapse')}
            onClick={onToggleChat}
          >
            <IconChevronRightOutline14 size={14} />
          </button>
        </Tooltip>
      </div>
      <div className={css.chatBody}>
        <RenderBoundary className={css.tabBoundaryError}>
          <SideChatView
            ctx={ctx}
            scope={scope}
            tab={contentTab}
            visible={visible}
            heroAction={heroAction}
          />
        </RenderBoundary>
      </div>
    </div>
  )
}