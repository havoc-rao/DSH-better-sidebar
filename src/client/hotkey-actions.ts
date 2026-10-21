import type { Context } from '../context-types.ts'
import type { BetterSidebarService } from './service.ts'
import { activateTab, allLeaves, type SidebarStore } from './state.ts'
import { registerBottomPanelHotkey, type HotkeyActionRegistry } from './bottom-panel-action.ts'
import { ensureBottomTerminal } from './workspace-terminals.ts'

interface WorkbenchControls {
  toggleFullscreen(): void
  focusTerminal(): void
}
// One owner per activation/store, not a global DOM lookup or cross-session singleton.
const controls = new WeakMap<SidebarStore, WorkbenchControls>()
export function attachWorkbenchControls(store: SidebarStore, owner: WorkbenchControls): () => void {
  controls.set(store, owner)
  return () => { if (controls.get(store) === owner) controls.delete(store) }
}

export function registerSidebarHotkeys(registry: HotkeyActionRegistry, store: SidebarStore, service: BetterSidebarService, cwdOf?: (sessionId: string) => string | undefined): () => void {
  const disposers: Array<() => void> = []
  const ready = (): boolean => store.getSnapshot().sessionId !== undefined && store.getSnapshot().state !== undefined
  const canOpen = (type: string): boolean => ready() && service.getTab(type) !== undefined && service.isTabEnabled(type)
  const open = (type: string): boolean => {
    if (!canOpen(type)) return false
    service.openTab({ type })
    return true
  }
  const add = (spec: Parameters<HotkeyActionRegistry['registerAction']>[0]): void => { disposers.push(registry.registerAction(spec)) }
  const dispose = (): void => { for (const release of disposers.splice(0).reverse()) release() }
  try {
    disposers.push(registerBottomPanelHotkey(registry, store))
    add({ id: 'toggle.terminal', def: { mac: 'ctrl+`', default: 'ctrl+`' }, group: 'panels', zh: '打开 / 聚焦终端', en: 'Open / focus terminal', available: () => canOpen('terminal'), run: () => {
      if (!canOpen('terminal')) return false
      const { sessionId, state } = store.getSnapshot()
      const leaf = allLeaves(state!.bottomSplits).find(leaf => leaf.tabs.some(tab => tab.type === 'terminal'))
      const tab = leaf?.tabs.find(tab => tab.type === 'terminal')
      store.reduce(state => ({ ...(leaf && tab ? activateTab(state, leaf.id, tab.id) : state), bottomOpen: true }))
      // Existing views are reused; provider-backed acquisition is deduplicated and
      // reports failures through the owner's normal workspaceTerminalError face.
      if (tab === undefined) void ensureBottomTerminal(store, service, sessionId!, cwdOf?.(sessionId!))
      controls.get(store)?.focusTerminal()
      return true
    } })
    add({ id: 'toggle.terminalFullscreen', def: 'ctrl+shift+j', group: 'panels', zh: '切换终端全屏', en: 'Toggle terminal fullscreen', available: () => ready() && controls.has(store), run: () => {
      const owner = controls.get(store)
      if (!ready() || owner === undefined) return false
      owner.toggleFullscreen()
      return true
    } })
    for (const [id, type, def, zh, en] of [
      ['open.git', 'git', 'ctrl+shift+g', 'Git 面板', 'Git panel'],
      ['open.sideChat', 'sidechat', 'alt+e', '侧边对话', 'Side chat'],
      ['open.subagent', 'subagent', null, '子代理面板', 'Subagents panel'],
    ] as const) add({ id, def, group: 'panels', zh, en, available: () => canOpen(type), run: () => open(type) })
  } catch (error) { dispose(); throw error }
  return dispose
}

/** Optional injected fiber owns all registrations, including hotkey unload/HMR.
 * No fallback key listener: disabled/remapped/conflicted bindings stay authoritative. */
export function installSidebarHotkeys(ctx: Context, store: SidebarStore, service: BetterSidebarService): void {
  ctx.inject(['hotkey'], scope => {
    const registry = scope.get('hotkey') as HotkeyActionRegistry | undefined
    if (typeof registry?.registerAction !== 'function') return
    scope.effect(() => registerSidebarHotkeys(registry, store, service, id => ctx.sessions.list.getSnapshot().byId[id]?.cwd), 'dsh-better-sidebar: owner hotkey actions')
  })
}
