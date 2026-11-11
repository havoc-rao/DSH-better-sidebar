/**
 * Registers the explicit layout actions (`better-sidebar.layout.*`) with the
 * optional CMD panel. The native layout owner commits and persists geometry;
 * these entries only validate the current target and forward the preset.
 */
import { isZh } from '../locales.ts'
import type { LayoutController, LayoutPalette, LayoutPreset } from './types.ts'
import { text } from './copy.ts'
import { filesPane } from './files-pane.ts'

/**
 * Register every layout command and return a disposer that removes them plus
 * their invalidation subscriptions; safe to call twice and to run partially.
 * @param palette - the CMD panel service to contribute into.
 * @param controllerOf - reads the current layout controller, if the host has one.
 * @returns the disposer for all contributions made here.
 */
export function registerLayoutCommands(palette: LayoutPalette, controllerOf: () => LayoutController | undefined): () => void {
  const disposers: Array<() => void> = []
  const check = (preset: LayoutPreset): string | undefined => {
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
      // The pane count leads every title: each preset applies to a different
      // number of existing panes, and users pick by that before reading the name.
      const titles = preset === 'code' ? { zh: '两栏 · 代码阅读布局', en: '2 panes · Code Layout' }
        : preset === 'equal' ? { zh: '两栏 · 均分', en: '2 panes · Equal columns' }
          : { zh: '三栏 · 经典布局：两侧最窄，中间展开', en: '3 panes · Classic layout: narrow sides, wide center' }
      disposers.push(palette.registerCommand({
        id: `better-sidebar.layout.${preset}`,
        describe: () => {
          const disabledReason = check(preset)
          return { title: isZh() ? titles.zh : titles.en, localizedTitles: titles,
            pluginTag: { id: 'better-sidebar', title: 'Sidebar', localizedTitles: { zh: '侧栏', en: 'Sidebar' } },
            aliases: preset === 'code' ? ['CODE', '代码模式', '阅读布局', '2 panes', '两栏', 'layout']
              : preset === 'equal' ? ['equal', '50:50', '均分', '2 panes', '两栏', 'layout']
                : ['classic', 'three columns', '经典', '三栏', '两侧最窄', '中间展开', '3 panes', 'width', 'layout'],
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
