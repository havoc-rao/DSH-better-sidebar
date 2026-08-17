/**
 * The tab strip of one pane: tabs capped at TAB_MAX_WIDTH (ellipsized),
 * overflow scrolls horizontally, a close button per tab, a four-way split
 * button cluster, and the + menu that opens new tabs (explorer / git /
 * terminal). Tabs are draggable; dropping onto another tab inserts before it,
 * dropping on the strip background appends to this pane.
 *
 * Workspace-bound windows (the "pinned" stubs) render at the END of the
 * strip behind a divider, whatever their array position: the caller hands
 * the full tab list and an `isBoundTabId` predicate, this component
 * partitions. Pinned tabs are NOT draggable (they are shared windows — a
 * per-session move would be meaningless) and their close button routes to
 * the shell's unbind path like any other close.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCloseFill14, IconPlusOutline16, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTab } from './state.ts'
import { IconPinOutline16 } from './icons.tsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** One + menu option. */
export interface NewTabOption {
  id: string
  label: string
  disabled?: boolean
  /** Leading icon (Menu row). */
  icon?: ReactNode
}

/** Drag payload for tab moves (HTML5 DnD dataTransfer). */
export const TAB_DRAG_TYPE = 'application/x-dsh-tab'

export interface TabDragPayload {
  tabId: string
  paneId: string
}

export function serializeDrag(payload: TabDragPayload): string {
  return JSON.stringify(payload)
}

export function parseDrag(raw: string): TabDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as TabDragPayload
    if (typeof parsed.tabId === 'string' && typeof parsed.paneId === 'string') return parsed
    return null
  } catch {
    return null
  }
}

/** Global tab-drag flag: PDF iframes become non-interactive synchronously. */
function setTabDragging(active: boolean): void {
  if (active) document.body.setAttribute('data-dsh-tab-dragging', '')
  else document.body.removeAttribute('data-dsh-tab-dragging')
}

export function TabBar(props: {
  paneId: string
  tabs: SidebarTab[]
  active: string | null
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onNewTab: (optionId: string) => void
  newTabOptions: NewTabOption[]
  /** Drop of a tab from any pane: (payload, insertBeforeTabId | null). */
  onDropTab: (payload: TabDragPayload, before: string | null) => void
  /** Icon resolver for tab labels (reads from the tab descriptor registry). */
  getTabIcon?: (tab: SidebarTab) => ReactNode
  /** Badge resolver for tab labels (reads the descriptor's `badge`; the
   *  resolver returns the rendered pill or null). */
  getTabBadge?: (tab: SidebarTab) => ReactNode
  /** Workspace-bound stub detection (pinned rendering; absent → no pins). */
  isBoundTabId?: (tabId: string) => boolean
  /** Right-click on a tab: the shell positions its workspace menu here. */
  onTabContextMenu?: (tab: SidebarTab, event: ReactMouseEvent) => void
}) {
  const {
    paneId, tabs, active, onActivate, onClose, onNewTab, newTabOptions, onDropTab, getTabIcon, getTabBadge,
    isBoundTabId, onTabContextMenu,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  /** The bound stub whose close button is ARMED (first click of the
   *  two-step close confirm); null = nothing armed. */
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null)
  const armedTimerRef = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  /** How long the armed state survives without a confirming click. */
  const ARMED_MS = 2000

  /** Arm the two-step close on a bound stub (first click). */
  const armClose = (tabId: string): void => {
    if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current)
    setArmedCloseId(tabId)
    armedTimerRef.current = window.setTimeout(() => {
      armedTimerRef.current = null
      setArmedCloseId(null)
    }, ARMED_MS)
  }

  /** Disarm (any other interaction: tab click, menu open, unmount). */
  const disarmClose = (): void => {
    if (armedTimerRef.current !== null) {
      window.clearTimeout(armedTimerRef.current)
      armedTimerRef.current = null
    }
    setArmedCloseId(null)
  }

  useEffect(() => {
    return () => {
      if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current)
    }
  }, [])

  // Wheel over the strip scrolls the tab row horizontally (a plain mouse
  // wheel emits deltaY, which overflow-x alone never consumes). Bound as a
  // native NON-passive listener: React registers onWheel passively at the
  // root, where preventDefault() is a no-op. Modifier keys keep their native
  // meaning (shift = horizontal scroll, ctrl/cmd = zoom), and a strip that
  // does not overflow leaves the event alone so the page scrolls normally.
  useEffect(() => {
    const el = listRef.current
    if (el === null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
      if (el.scrollWidth <= el.clientWidth) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1
      el.scrollLeft += (event.deltaX + event.deltaY) * unit
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [])

  useEffect(() => {
    const clear = (): void => { setTabDragging(false); setDragOver(false) }
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [])

  // Partition: the session's own tabs first, the workspace-bound stubs
  // (pinned) behind a divider at the end — independent of array order.
  const boundIds = new Set(isBoundTabId === undefined ? [] : tabs.filter(tab => isBoundTabId(tab.id)).map(tab => tab.id))
  const sessionTabs = tabs.filter(tab => !boundIds.has(tab.id))
  const pinnedTabs = tabs.filter(tab => boundIds.has(tab.id))

  /** One tab element; `bound` renders the pinned variant (pin glyph, not
   *  draggable, context-menu enabled — same close/activate wiring). */
  const renderTabEl = (tab: SidebarTab, bound: boolean): ReactNode => (
    <div
      key={tab.id}
      className={clsx(css.tab, active === tab.id && css.tabActive, bound && css.tabBound)}
      title={tab.title}
      draggable={!bound}
      onDragStart={bound ? undefined : (event) => {
        setTabDragging(true)
        event.dataTransfer.setData(TAB_DRAG_TYPE, serializeDrag({ tabId: tab.id, paneId }))
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => { setTabDragging(false); setDragOver(false) }}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setTabDragging(false)
        const raw = event.dataTransfer.getData(TAB_DRAG_TYPE)
        const payload = parseDrag(raw)
        if (payload !== null) onDropTab(payload, tab.id)
      }}
      onClick={() => {
        // Any tab activation disarms a pending close confirm.
        disarmClose()
        onActivate(tab.id)
      }}
      onAuxClick={(event) => {
        // Middle-click closes the tab (and suppresses autoscroll). Bound
        // stubs share the two-step confirm: the first middle-click arms.
        if (event.button === 1) {
          event.preventDefault()
          if (!bound) onClose(tab.id)
          else if (armedCloseId === tab.id) {
            disarmClose()
            onClose(tab.id)
          } else armClose(tab.id)
        }
      }}
      onContextMenu={(event) => {
        if (onTabContextMenu === undefined) return
        event.preventDefault()
        event.stopPropagation()
        disarmClose()
        onTabContextMenu(tab, event)
      }}
    >
      {getTabIcon?.(tab) ?? null}
      {bound && <IconPinOutline16 size={12} className={css.tabPin} />}
      {getTabBadge?.(tab) ?? null}
      <span className={css.tabTitle}>{tab.title}</span>
      <button
        type="button"
        className={clsx(css.tabClose, bound && armedCloseId === tab.id && css.tabCloseArmed)}
        aria-label={bound && armedCloseId === tab.id ? t('closeBoundConfirm') : t('close')}
        title={bound && armedCloseId === tab.id ? t('closeBoundConfirm') : undefined}
        onClick={(event) => {
          event.stopPropagation()
          // Bound stubs close EVERYWHERE (shared windows): the first click
          // arms a red confirm state, the second click really closes — an
          // accidental ✕ must never wipe the window from every session.
          if (!bound) {
            onClose(tab.id)
            return
          }
          if (armedCloseId === tab.id) {
            disarmClose()
            onClose(tab.id)
          } else {
            armClose(tab.id)
          }
        }}
      >
        <IconCloseFill14 />
      </button>
    </div>
  )

  return (
    <div
      className={clsx(css.tabBar, dragOver && css.tabBarDrop)}
      onDragOver={(event) => {
        // The strip owns drops on itself (merge into this pane); stopping
        // propagation keeps the pane root from also running its edge-zone
        // handler on the same drop.
        event.preventDefault()
        event.stopPropagation()
        setDragOver(true)
      }}
      onDragLeave={() => { setDragOver(false) }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setDragOver(false)
        setTabDragging(false)
        const raw = event.dataTransfer.getData(TAB_DRAG_TYPE)
        const payload = parseDrag(raw)
        if (payload !== null) onDropTab(payload, null)
      }}
    >
      <div ref={listRef} className={css.tabList}>
        {sessionTabs.map(tab => renderTabEl(tab, false))}
        {pinnedTabs.length > 0 && <div className={css.tabBarDivider} role="separator" />}
        {pinnedTabs.map(tab => renderTabEl(tab, true))}
        {/*
          The + sits immediately after the rightmost tab (sticky at the
          right edge of the scrollport when the tabs overflow, so it stays
          reachable no matter how many tabs are open).
        */}
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={newTabOptions.map(option => ({
            id: option.id,
            label: option.label,
            ...(option.disabled === true ? { disabled: true } : {}),
            ...(option.icon !== undefined ? { icon: option.icon } : {}),
          }))}
          onSelect={(id) => {
            onNewTab(id)
            setMenuOpen(false)
          }}
          portal
          align="end"
          anchor={(
            <button
              type="button"
              className={css.tabBarPlus}
              aria-label={t('newTab')}
              title={t('newTab')}
              onClick={() => { setMenuOpen(v => !v) }}
            >
              <IconPlusOutline16 />
            </button>
          )}
        />
      </div>
    </div>
  )
}
