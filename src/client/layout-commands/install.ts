/** Optional install into the host's CMD panel; absent service leaves the plugin unchanged. */
import type { Context } from '../../context-types.ts'
import type { LayoutController, LayoutPalette } from './types.ts'
import { registerLayoutCommands } from './register.ts'

/**
 * Contribute the layout commands when `ctx.commandPalette` is available.
 * Registration lives in the injected scope so service loss, plugin unload or
 * reload removes exactly these contributions.
 * @param ctx - the plugin's client context.
 */
export function installLayoutCommands(ctx: Context): void {
  ctx.inject(['commandPalette'], scope => {
    const palette = scope.get('commandPalette') as LayoutPalette | undefined
    if (typeof palette?.registerCommand !== 'function') return
    scope.effect(() => registerLayoutCommands(palette, () => ctx.get('sidebarRight') as unknown as LayoutController | undefined), 'dsh-better-sidebar: layout commands')
  })
}
