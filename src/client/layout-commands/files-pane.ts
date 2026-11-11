/** Finds the docked pane that currently shows the Files tab, using only public DOM markers. */
import type { LayoutController } from './types.ts'

/**
 * Read public ownership markers, including inactive tab chips, never private layout state.
 * @param controller - mounted layout controller supplying tab inventory.
 * @param sessionId - Session whose Files pane is wanted.
 * @returns the pane id, or `undefined` when the Files pane cannot be identified uniquely.
 */
export function filesPane(controller: LayoutController, sessionId: string): string | undefined {
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
