/**
 * The smallest contract the sidebar needs from the host layout owner and the
 * optional CMD service: both are read through these structural types, never
 * imported as values, so the plugin keeps no runtime dependency on either.
 */

/** One of the layout presets the host applies and persists. */
export type LayoutPreset = 'code' | 'equal' | 'classic'

/** Minimal observable face (`Store`-like) the controller sources expose. */
export interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }

/** The mounted sidebar controller's layout face. */
export interface LayoutController {
  mounted: Source<string | undefined>
  openTabs: Source<readonly { sessionId: string; tabId: string; kind: string }[]>
  active(): { id: string; kind: string } | undefined
  applyLayoutPreset(input: { preset: LayoutPreset; navigationPaneId?: string; navigationWidthPx?: number }): { status: 'applied'; changed: boolean; sessionId: string; navigationPaneId?: string } | { status: 'rejected'; reason: string }
}

/** What the CMD panel expects an action to return. */
export interface Result { kind: 'completed' | 'cancelled' | 'failed'; message?: string }

/** The subset of `ctx.commandPalette` this plugin registers into. */
export interface LayoutPalette {
  registerCommand(command: {
    id: string
    describe(): { title: string; localizedTitles: { zh: string; en: string }; pluginTag: { id: string; title: string; localizedTitles: { zh: string; en: string } }; aliases: string[]; disabledReason?: string }
    target: { kind: 'action'; execute(args: { signal: AbortSignal }): Result }
  }): () => void
  refresh(): void
}
