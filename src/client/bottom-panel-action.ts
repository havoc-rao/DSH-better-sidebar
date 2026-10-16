import { toggleBottomPanel, type SidebarStore } from './state.ts'

/** Business action shared by the header button and the optional hotkey slot. */
export function toggleBottomPanelAction(store: SidebarStore): boolean {
  const { sessionId, state } = store.getSnapshot()
  if (sessionId === undefined || state === undefined) return false
  store.reduce(toggleBottomPanel)
  return true
}

/** Structural optional API: no runtime import or dependency on dsh-hotkey. */
export interface HotkeyActionRegistry {
  registerAction(action: {
    id: string
    def: string | Partial<Record<'mac' | 'default' | 'win' | 'linux' | 'other', string>> | null
    group: 'panels'
    zh: string
    en: string
    available: () => boolean
    run: (context: { event: KeyboardEvent }) => boolean
  }): () => void
}

export function registerBottomPanelHotkey(registry: HotkeyActionRegistry, store: SidebarStore): () => void {
  return registry.registerAction({
    // Keep the historical id so saved user keybindings continue to apply.
    id: 'toggle.bottomPanel',
    def: 'ctrl+j',
    group: 'panels',
    zh: '切换底部面板',
    en: 'Toggle bottom panel',
    available: () => {
      const { sessionId, state } = store.getSnapshot()
      return sessionId !== undefined && state !== undefined
    },
    run: () => toggleBottomPanelAction(store),
  })
}
