/** Optional CMD entry points; the native layout owner commits and persists geometry. */
import type { Context } from '../context-types.ts'
import { isZh } from './locales.ts'

type Preset = 'code' | 'equal' | 'classic'
interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
export interface LayoutController {
  mounted: Source<string | undefined>
  openTabs: Source<readonly { sessionId: string; tabId: string; kind: string }[]>
  active(): { id: string; kind: string } | undefined
  applyLayoutPreset(input: { preset: Preset; navigationPaneId?: string; navigationWidthPx?: number }): { status: 'applied'; changed: boolean; sessionId: string; navigationPaneId?: string } | { status: 'rejected'; reason: string }
}
interface Result { kind: 'completed' | 'cancelled' | 'failed'; message?: string }
export interface LayoutPalette {
  registerCommand(command: {
    id: string
    describe(): { title: string; localizedTitles: { zh: string; en: string }; pluginTag: { id: string; title: string; localizedTitles: { zh: string; en: string } }; aliases: string[]; disabledReason?: string }
    target: { kind: 'action'; execute(args: { signal: AbortSignal }): Result }
  }): () => void
  refresh(): void
}

const copy = {
  unavailable: ['宿主尚未提供布局预设 API', 'The host does not provide layout presets'],
  noSession: ['请先打开一个会话', 'Open a session first'],
  noFiles: ['请先在侧栏打开 Files 文件页', 'Open Files in the sidebar first'],
  missingPane: ['Files 分栏已变化，请重新执行', 'The Files pane changed; try again'],
  blocked: ['当前布局无法应用该预设', 'This preset is unavailable for the current layout'],
  narrow: ['侧栏宽度不足，请先全屏或扩大侧栏', 'Expand or fullscreen the sidebar before applying this layout'],
  collapsed: ['请先展开侧栏再调整布局', 'Expand the sidebar before changing its layout'],
  twoPanes: ['均分布局需要两个已存在的分栏', 'Equal Columns requires two existing panes'],
  threePanes: ['经典三栏布局需要三个已存在的分栏', 'Classic three-column layout requires three existing panes'],
} as const
function text(key: keyof typeof copy): string { return copy[key][isZh() ? 0 : 1] }

/** Read public ownership markers, including inactive tab chips, never private layout state. */
function filesPane(controller: LayoutController, sessionId: string): string | undefined {
  const tabs = controller.openTabs.getSnapshot().filter(tab => tab.sessionId === sessionId && tab.kind === 'files')
  const active = controller.active()
  const selected = tabs.find(tab => tab.tabId === active?.id) ?? tabs[0]
  if (selected === undefined) return undefined
  const chips = [...document.querySelectorAll<HTMLElement>('[data-dockkit-tab]')].filter(chip =>
    chip.dataset.dockkitTab === selected.tabId
    && chip.closest<HTMLElement>('[data-sidebar-right-session]')?.dataset.sidebarRightSession === sessionId
    && chip.closest('[hidden], [inert]') === null)
  if (chips.length !== 1) return undefined
  // Collapsed columns retain their markers; floats are deliberately not navigation columns.
  return chips[0]?.closest<HTMLElement>('[data-dockkit-pane]')?.dataset.dockkitPane
}

export function registerLayoutCommands(palette: LayoutPalette, controllerOf: () => LayoutController | undefined): () => void {
  const disposers: Array<() => void> = []
  const check = (preset: Preset): string | undefined => {
    const controller = controllerOf()
    if (typeof controller?.applyLayoutPreset !== 'function') return text('unavailable')
    const sessionId = controller.mounted.getSnapshot()
    if (sessionId === undefined) return text('noSession')
    if (preset === 'code' && !controller.openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.kind === 'files')) return text('noFiles')
    return undefined
  }
  const release = (): void => { for (const dispose of disposers.splice(0).reverse()) dispose() }
  try {
    for (const preset of ['code', 'equal', 'classic'] as const) {
      const titles = preset === 'code' ? { zh: '切换为代码阅读布局', en: 'Code Layout' }
        : preset === 'equal' ? { zh: '均分两栏', en: 'Equal Columns' }
          : { zh: '经典三栏布局：两侧最窄，中间展开', en: 'Classic three-column layout' }
      disposers.push(palette.registerCommand({
        id: `better-sidebar.layout.${preset}`,
        describe: () => {
          const disabledReason = check(preset)
          return { title: isZh() ? titles.zh : titles.en, localizedTitles: titles,
            pluginTag: { id: 'better-sidebar', title: 'Sidebar', localizedTitles: { zh: '侧栏', en: 'Sidebar' } },
            aliases: preset === 'code' ? ['CODE', '代码模式', '阅读布局', 'layout']
              : preset === 'equal' ? ['equal', '50:50', '均分', 'layout']
                : ['classic', 'three columns', '经典', '三栏', '两侧最窄', '中间展开', 'width', 'layout'],
            ...(disabledReason === undefined ? {} : { disabledReason }),
          }
        },
        target: { kind: 'action', execute: ({ signal }) => {
          if (signal.aborted) return { kind: 'cancelled' }
          const denied = check(preset)
          if (denied !== undefined) return { kind: 'failed', message: denied }
          const controller = controllerOf()!
          const sessionId = controller.mounted.getSnapshot()!
          const navigationPaneId = preset === 'code' ? filesPane(controller, sessionId) : undefined
          if (preset === 'code' && navigationPaneId === undefined) return { kind: 'failed', message: text('missingPane') }
          if (signal.aborted) return { kind: 'cancelled' }
          if (controllerOf() !== controller || controller.mounted.getSnapshot() !== sessionId) return { kind: 'failed', message: text('missingPane') }
          const result = controller.applyLayoutPreset({ preset, ...(navigationPaneId === undefined ? {} : { navigationPaneId, navigationWidthPx: 240 }) })
          if (result.status === 'applied') return { kind: 'completed' }
          const message = result.reason === 'too-narrow' ? text('narrow') : result.reason === 'collapsed' ? text('collapsed')
            : result.reason === 'requires-two-panes' ? text('twoPanes')
              : result.reason === 'requires-three-panes' ? text('threePanes') : text('blocked')
          return { kind: 'failed', message }
        } },
      }))
    }
    const controller = controllerOf()
    if (typeof controller?.applyLayoutPreset === 'function') {
      disposers.push(controller.mounted.subscribe(() => { palette.refresh() }))
      disposers.push(controller.openTabs.subscribe(() => { palette.refresh() }))
    }
  } catch (error) { release(); throw error }
  return release
}

export function installLayoutCommands(ctx: Context): void {
  ctx.inject(['commandPalette'], scope => {
    const palette = scope.get('commandPalette') as LayoutPalette | undefined
    if (typeof palette?.registerCommand !== 'function') return
    scope.effect(() => registerLayoutCommands(palette, () => ctx.get('sidebarRight') as unknown as LayoutController | undefined), 'dsh-better-sidebar: layout commands')
  })
}
