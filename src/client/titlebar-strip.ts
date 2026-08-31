/**
 * The title-bar strip resolution chain — the ONE place that decides how
 * many pixels the sidebar yields at the top. Standard signals first, then
 * the user's chosen scheme; never a per-shell branch:
 *
 *   0. `web` scheme — EXPLICIT "DSH official web": never adapt, not even
 *      standard WCO geometry (the user declares the plain web UI).
 *   1. Window Controls Overlay real geometry (standard API, authoritative
 *      when present — even 0, e.g. the overlay is hidden while maximized).
 *   2. The `dsh-desktop-titlebar-inset` URL contract parameter (a shell
 *      declares the exact pixels it reserves).
 *   3. The active shell preset's strip (scheme `preset` — opt-in data).
 *   4. The legacy manual `titleBarStripPx` (scheme `custom`).
 *   5. 0 — plain-browser semantics, nothing modified.
 *
 * The result drives `--dsh-title-bar-strip` + `body[data-dsh-title-bar-compat]`
 * exactly like the legacy boolean did; only the VALUE source changed.
 */
import type { DesktopEnv } from './desktop-env.ts'
import type { TitleBarScheme } from '../prefs-shared.ts'
import type { WcoSnapshot } from './wco.ts'
import { presetLeftFor, presetStripFor, type ShellPreset } from './shell-presets.ts'

export function computeTitleBarStrip(
  env: DesktopEnv,
  wco: WcoSnapshot,
  scheme: TitleBarScheme,
  preset: ShellPreset | undefined,
  customStripPx: number,
): number {
  if (scheme === 'web') return 0
  if (wco.present) return wco.height
  if (env.titlebarInset > 0) return env.titlebarInset
  if (scheme === 'preset') return presetStripFor(preset, env) ?? 0
  if (scheme === 'custom') return customStripPx
  return 0
}

/**
 * The IDE FULLSCREEN (⌘⌥⇧B) left-edge reservation — the HORIZONTAL sibling
 * of `computeTitleBarStrip`, consumed only by the plugin's own fullscreen
 * surface: `.panelMaximized .tabList`'s `padding-left` reads the written
 * `--dsh-ide-traffic-inset` (every right-panel tab strip in IDE mode — the
 * vscode layout's header strip and the docked layout's first pane strip
 * alike; the docked bottom workbench's strip is a sibling panel, sits at
 * the window's bottom, never under the lights). In IDE mode the panel
 * covers the whole viewport (100vw × 100vh), so the tab strip's start
 * point lands at the WINDOW's top-left corner — where frameless macOS
 * shells draw the native traffic lights over web content (no standard API
 * reports that zone; the macOS `windowControlsOverlay` is a
 * `visible:false` phantom). Gated exactly like the top strip:
 *
 *   0. `web` scheme — explicit "DSH official web": never adapt.
 *   1. `preset` scheme — the active preset's `leftFor` (opt-in data:
 *      dsh-desktop reserves 90px on darwin advanced).
 *   2. `auto` on a stamped darwin advanced shell — 90px. Unlike vertical
 *      title-bar height there is no standard browser API for this zone, and
 *      leaving it at zero makes the native traffic lights cover the first
 *      tab in the default configuration.
 *   3. `custom` — 0: the user's own CSS owns the geometry (customCss may
 *      override the variable with `!important`).
 */
export function computeIdeTrafficInset(
  env: DesktopEnv,
  scheme: TitleBarScheme,
  preset: ShellPreset | undefined,
): number {
  if (scheme === 'web') return 0
  if (scheme === 'preset') return presetLeftFor(preset, env) ?? 0
  if (scheme === 'auto' && env.desktop && env.mode === 'advanced' && env.platform === 'darwin') return 90
  return 0
}
