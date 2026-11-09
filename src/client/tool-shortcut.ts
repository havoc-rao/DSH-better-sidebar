/** Keyboard-only tool reveal: preserve an existing page's pane, not global open semantics. */
import { flushSync } from 'react-dom'

export interface ToolShortcutController {
  mounted: { getSnapshot(): string | undefined }
  tabsIn(sessionId: string): readonly { id: string; kind: string }[]
  active(): { id: string; kind: string } | undefined
  focus(tabId: string): void
  isExpanded(): boolean
  toggleExpanded(): void
}

/** Return false only when no current native tool exists; the caller may then open one. */
export function revealToolShortcut(controller: ToolShortcutController | undefined, sessionId: string, kind: 'git'): boolean {
  if (controller === undefined || controller.mounted.getSnapshot() !== sessionId) return false
  const tabs = controller.tabsIn(sessionId).filter(tab => tab.kind === kind)
  const active = controller.active()
  const tab = tabs.find(tab => tab.id === active?.id) ?? tabs[0]
  if (tab === undefined) return false
  flushSync(() => {
    controller.focus(tab.id)
    if (controller.mounted.getSnapshot() === sessionId && !controller.isExpanded()) controller.toggleExpanded()
  })
  // Layout activation alone is not DOM focus. Scope to the same live Session
  // and selected tab; hidden retained sessions and duplicate identities lose.
  if (controller.mounted.getSnapshot() !== sessionId) return true
  const matches = [...document.querySelectorAll<HTMLElement>('[data-dockkit-tab][aria-selected="true"]')]
    .filter(element => element.dataset.dockkitTab === tab.id
      && element.closest<HTMLElement>('[data-sidebar-right-session]')?.dataset.sidebarRightSession === sessionId
      && element.closest('[hidden], [aria-hidden="true"], [inert]') === null
      && element.getClientRects().length > 0)
  if (matches.length === 1) matches[0]?.closest<HTMLElement>('[data-dockkit-pane], [data-dockkit-float]')?.focus({ preventScroll: true })
  return true
}
