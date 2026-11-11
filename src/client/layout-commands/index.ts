/**
 * The layout commands' public face. Call sites import from HERE
 * (`./layout-commands/index.ts`), so the modules behind it stay free to split
 * further without touching them. The native layout owner commits and persists
 * geometry; these modules only register CMD entries and forward presets.
 */
export { registerLayoutCommands } from './register.ts'
export { installLayoutCommands } from './install.ts'
export type { LayoutController, LayoutPalette, LayoutPreset, Result, Source } from './types.ts'
