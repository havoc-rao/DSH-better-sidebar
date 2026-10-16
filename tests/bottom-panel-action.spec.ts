// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { registerBottomPanelHotkey, toggleBottomPanelAction, type HotkeyActionRegistry } from '../src/client/bottom-panel-action.ts'
import { allLeaves, createSidebarStore } from '../src/client/state.ts'

describe('business-owned bottom panel hotkey', () => {
  it('registers the historical binding identity and returns the slot disposer', () => {
    const store = createSidebarStore()
    const dispose = vi.fn()
    const registerAction = vi.fn<HotkeyActionRegistry['registerAction']>(() => dispose)
    expect(registerBottomPanelHotkey({ registerAction }, store)).toBe(dispose)
    const action = registerAction.mock.calls[0]![0]
    expect(action).toMatchObject({ id: 'toggle.bottomPanel', def: 'ctrl+j', group: 'panels' })
    expect(action.available()).toBe(false)
    expect(action.run({ event: {} as KeyboardEvent })).toBe(false)
  })

  it('uses the same action as the button without adding or rebinding terminal tabs', () => {
    const store = createSidebarStore()
    store.setSession(`bottom-action-${Math.random()}`)
    store.reduce(state => ({ ...state, bottomOpen: false, bottomSplits: {
      kind: 'leaf', id: 'existing', active: 'view', tabs: [{ id: 'view', type: 'terminal', title: 'Existing', meta: { workspaceTerminalId: 'shell' } }],
    } }))
    const registerAction = vi.fn<HotkeyActionRegistry['registerAction']>(() => () => {})
    registerBottomPanelHotkey({ registerAction }, store)
    const action = registerAction.mock.calls[0]![0]
    const tabs = allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(action.available()).toBe(true)
    for (let i = 0; i < 3; i++) {
      expect(action.run({ event: {} as KeyboardEvent })).toBe(true)
      expect(store.getSnapshot().state!.bottomOpen).toBe(true)
      expect(toggleBottomPanelAction(store)).toBe(true)
      expect(store.getSnapshot().state!.bottomOpen).toBe(false)
      expect(allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)).toEqual(tabs)
    }
    // The registered handler follows the current session, not its registration session.
    store.setSession(`bottom-action-next-${Math.random()}`)
    expect(action.run({ event: {} as KeyboardEvent })).toBe(true)
    expect(store.getSnapshot().state!.bottomOpen).toBe(true)
  })
})
