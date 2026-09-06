/**
 * The draggable divider BETWEEN the file-tree dual modules (v0.19.1+): a
 * thin strip that re-proportions the injected upper section against the
 * local tree. Follows the repo's pointer-resize convention (EditorHost's
 * panel edge, the split-pane `Divider`s): pointer capture on the handle
 * itself (`setPointerCapture?.` — jsdom lacks it), live moves batched per
 * frame (`createFrameBatcher`) so the tree's re-layout under the drag never
 * runs at event cadence, flush + commit on release. No window listeners:
 * the captured pointer keeps tracking outside the strip.
 *
 * The ratio is ABSOLUTE in the container — upper = clientY − container top
 * at pointer-down — so the divider always tracks the cursor exactly and
 * clamping needs only the container's measured height (see
 * file-tree-splitter.ts). An unmoved click is deliberately a NO-OP (drag
 * only, per the requirement — no click-nudge stepping); a double-click
 * resets the default 4:1 split. Keyboard surface mirrors EditorHost's
 * separator convention: role/aria (orientation + value), no tabindex.
 */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import { createFrameBatcher } from './frame-batcher.ts'
import { clampFileTreeSplitRatio, FILE_TREE_SPLIT_DEFAULT_RATIO } from './file-tree-splitter.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export function FileTreeSplitter(props: {
  /** The upper module's share (0–1), owned by the host (`ExplorerDual`). */
  ratio: number
  /** Live update while dragging. */
  onRatio: (ratio: number) => void
  /** Drag release / double-click reset: the host persists the ratio. */
  onCommit: (ratio: number) => void
}) {
  const { ratio, onRatio, onCommit } = props
  const [dragging, setDragging] = useState(false)
  /** The container's geometry at pointer-down (the drag is absolute). */
  const dragRef = useRef<{ top: number; height: number } | null>(null)
  /** Whether the pointer actually moved: an unmoved click commits nothing. */
  const movedRef = useRef(false)
  const pendingRatioRef = useRef(ratio)
  const batcher = useRef(createFrameBatcher()).current
  useEffect(() => () => batcher.dispose(), [batcher])

  const onPointerDown = (event: ReactPointerEvent): void => {
    event.preventDefault()
    // Pointer capture keeps move/up on this handle even when the cursor
    // leaves the strip (jsdom lacks the API — skipped, tests dispatch on
    // the handle directly).
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const container = event.currentTarget.parentElement
    const box = container?.getBoundingClientRect()
    dragRef.current = {
      top: box?.top ?? event.clientY,
      height: box?.height ?? 1,
    }
    movedRef.current = false
    setDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) return
    movedRef.current = true
    pendingRatioRef.current = clampFileTreeSplitRatio(
      (event.clientY - drag.top) / Math.max(1, drag.height),
      drag.height,
    )
    batcher.schedule(() => onRatio(pendingRatioRef.current))
  }

  const onPointerUp = (event: ReactPointerEvent): void => {
    const drag = dragRef.current
    if (drag === null) return
    // Flush the final queued move so the release position is applied (a
    // stray frame after the null below would re-apply the drag ratio once
    // the drag already ended — same flush discipline as EditorHost).
    batcher.flushNow()
    dragRef.current = null
    setDragging(false)
    if (!movedRef.current) return
    onCommit(clampFileTreeSplitRatio(
      (event.clientY - drag.top) / Math.max(1, drag.height),
      drag.height,
    ))
  }

  return (
    <div
      className={clsx(css.explorerSplitter, dragging && css.explorerSplitterActive)}
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('fileTreeSplitter')}
      title={t('fileTreeSplitter')}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => { onCommit(FILE_TREE_SPLIT_DEFAULT_RATIO) }}
    />
  )
}