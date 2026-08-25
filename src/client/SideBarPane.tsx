/**
 * The VSCode-style independent Side Bar: a vertical column holding the file
 * tree (the {@link TreePanel} in its full-window form) that lives OUTSIDE the
 * editor tab's dock in `sidebarLayout: 'vscode'`. The editor group sits to
 * its LEFT and the Activity Bar to its RIGHT (the mirror arrangement that
 * keeps the editor by the chat), so the drag-resize handle rides the side
 * bar's LEFT edge — dragging it left widens the side bar (and squeezes the
 * editor), mirroring the docked tree's own left-edge handle.
 *
 * The width persists into `state.sideBarWidth` (per-session, like the panel
 * width); the drag uses a local width while active and commits on release, the
 * same release-contract the panel drags use. The view is currently always the
 * explorer (the file tree + search); `state.sideBarView` is reserved for
 * future view switching.
 *
 * The EXPLORER drawer animation: `collapsed` (sideBarOpen false) renders the
 * column at width 0 with overflow clipped, and the width transition animates
 * the collapse/expand (the tree stays MOUNTED, so re-expanding never
 * reloads it). The resize handle is dropped while collapsed and the drag
 * disables the transition so a drag tracks the pointer 1:1.
 *
 * `flipped` mirrors the column to the panel's LEFT side (`sideBarSide:
 * 'left'`): the border and resize handle move to the RIGHT edge and the
 * drag direction reverses, so the arrangement becomes file tree | editor |
 * activity bar.
 */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import type { Context } from '../context-types.ts'
import { setSideBarWidth, type SidebarStore, type SidebarState } from './state.ts'
import { SIDEBAR_BAR_WIDTH_DEFAULT, clampSidebarBarWidth } from '../prefs-shared.ts'
import { TreePanel } from './TreePanel.tsx'
import { t } from './locales.ts'
import type { SessionScope } from './api.ts'
import css from './sidebar.module.css'

export function SideBarPane(props: {
  ctx: Context
  store: SidebarStore
  state: SidebarState
  scope: SessionScope
  expanded: string[]
  onToggleDir: (path: string) => void
  onOpenFile: (path: string) => void
  onOpenFileNewTab?: (path: string) => void
  onOpenFileSide?: (path: string) => void
  onReferenceFile: (path: string) => void
  visible?: boolean
  /** Whether the explorer drawer is collapsed (width 0, animated). */
  collapsed?: boolean
  /** Mirror the column to the panel's LEFT side (`sideBarSide: 'left'`): the
   *  boundary against the editor moves to the RIGHT edge, and the resize
   *  handle rides that edge (dragging RIGHT widens). */
  flipped?: boolean
}) {
  const { ctx, store, state, scope, expanded, onToggleDir, onOpenFile, onOpenFileNewTab, onOpenFileSide, onReferenceFile, visible, collapsed, flipped } = props

  // Local width while dragging; the persisted width otherwise. The drag
  // commits the final value into state on release (the panel-drag contract).
  // A collapsed drawer renders at width 0 (the CSS width transition animates
  // it), so the drag state stays inert while collapsed.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const openWidth = dragWidth ?? clampSidebarBarWidth(state.sideBarWidth ?? SIDEBAR_BAR_WIDTH_DEFAULT)
  const width = collapsed === true ? 0 : openWidth
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
    // Handle on the LEFT edge: dragging left (clientX decreases) widens.
    // FLIPPED (handle on the RIGHT edge): dragging right widens.
    const delta = flipped === true ? event.clientX - drag.startX : drag.startX - event.clientX
    setDragWidth(clampSidebarBarWidth(drag.startWidth + delta))
  }, [flipped])

  const onResizeEnd = useCallback((event: ReactPointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) return
    dragRef.current = null
    setDragWidth(null)
    const delta = flipped === true ? event.clientX - drag.startX : drag.startX - event.clientX
    const finalWidth = clampSidebarBarWidth(drag.startWidth + delta)
    store.reduce(s => setSideBarWidth(s, finalWidth))
  }, [store, flipped])

  return (
    <div className={clsx(css.sideBarPane, flipped === true && css.sideBarPaneFlipped, collapsed === true && css.sideBarPaneCollapsed, dragging && css.sideBarPaneDragging)} style={{ width }}>
      {collapsed !== true && (
        <div
          className={css.sideBarResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('sideBarExplorer')}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        />
      )}
      <div className={css.sideBarHeader}>{t('sideBarExplorer')}</div>
      <div className={css.sideBarBody}>
        <TreePanel
          full
          sessionId={scope.sessionId}
          cwd={scope.cwd}
          ctx={ctx}
          expanded={expanded}
          onToggle={onToggleDir}
          onOpenFile={onOpenFile}
          onOpenFileNewTab={onOpenFileNewTab}
          onOpenFileSide={onOpenFileSide}
          onReferenceFile={onReferenceFile}
          visible={visible}
        />
      </div>
    </div>
  )
}
