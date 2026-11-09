// @vitest-environment jsdom
/** A shortcut reuses tools across panes; normal service opens remain pane-local. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealToolShortcut, type ToolShortcutController } from '../src/client/tool-shortcut.ts'
import { registerSidebarHotkeys } from '../src/client/hotkey-actions.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'

function controller() {
  let session = 'current', expanded = true
  let active = { id: 'right-editor', kind: 'editor' }
  const tabs = [{ id: 'left-git', kind: 'git' }, active]
  const api: ToolShortcutController = {
    mounted: { getSnapshot: () => session }, tabsIn: vi.fn(() => tabs), active: () => active,
    focus: vi.fn(id => { active = tabs.find(tab => tab.id === id)! }),
    isExpanded: () => expanded, toggleExpanded: vi.fn(() => { expanded = !expanded }),
  }
  return { api, tabs, setSession: (id: string) => { session = id }, collapse: () => { expanded = false } }
}

afterEach(() => { document.body.replaceChildren() })
describe('Git shortcut across native panes', () => {
  it('activates the existing left Git and transfers DOM focus without opening', () => {
    const h = controller()
    document.body.innerHTML = '<div data-sidebar-right-session="current"><section data-dockkit-pane="left" tabindex="-1"><div data-dockkit-tab="left-git" aria-selected="true"></div></section></div><input>'
    vi.spyOn(document.querySelector('[data-dockkit-tab]')!, 'getClientRects').mockReturnValue([{ width: 10 }] as unknown as DOMRectList)
    document.querySelector('input')!.focus()
    expect(revealToolShortcut(h.api, 'current', 'git')).toBe(true)
    expect(h.api.focus).toHaveBeenCalledWith('left-git')
    expect(document.activeElement?.getAttribute('data-dockkit-pane')).toBe('left')
    expect(revealToolShortcut(h.api, 'current', 'git')).toBe(true)
    expect(h.tabs).toHaveLength(2)
  })
  it('expands a collapsed column and prefers an already active Git among duplicates', () => {
    const h = controller()
    h.tabs.push({ id: 'second-git', kind: 'git' })
    h.api.focus('second-git')
    h.collapse()
    expect(revealToolShortcut(h.api, 'current', 'git')).toBe(true)
    expect(h.api.focus).toHaveBeenLastCalledWith('second-git')
    expect(h.api.toggleExpanded).toHaveBeenCalledOnce()
  })
  it('never focuses another session or hidden DOM, and reports missing tools', () => {
    const h = controller()
    document.body.innerHTML = '<div hidden data-sidebar-right-session="current"><section data-dockkit-pane="left" tabindex="-1"><div data-dockkit-tab="left-git" aria-selected="true"></div></section></div><input>'
    const input = document.querySelector('input')!
    input.focus()
    expect(revealToolShortcut(h.api, 'current', 'git')).toBe(true)
    expect(document.activeElement).toBe(input)
    h.setSession('other')
    expect(revealToolShortcut(h.api, 'current', 'git')).toBe(false)
    h.setSession('current'); h.tabs.splice(0, 1)
    expect(revealToolShortcut(h.api, 'current', 'git')).toBe(false)
  })
  it('does not steal DOM focus after a session switch during activation', () => {
    const h = controller()
    document.body.innerHTML = '<div data-sidebar-right-session="current"><section data-dockkit-pane="left" tabindex="-1"><div data-dockkit-tab="left-git" aria-selected="true"></div></section></div><input>'
    const input = document.querySelector('input')!
    input.focus()
    vi.mocked(h.api.focus).mockImplementation(() => { h.setSession('next') })
    expect(revealToolShortcut(h.api, 'current', 'git')).toBe(true)
    expect(document.activeElement).toBe(input)
  })

  it('reuses an existing bottom Git without invoking the normal open path', () => {
    const store = createSidebarStore()
    store.setSession('current')
    store.reduce(state => ({ ...state, bottomOpen: false, bottomSplits: {
      kind: 'leaf', id: 'bottom-pane', active: 'other', tabs: [
        { id: 'existing-git', type: 'git', title: 'Git' }, { id: 'other', type: 'terminal', title: 'Terminal' },
      ],
    } }))
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'git', title: 'Git', component: () => null })
    const open = vi.spyOn(service, 'openTab')
    let run!: () => boolean
    registerSidebarHotkeys({ registerAction(action) {
      if (action.id === 'open.git') run = () => action.run({ event: new KeyboardEvent('keydown') })
      return () => {}
    } }, store, service)
    expect(run()).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(store.getSnapshot().state!.bottomOpen).toBe(true)
    expect(store.getSnapshot().state!.bottomSplits).toMatchObject({ active: 'existing-git', tabs: expect.arrayContaining([{ id: 'existing-git', type: 'git', title: 'Git' }]) })
  })

  it('the registered Git action reveals first and opens only if absent', () => {
    const h = controller(), store = createSidebarStore()
    store.setSession('current')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'git', title: 'Git', component: () => null })
    const open = vi.spyOn(service, 'openTab')
    let run!: () => boolean
    registerSidebarHotkeys({ registerAction(action) {
      if (action.id === 'open.git') run = () => action.run({ event: new KeyboardEvent('keydown') })
      return () => {}
    } }, store, service, undefined, () => h.api)
    expect(run()).toBe(true)
    expect(open).not.toHaveBeenCalled()
    h.tabs.splice(0, 1)
    expect(run()).toBe(true)
    expect(open).toHaveBeenCalledOnce()
  })
})
