/**
 * The tab content surface (pane tab wrappers, float window content): clicking
 * ANY spot of a tab — including spots with no interactive feedback (empty git
 * panel, file-tree background, blank preview margins, terminal padding) —
 * must count as ACTIVATING that tab. The W-close target resolution
 * (`workingTabIdOf`) follows the focus-pinned tab, and the click is the only
 * activation signal for a non-interactive spot: without it the pin would stay
 * on whatever tab was focused before, and ⌘W would close the WRONG window.
 *
 * Mechanism: the wrapper is focusable without a tab stop (tabIndex -1) and
 * its pointerdown handler focuses it UNLESS the click landed on an
 * interactive element (button / input / textarea / select / link / iframe /
 * contenteditable / a tabindex'd node) — those keep their own native focus,
 * which lives inside the same wrapper anyway, so the pin is correct either
 * way. `focus()` alone does not prevent default, so the click still reaches
 * whatever handler the blank area has (tree row selection, git row actions).
 */
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'

/** The minimal pointerdown slice the surface handler reads (structural, so
 *  unit tests drive it without a real DOM event). */
export interface TabSurfacePointerDown {
  button: number
  target: unknown
  currentTarget: HTMLElement
}

/** True when an ancestor of `target` (up to, excluding, `stop`) is
 *  interactive — the click should keep the element's own native focus. */
export function hasInteractiveAncestor(target: Element, stop: Element): boolean {
  let node: Element | null = target
  while (node !== null && node !== stop) {
    const tag = node.tagName
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'A' || tag === 'IFRAME') {
      return true
    }
    if (node.hasAttribute('contenteditable')) return true
    const tabIndex = node.getAttribute('tabindex')
    if (tabIndex !== null && tabIndex !== '-1') return true
    node = node.parentElement
  }
  return false
}

/** The pointerdown handler for a tab content wrapper: bring the activation
 *  (focus) to the tab when the click landed on a non-interactive spot. */
export function focusTabSurface(event: TabSurfacePointerDown): void {
  if (event.button !== 0) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (hasInteractiveAncestor(target, event.currentTarget)) return
  event.currentTarget.focus()
}

/**
 * Focus the tab's STRIP element when mounted (focusable via tabIndex; content
 * wrappers carry data-dsh-tab-id WITHOUT tabindex and are skipped). Moves the
 * REAL DOM focus — and with it the focusInSidebar gates and the focusin-based
 * working-tab pin — to that tab. Used by the SHOW-VIEW keys to activate a
 * window created from the conversation area, and by closeTab to land on the
 * tab that takes over after a close. No-op when the strip is not mounted.
 */
export function focusTabStripElement(tabId: string): void {
  try {
    const nodes = document.querySelectorAll<HTMLElement>('[data-dsh-tab-id]')
    for (const node of nodes) {
      if (node.getAttribute('data-dsh-tab-id') === tabId && node.hasAttribute('tabindex')) {
        node.focus()
        return
      }
    }
  } catch {
    // Focus chrome unavailable (degraded DOM): nothing to do.
  }
}

/** The props every tab content wrapper spreads: the tab's id for the focus
 *  tracker, programmatic focusability, and the surface pointerdown handler. */
export function tabSurfaceProps(tabId: string): {
  'data-dsh-tab-id': string
  tabIndex: number
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  children?: ReactNode
} {
  return {
    'data-dsh-tab-id': tabId,
    tabIndex: -1,
    onPointerDown: event => focusTabSurface(event),
  }
}