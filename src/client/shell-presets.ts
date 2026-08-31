/**
 * Built-in desktop-shell presets for the "位置兼容模式" secondary setting
 * (scheme `preset`). DATA-DRIVEN by design: each shell's adaptation lives
 * in one entry (strip values / optional CSS), the core applies it through
 * the SAME generic strip variable and CSS-injection mechanism — adding a
 * shell is adding data, never a code path.
 *
 * Inclusion rule (maintained in AGENTS.md §8): only shells that (a) appear
 * in this repo's issues/PRs (a user actually hit a problem) and (b) have
 * 100+ GitHub stars (a real user base). The mechanism is opt-in: auto
 * detection never applies a preset — the settings badge only SUGGESTS it.
 */
import type { DesktopEnv } from './desktop-env.ts'

export interface ShellPreset {
  /** Stable preset id (persisted in `titleBarPresetId`). */
  readonly id: string
  /** User-facing name of the shell. */
  readonly title: string
  /** One-line description shown in the settings popup. */
  readonly desc: string
  /**
   * The top strip (px) this shell reserves over web content, per
   * environment — the fallback used when neither the standard WCO API nor
   * the `dsh-desktop-titlebar-inset` contract parameter is available.
   * Return undefined when the shell needs no strip in that environment.
   * MUST be pure (called during render).
   */
  readonly stripFor?: (env: DesktopEnv) => number | undefined
  /**
   * The LEFT inset (px) this shell reserves at the window's top-left
   * corner, per environment — the horizontal sibling of `stripFor`
   * (macOS traffic lights in frameless shells, ~78px in DSH Desktop).
   * Consumed ONLY by the plugin's own IDE FULLSCREEN surface (⌘⌥⇧B,
   * `.panelMaximized`): the fullscreen panel covers the whole viewport,
   * so the HEADER tab strip's start point would land under the caption
   * buttons.
   * Return undefined when the shell needs no left reservation in that
   * environment. MUST be pure (called during render).
   */
  readonly leftFor?: (env: DesktopEnv) => number | undefined
  /**
   * Extra CSS applied while the preset is enabled (injected last, after the
   * plugin's own styles). Targets the plugin's stable data attributes and
   * shell-declared body/URL markers only — never other shells' class names.
   * Empty for presets fully covered by the strip variable.
   */
  readonly css?: string
  /**
   * Whether this shell's marker is currently visible (URL stamps / preload
   * markers — see desktop-env.ts). Used ONLY for the settings "已检测"
   * badge; never auto-applies anything. MUST be pure.
   */
  readonly detect?: (env: DesktopEnv) => boolean
}

/**
 * DeepSeek Harness Desktop (anywhere-labs, Electron, 16k+ stars — the most
 * reported shell in this repo's issues/PRs). Advanced mode: macOS reserves
 * a 20px caption row (traffic lights top-left) plus an ~78px left
 * traffic-light zone that the IDE FULLSCREEN tab strip must yield (see
 * leftFor), win32 draws the native window controls in a ~32px overlay (WCO
 * reports the real height when available, which the auto scheme already
 * consumes; the 32 is the no-WCO fallback). Compatibility mode keeps the
 * native frame — nothing.
 */
const DSH_DESKTOP: ShellPreset = {
  id: 'dsh-desktop',
  title: 'DeepSeek Harness Desktop',
  desc: 'Electron 高级模式（无边框）：macOS 顶栏 20px、IDE 模式左上 90px 红绿灯区、Windows 无 WCO 时 32px 标题栏让位',
  stripFor: (env) => {
    if (env.mode !== 'advanced') return undefined
    if (env.platform === 'darwin') return 20
    if (env.platform === 'win32') return 32
    return undefined
  },
  leftFor: (env) => {
    // macOS traffic lights drawn over web content (`titleBarStyle:
    // "hiddenInset"` + `trafficLightPosition(16,16)`): the ~90px zone —
    // 78px measured in docs/plans/2026-08-19-sidebar-injection-unified-host-
    // design.md §3.3 plus a little air so the tabs never crowd the caption
    // buttons. The reservation only affects the plugin's own IDE fullscreen
    // surface (the CSS consumer is `.panelMaximized .tabBar`).
    if (env.mode !== 'advanced') return undefined
    if (env.platform === 'darwin') return 90
    return undefined
  },
  detect: (env) => env.mode === 'advanced',
}

const PRESETS: readonly ShellPreset[] = [
  DSH_DESKTOP,
]

/** All built-in shell presets (registration order = settings list order). */
export function getShellPresets(): readonly ShellPreset[] {
  return PRESETS
}

/** One preset by id, or undefined for an unknown/empty id. */
export function getShellPreset(id: string): ShellPreset | undefined {
  return PRESETS.find(preset => preset.id === id)
}

/** The strip the active preset contributes for the given environment. */
export function presetStripFor(preset: ShellPreset | undefined, env: DesktopEnv): number | undefined {
  return preset?.stripFor?.(env)
}

/** The left inset the active preset contributes for the given environment. */
export function presetLeftFor(preset: ShellPreset | undefined, env: DesktopEnv): number | undefined {
  return preset?.leftFor?.(env)
}
