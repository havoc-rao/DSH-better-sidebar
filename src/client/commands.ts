/**
 * The commands extension point (v0.16.0+): the second L1 contribution-point
 * contract after icon themes. Plugins register a {@link CommandDescriptor}
 * and can
 * - attach it to the existing context menus (file-tree rows, the tab bar)
 *   through `menus` — rendering is driven by the pure
 *   {@link commandMenuRows} builder (fail-open `when` predicates, stable
 *   `order`);
 * - run it programmatically (from another plugin, a keybinding `run`, or a
 *   tab component) through `BetterSidebarService.executeCommand` — unknown
 *   ids are a `false` no-op, a throwing `run` is swallowed (safeCall).
 *
 * Mirrors VSCode's `contributes.commands` + `contributes.menus` +
 * `vscode.commands.executeCommand` triangle, scoped to the sidebar's own
 * surfaces (an external plugin can never add rows to the HOST's menus —
 * the portal limit, AGENTS.md §7).
 */
import type { ReactNode } from 'react'
import type { SidebarTab } from './state.ts'

/** The menu surfaces a command may attach to. */
export type CommandMenuWhere = 'file-row' | 'dir-row' | 'root-row' | 'tab'

/** Every possible trigger origin of a command run. */
export type CommandRunWhere = CommandMenuWhere | 'programmatic'

/** The per-surface context handed to a `when` predicate. */
export interface CommandMenuContext {
  /** Row menus: the triggering path. */
  path?: string
  /** Row menus: whether the triggering row is a directory. */
  isDir?: boolean
  /** Row menus: whether the triggering row IS the session root. */
  isRoot?: boolean
  /** Tab menus: the triggering tab instance. */
  tab?: SidebarTab
}

/** The payload handed to `CommandDescriptor.run`. */
export interface CommandRunPayload extends CommandMenuContext {
  /** The triggering surface ('programmatic' for direct executeCommand). */
  where: CommandRunWhere
}

/** One menu attachment of a command. */
export interface CommandMenuContribution {
  where: CommandMenuWhere
  /**
   * Row visibility predicate; false hides the row. A THROWING predicate
   * keeps the row visible (fail-open — the menus must never break over one
   * plugin's bad predicate, same rule as the settings rows).
   */
  when?: (menu: CommandMenuContext) => boolean
  /** Sort order within the surface (ascending); default 100. */
  order?: number
}

/** The registration contract of `BetterSidebarService.registerCommand`. */
export interface CommandDescriptor {
  /** Unique id (recommend a package prefix: 'my-plugin:format'). */
  id: string
  /** Display name (i18n friendly: string or () => string). */
  title: string | (() => string)
  /** Menu row icon (optional; ReactNode or (size) => ReactNode). */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** Menu attachments (absent = programmatic execution only). */
  menus?: readonly CommandMenuContribution[]
  /** The action. A throwing run is swallowed (safeCall, console.error). */
  run: (payload: CommandRunPayload) => void
}

/** One rendered menu row of a command (id = the command id, so the
 *  caller's unknown-id routing falls through to executeCommand). */
export interface CommandMenuRow {
  id: string
  label: string
  icon?: ReactNode
}

/**
 * Build the plugin-command rows for one menu surface (pure; the consumers
 * append them after their built-in rows). Filters descriptors by `where`,
 * evaluates `when` (false → skip, throw → keep), sorts by `order`
 * (stable), and resolves labels/icons at 14px.
 */
export function commandMenuRows(
  commands: readonly CommandDescriptor[],
  where: CommandMenuWhere,
  context: CommandMenuContext,
): CommandMenuRow[] {
  const rows: Array<CommandMenuRow & { order: number }> = []
  for (const command of commands) {
    const menus = command.menus ?? []
    const match = menus.find(menu => menu.where === where)
    if (match === undefined) continue
    if (match.when !== undefined) {
      let visible = true
      try { visible = match.when(context) !== false } catch { /* fail-open */ }
      if (!visible) continue
    }
    rows.push({
      id: command.id,
      label: typeof command.title === 'function' ? command.title() : command.title,
      icon: typeof command.icon === 'function' ? command.icon(14) : command.icon,
      order: match.order ?? 100,
    })
  }
  return rows.sort((a, b) => a.order - b.order).map(({ id, label, icon }) => ({ id, label, icon }))
}