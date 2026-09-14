/**
 * Live probe of DSH's native right Sidebar expanded state.
 *
 * The kernel owns the right column; the plugin only OBSERVES it — for the
 * snapshot's flat `panelOpen` flag (service-side probe) and for the
 * sidebar-toggle button's label (this hook). The kernel's controller has no
 * public subscription, but its expanded state IS the presence of the
 * `[data-sidebar-right-open]` marker on the panel root, so a MutationObserver
 * over that attribute (plus subtree childList, in case the panel root itself
 * mounts late — popup / session windows) tracks every change.
 */
import { useEffect, useState } from 'react'
import type { Context } from '../../context-types.ts'

/** The kernel's expanded-state marker on the native right Sidebar's root. */
const EXPANDED_MARKER = '[data-sidebar-right-open]'

/** The kernel column's public face, as this module reaches it. */
interface NativeColumnFace {
  isExpanded?: () => boolean
  toggleExpanded?: () => void
}

/**
 * Read the expanded state once. The kernel controller is authoritative when
 * it exists; its DOM marker (`[data-sidebar-right-open]`) is the fallback for
 * a controller that lacks `isExpanded`. `undefined` = no kernel right Sidebar
 * in this window at all (popup / session windows on runtimes that have not
 * mounted ui-sidebar-right) — the caller's signal to use the plugin's own
 * file surface instead.
 */
export function readNativeSidebarOpen(ctx: Context): boolean | undefined {
  let column: NativeColumnFace | undefined
  try {
    column = ctx.get('sidebarRight') as NativeColumnFace | undefined
  } catch {
    return undefined
  }
  if (column === undefined || column === null) return undefined
  if (column.isExpanded !== undefined) {
    try {
      return column.isExpanded() === true
    } catch {
      // A half-initialized controller: treat as unknown for this read.
      return undefined
    }
  }
  try {
    return document.querySelector(EXPANDED_MARKER) !== null
  } catch {
    return undefined
  }
}

/**
 * Reactively observe the native right Sidebar's expanded state. Re-reads on
 * every change of the kernel's expanded marker and whenever the caller's
 * context re-renders; a session switch worth of DOM churn never matters —
 * the observer only triggers on `data-sidebar-right-open` appearance /
 * disappearance (childList is added so a LATE-mounted panel root — the
 * popup-window case — is picked up when it appears).
 */
export function useNativeSidebarOpen(ctx: Context): boolean | undefined {
  const [open, setOpen] = useState<boolean | undefined>(() => readNativeSidebarOpen(ctx))
  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      if (disposed) return
      setOpen(readNativeSidebarOpen(ctx))
    }
    refresh()
    const observer = new MutationObserver(refresh)
    observer.observe(document.body, {
      subtree: true,
      // The panel root carries the marker; it may not exist yet at plugin
      // mount (the kernel's column mounts later), so additions count too.
      childList: true,
      attributes: true,
      attributeFilter: ['data-sidebar-right-open'],
    })
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [ctx])
  return open
}