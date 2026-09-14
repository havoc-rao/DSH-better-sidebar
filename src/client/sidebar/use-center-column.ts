/**
 * Center-column tracking (extracted from Sidebar.tsx, behavior identical):
 * the bottom workbench spans ONLY the app shell's center column ("squeezes
 * the agent output area") — it starts at the app sidebar's right edge and
 * ends at the details column's left edge. Measured directly from the
 * AppFrame's center column DOM (center-column.ts anchors on the conversation
 * slot host — `main.conversation` on DSH 0.1.5-alpha.2+, `conversation` on
 * alpha.1 — and walks up the transparent `display: contents` slot hosts to
 * the column; layout.css's center column) so the workbench tracks the
 * column's
 * real horizontal edges, including the animated track moves while DSH's
 * native right Sidebar opens/closes; a frame that never appears keeps the
 * initial zero-size fallback (the panel renders at 0 width until measured).
 * The rect lives in a REF (not state): the open/close transition resizes
 * the center column EVERY frame for its duration, and reacting per frame
 * with setState re-renders the whole Sidebar (every mounted tab) at
 * animation cadence — the visible toggle jank (#315). measureCenter
 * writes the bottom panel's edges directly (same DOM-write pattern as
 * applyDrag), so the panel still tracks the column per frame with zero
 * React work; `centerMeasured` flips ONCE to gate the hidden→visible
 * first-paint fallback.
 *
 * MAXIMIZED MODE (the tab strip's fullscreen toggle): the workbench owns
 * the ENTIRE conversation column — top edge to bottom edge — while it is
 * on. The session-header band, the transcript, and the composer (the input
 * bar; InputBar.tsx's card) are all the workbench's: nothing of the chat
 * box remains visible below or above the panel. The region is the center
 * column's own rect (a REAL box) — never a DSH slot host: the slot hosts
 * (`[data-slot="conversation.view"]`…) are `display: contents` wrappers
 * whose getBoundingClientRect collapses to {0,0} on this host engine
 * (empty getClientRects), and anchoring a maximized fill on one collapsed
 * the panel to a 1px sliver at the viewport top ("covered by the chatbox").
 * `chatRectRef` carries the column's top/bottom (read at measure time;
 * kept fresh even while docked so the shell's render-time reads are never
 * stale); while `fullscreen` is on, measureCenter also writes the panel's
 * top/bottom/height inline (same per-frame DOM-write pattern), so the panel
 * tracks the column without re-rendering the shell.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveCenterColumn } from '../center-column.ts'

export function useCenterColumn(
  /** The bottom panel element: measureCenter writes its edges directly. */
  bottomRef: { readonly current: HTMLDivElement | null },
  /** Re-runs the whole locate/measure chain on change (opening the bottom
   *  panel re-runs the chain: a panel opened before the center column was
   *  ever found must not stay invisible forever). */
  bottomOpen: boolean | undefined,
  /** Maximized-over-the-chat-box mode (the tab strip's fullscreen toggle):
   *  while true, measureCenter also writes the panel's chat-box top/bottom,
   *  and its per-frame updates track column geometry changes. */
  fullscreen: boolean,
) {
  const centerRectRef = useRef({ left: 0, right: 0 })
  /** The maximized region's edges — the center column's OWN rect, top to
   *  bottom (the whole chat box: session header, transcript, input bar; a
   *  real box, never a `display: contents` slot host — see the module
   *  comment); zero fallback until first measurement. */
  const chatRectRef = useRef({ top: 0, bottom: 0 })
  const [centerMeasured, setCenterMeasured] = useState(false)
  // Refs keep the measure step stable across renders and let it skip work
  // mid-drag: during a width/corner drag the layout push resizes the center
  // column every frame, and reacting (setCenterRect → re-render) would
  // re-introduce the drag lag this shell deliberately avoids. applyDrag
  // writes the bottom panel's edges directly, so measurement pauses then.
  const centerColRef = useRef<HTMLElement | null>(null)
  const draggingRef = useRef(false)
  const measureCenter = useCallback((): void => {
    if (draggingRef.current) return
    const col = centerColRef.current
    if (col === null) return
    if (!col.isConnected) {
      // The observed column was detached (HMR re-render swapped the node
      // in place): its rect is stale garbage. Drop the ref — the locate
      // chain re-runs on the next mutation/interval tick and picks up the
      // new column node (issue #248).
      centerColRef.current = null
      return
    }
    const rect = col.getBoundingClientRect()
    // Ref + direct DOM write (see the centerRectRef comment): the bottom
    // panel keeps tracking the center column per frame during the right
    // panel's open/close animation without re-rendering the shell. The
    // one-shot measured flip renders the panel visible once (a stale
    // {0,0} fallback would flash full-width). The maximize region is the
    // same column rect — top to bottom — and is kept fresh even while
    // docked so the shell's render-time reads are never stale.
    centerRectRef.current = { left: rect.left, right: rect.right }
    chatRectRef.current = { top: rect.top, bottom: rect.bottom }
    const bottom = bottomRef.current
    if (bottom !== null) {
      bottom.style.setProperty('left', `${rect.left}px`)
      bottom.style.setProperty('right', `${window.innerWidth - rect.right}px`)
      if (fullscreen) {
        // Maximized: the panel fills the ENTIRE conversation column
        // (top..bottom) — header band, transcript, and input bar are all
        // the workbench's; nothing of the chat box stays visible. Written
        // per frame so column geometry changes track without re-rendering
        // the shell; the shell's style prop reads the same refs, so a
        // re-render re-applies the same values. The docked restore is
        // React's job (its own style diff sees the maximize render's
        // values and rewrites them on exit).
        const chatRect = chatRectRef.current
        bottom.style.setProperty('height', 'auto')
        bottom.style.setProperty('top', `${chatRect.top}px`)
        bottom.style.setProperty('bottom', `${Math.max(0, window.innerHeight - chatRect.bottom)}px`)
      }
    }
    setCenterMeasured(prev => (prev ? prev : true))
  }, [bottomRef, fullscreen])
  useEffect(() => {
    let disposed = false
    let observer: ResizeObserver | undefined
    // Locate the AppFrame's center column. DSH 0.1.x wraps slot hosts in
    // [data-slot] containers: the conversation slot host (key
    // `main.conversation` on 0.1.5-alpha.2+, `conversation` on alpha.1)
    // sits inside the center column behind transparent `display: contents`
    // slot hosts, so the resolver walks up to the first ancestor that
    // renders a box — no hashed-class or positional dependency
    // (layout.css uses the same anchor). The shell swaps the boot page for
    // the AppFrame only AFTER boot settles, so the first query may miss it.
    // Never give up: watch #root's subtree (the swap and HMR re-renders
    // mutate it) and re-run this locator — querying once and bailing would
    // strand the panel at the zero-size fallback forever (observed: a 1px
    // sliver at the viewport's left edge).
    const locate = (): void => {
      if (disposed) return
      // Hot path (#403): streaming output mutates #root at token cadence.
      // Reuse a still-connected center column and only query after boot/HMR
      // detached the cached node.
      const col = resolveCenterColumn(centerColRef.current)
      if (col === undefined || !col.isConnected) {
        if (centerColRef.current !== null) {
          centerColRef.current.removeAttribute('data-dsh-center-col')
          centerColRef.current = null
          observer?.disconnect()
          observer = undefined
        }
        return
      }
      if (centerColRef.current !== col) {
        // A NEW column node (boot swap, HMR re-render, or a previous locate
        // that found nothing): attach the ResizeObserver to THIS node and
        // measure it once. Same-node size changes are the ResizeObserver's
        // job — no forced measurement here, because a forced
        // getBoundingClientRect per mutation would reflow the shell at
        // mutation cadence. The tag retargets with the ref: layout.css's
        // bottom-push rule anchors on [data-dsh-center-col], so exactly the
        // measured node carries it (a stale tag on a swapped-out node would
        // leave the push rule anchorless or doubled).
        centerColRef.current?.removeAttribute('data-dsh-center-col')
        centerColRef.current = col
        col.setAttribute('data-dsh-center-col', '')
        observer?.disconnect()
        observer = new ResizeObserver(measureCenter)
        observer.observe(col)
        measureCenter()
      }
    }
    locate()
    // rAF-debounce the mutation watchers: #root's subtree changes at chat
    // cadence (streaming turns), and locate() itself must stay cheap.
    let locateFrame: number | null = null
    const scheduleLocate = (): void => {
      if (locateFrame !== null) return
      // Mid-drag every frame writes --dsh-sidebar-* on <html>'s style
      // attribute, which is the mutation this watcher observes — relocating
      // per drag frame is pointless (the center column node cannot change
      // while the pointer is captured) and adds locator work to every
      // frame's budget (#315). The 1.5s retry below still covers any node
      // swap that somehow lands mid-drag.
      if (draggingRef.current) return
      locateFrame = requestAnimationFrame(() => {
        locateFrame = null
        locate()
      })
    }
    const watcher = new MutationObserver(scheduleLocate)
    const root = document.getElementById('root')
    if (root !== null) watcher.observe(root, { childList: true, subtree: true })
    // The layout push writes --dsh-sidebar-* on <html>. A HMR re-activation
    // clears those variables on teardown and re-writes them on setup — and
    // that is also the moment the shell may have re-created the center
    // column under a REUSED #root child (React swaps nodes in place, so
    // #root's childList never changes and the watcher above never fires).
    // Watching <html>'s style attribute catches that re-sync: the push
    // rewrite re-locates and re-measures, so the bottom panel recovers
    // instead of staying hidden on a stale {0,0} center rect.
    const htmlStyleWatcher = new MutationObserver(scheduleLocate)
    htmlStyleWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    // Last-resort safety net (issue #248): no watcher is guaranteed to fire
    // for every HMR teardown/setup interleaving (e.g. the style attribute
    // may end up byte-identical, and the col may be swapped before the
    // subtree watcher attaches). A slow unconditional re-locate makes the
    // panel converge on the real column within a couple of seconds no
    // matter what sequence the shell used. locate() is query-free while the
    // cached column stays connected; only a detached/missing cache falls
    // back to the document selector. The re-measure on the same tick keeps
    // the maximize region fresh against column-geometry drift.
    const retry = window.setInterval(() => {
      locate()
      measureCenter()
    }, 1500)
    return () => {
      disposed = true
      if (locateFrame !== null) cancelAnimationFrame(locateFrame)
      window.clearInterval(retry)
      observer?.disconnect()
      watcher.disconnect()
      htmlStyleWatcher.disconnect()
      centerColRef.current?.removeAttribute('data-dsh-center-col')
      centerColRef.current = null
    }
    // Opening the bottom panel re-runs the whole locate/measure chain: a
    // panel opened before the center column was ever found must not stay
    // invisible forever (the HMR recovery path depends on the observers
    // above, this is the belt-and-braces retry for the open moment itself).
    // The fullscreen switch re-runs it too: the measure step must write the
    // maximize geometry immediately (and clear it on exit) instead of
    // waiting for the next resize event.
  }, [measureCenter, bottomOpen])

  // The maximize toggle needs one immediate measure on its transition: the
  // locate effect's observers only fire on size changes, and a toggle is
  // not one. measureCenter is stable except for the fullscreen flag itself
  // (see its deps), so this fires exactly on enter/exit.
  useEffect(() => {
    measureCenter()
  }, [measureCenter])

  return { centerColRef, centerRectRef, chatRectRef, centerMeasured, measureCenter, draggingRef }
}