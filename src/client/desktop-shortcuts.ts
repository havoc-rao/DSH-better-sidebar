/**
 * Desktop-shell shortcut claims (the `window.dshDesktopShell` bridge).
 *
 * The deepseek-harness Electron shell intercepts Cmd+W before the renderer
 * ever sees the key (apps/electron/src/window.ts's `before-input-event`) and
 * routes it through the main-process `desktopShortcuts` router; an unclaimed
 * press runs the window's close-confirmation dialog. A page-side consumer
 * claims the press through the preload bridge: `window.dshDesktopShell` is
 * exposed by the shell's preload (contextBridge, sandboxed renderer), and
 * `onShortcut('cmd-w', handler)` registers THIS page's claim decision — the
 * shell asks the page on every press and treats `true` as claimed.
 *
 * SEMANTICS (v0.20.x, "A"): Cmd+W closes tabs and panel surfaces, and NEVER
 * closes the app — the shell's close confirmation is only ever reached when
 * no page-side consumer is mounted at all. The plugin's decision is:
 *
 *   1. kernel right Sidebar expanded → close its active tab. The press is
 *      claimed unconditionally after the close call: the kernel controller's
 *      `active()` reads a React-render-bound surface snapshot, so re-reading
 *      it right after a close would still see the OLD layout (the store
 *      commit lands ahead of the render) and misread a successful close as a
 *      refusal — which once folded the whole column by mistake ([e+g] bug);
 *   2. an expanded column with NO active tab at all (an empty pane, a
 *      throwing controller) → collapse the column (the kernel face's
 *      `toggleExpanded`) as the visible "nothing more to close". A close the
 *      kernel refuses (the sole docked guide, rejected by its `canCloseTab`)
 *      needs no feedback: the press is simply claimed as a no-op;
 *   3. a collapsed column, or windows without a native column at all
 *      (popup / detached session windows) → the bottom workbench: close its
 *      active tab; an open workbench with no tabs → collapse it (the
 *      `collapseBottom` callback the mount point injects);
 *   4. nothing anywhere → still claim the press (a no-op): Cmd+W must never
 *      fall through to the shell's close confirmation while the plugin is
 *      mounted. Closing the app goes through Cmd+Q / the traffic lights /
 *      the shell's own menu.
 *
 * Contract with the shell (implemented by deepseek-harness; the plugin is
 * the first consumer): the bridge is present only inside that Electron
 * shell, so plain-browser and official-shell deployments resolve no bridge
 * and this module is a no-op.
 */
import type { BetterSidebarService } from './service.ts'
import { allLeaves } from './state.ts'

/** The window global the deepseek-harness Electron preload exposes. */
const DESKTOP_SHELL_BRIDGE_KEY = 'dshDesktopShell' as const

/** The shell shortcut the plugin claims: Cmd+W closes the active tab. */
export const CMD_W_SHORTCUT = 'cmd-w' as const

/** The preload bridge's page-side face (the shell's contract). */
export interface DesktopShellBridge {
  /**
   * Register this page's claim handler for one shell shortcut.
   * @param name - the shortcut name (`'cmd-w'`).
   * @param handler - called synchronously on each press; `true` claims the
   *   press, `false`/`undefined` passes it to the shell's default.
   * @returns a disposer that removes exactly this registration.
   */
  onShortcut(name: string, handler: () => boolean | undefined): () => void
}

/** The kernel right-Sidebar face the claim reads (structural mirror). */
interface SidebarRightCloseFace {
  isExpanded?: () => boolean
  active?: () => { id: string } | undefined
  close?: (tabId: string) => void
  toggleExpanded?: () => void
}

/** The smallest client-context face the claim reads (a structural slice of
 *  the cordis Context, kept loose so unit tests need no full context). */
export interface DesktopShortcutContext {
  get(name: string): unknown
}

/**
 * Read the shell's shortcut bridge from the page, if the shell provides it.
 * @returns the bridge, or `undefined` in plain browsers / shells without it.
 */
export function readDesktopShellBridge(): DesktopShellBridge | undefined {
  if (typeof window === 'undefined') return undefined
  const candidate = (window as unknown as Record<string, unknown>)[DESKTOP_SHELL_BRIDGE_KEY]
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const bridge = candidate as { onShortcut?: unknown }
  return typeof bridge.onShortcut === 'function' ? bridge as DesktopShellBridge : undefined
}

/**
 * The Cmd+W claim decision: close the active tab, then collapse what is left
 * open, and NEVER fall through to the shell's close confirmation (semantics
 * "A" — see the module header). The return value is `true` in every reachable
 * state; the function only communicates through its side effects.
 * @param ctx - the client context face (kernel `sidebarRight` read structurally).
 * @param service - the plugin's own service (bottom-workbench close path).
 * @param collapseBottom - optional: collapse the plugin's bottom workbench;
 *   called only while the workbench is open and has no tab to close. Returns
 *   whether it actually collapsed something (informational).
 * @returns always `true` — the press is claimed, the shell never asks.
 */
export function claimCloseActiveTab(
  ctx: DesktopShortcutContext,
  service: BetterSidebarService,
  collapseBottom?: () => boolean,
): boolean {
  if (closeNativeActiveTab(ctx)) return true
  closeBottomActiveTab(service, collapseBottom)
  return true
}

/**
 * The kernel right Sidebar half of the claim: close the active tab while the
 * column is expanded (claiming unconditionally — never verified by re-reading,
 * see the module header); collapse the column only when there was no active
 * tab at all.
 * @param ctx - the client context face.
 * @returns `true` when the press is fully handled by this half (a tab closed
 *   or the column folded); `false` when the column is collapsed or absent and
 *   the workbench half should run.
 */
function closeNativeActiveTab(ctx: DesktopShortcutContext): boolean {
  const sidebar = readSidebarRight(ctx)
  if (sidebar === undefined) return false
  let expanded: boolean | undefined
  try {
    expanded = sidebar.isExpanded?.()
  } catch {
    expanded = undefined
  }
  // A collapsed column is not the user's active surface: fall through to the
  // workbench. Unknown (a late-mounting window) still tries the native half.
  if (expanded === false) return false
  let tab: { id: string } | undefined
  try {
    tab = sidebar.active?.()
  } catch {
    tab = undefined
  }
  if (tab !== undefined) {
    // Claim unconditionally after the close call: the kernel's `active()`
    // reads a React-render-bound surface snapshot, so re-reading it right
    // after the store commit still sees the OLD layout — verifying a close
    // by re-reading would misjudge a successful close as a refusal and fold
    // the whole column ([e+g] bug). A refused close (the sole docked guide)
    // simply lands as a claimed no-op.
    try {
      sidebar.close?.(tab.id)
    } catch {
      // A throwing close still claims the press — see the module header.
    }
    return true
  }
  // No active tab at all (an empty pane, a throwing controller): fold the
  // column as the visible "nothing more to close". A missing or throwing
  // toggle still claims the press.
  try {
    sidebar.toggleExpanded?.()
  } catch {
    // Keep claiming below — the shell must never see an unclaimed press.
  }
  return true
}

/**
 * The bottom workbench half of the claim (popup / detached-session windows
 * without a native column, and collapsed columns): close the active tab;
 * collapse an open workbench that has nothing to close; otherwise nothing.
 * @param service - the plugin's own service.
 * @param collapseBottom - optional collapse callback (mount-point injected).
 */
function closeBottomActiveTab(service: BetterSidebarService, collapseBottom?: () => boolean): void {
  const state = service.getSnapshot().state
  if (state === undefined || state.bottomOpen !== true) return
  const leaves = allLeaves(state.bottomSplits)
  const leaf = leaves.find(candidate => candidate.id === state.activePane) ?? leaves[0]
  if (leaf === undefined) return
  const tab = leaf.tabs.find(candidate => candidate.id === leaf.active) ?? leaf.tabs[0]
  if (tab !== undefined) {
    // No scope: the current session (the state read above is its snapshot).
    service.closeTab(tab.id)
    return
  }
  // An open workbench with no tab to close: fold it. The callback is the
  // mount point's privilege (it owns the store); a throwing callback keeps
  // the press claimed regardless.
  if (collapseBottom !== undefined) {
    try {
      collapseBottom()
    } catch {
      // See closeNativeActiveTab: the press stays claimed either way.
    }
  }
}

/** Read the kernel `sidebarRight` controller, structurally, never throwing. */
function readSidebarRight(ctx: DesktopShortcutContext): SidebarRightCloseFace | undefined {
  let column: unknown
  try {
    column = ctx.get('sidebarRight')
  } catch {
    return undefined
  }
  if (column === null || typeof column !== 'object') return undefined
  const face = column as SidebarRightCloseFace
  return typeof face.close === 'function' || typeof face.active === 'function' ? face : undefined
}