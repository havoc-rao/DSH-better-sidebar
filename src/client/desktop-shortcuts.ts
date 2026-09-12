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
 * The plugin's decision for Cmd+W is "close the active tab instead of the
 * app": the native right Sidebar's active tab first (kernel controller
 * `ctx.sidebarRight`, the plugin's own tab types live there since the native
 * baseline), then the bottom workbench's active tab as the fallback for
 * popup / session windows without a native column. Nothing closable → the
 * press stays unclaimed and the shell keeps its default (the close-confirm
 * dialog) — the plugin never weakens the app's own close guard.
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
 * The Cmd+W claim decision: close the active tab instead of the app.
 *
 * Order: the native right Sidebar's active tab while the column is expanded
 * (or its state is unknown in windows that mount the column late); then the
 * bottom workbench's active tab; nothing closable → `false`.
 *
 * A native close that the kernel refuses (the sole docked guide) is detected
 * by re-reading the active tab: the same tab id still active means nothing
 * closed, and the decision falls through to the workbench.
 * @param ctx - the client context face (kernel `sidebarRight` read structurally).
 * @param service - the plugin's own service (bottom-workbench close path).
 * @returns `true` when a tab was closed; `false` when nothing was closable.
 */
export function claimCloseActiveTab(ctx: DesktopShortcutContext, service: BetterSidebarService): boolean {
  if (closeNativeActiveTab(ctx)) return true
  return closeBottomActiveTab(service)
}

/** Close the active tab of the kernel's right Sidebar; see {@link claimCloseActiveTab}. */
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
  // workbench. Unknown (no controller / a late-mounting window) still tries.
  if (expanded === false) return false
  let tab: { id: string } | undefined
  try {
    tab = sidebar.active?.()
  } catch {
    return false
  }
  if (tab === undefined) return false
  try {
    sidebar.close?.(tab.id)
  } catch {
    return false
  }
  let after: { id: string } | undefined
  try {
    after = sidebar.active?.()
  } catch {
    after = undefined
  }
  // The kernel refuses only the sole docked guide; a refused close leaves
  // the same tab active. Any other outcome (tab gone, or the pane moved on
  // to a neighbor) means the close landed.
  return after === undefined || after.id !== tab.id
}

/** Close the bottom workbench's active tab (the pre-native fallback surface). */
function closeBottomActiveTab(service: BetterSidebarService): boolean {
  const state = service.getSnapshot().state
  if (state === undefined || state.bottomOpen !== true) return false
  const leaves = allLeaves(state.bottomSplits)
  const leaf = leaves.find(candidate => candidate.id === state.activePane) ?? leaves[0]
  if (leaf === undefined) return false
  const tab = leaf.tabs.find(candidate => candidate.id === leaf.active) ?? leaf.tabs[0]
  if (tab === undefined) return false
  // No scope: the current session (the state read above is its snapshot).
  service.closeTab(tab.id)
  return true
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