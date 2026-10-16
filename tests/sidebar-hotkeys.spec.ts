// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { attachWorkbenchControls, installSidebarHotkeys, registerSidebarHotkeys } from '../src/client/hotkey-actions.ts'
import type { HotkeyActionRegistry } from '../src/client/bottom-panel-action.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore } from '../src/client/state.ts'

function setup() {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  for (const id of ['git', 'sidechat', 'subagent', 'terminal']) service.registerTab({ id, title: id, component: () => null })
  const actions = new Map<string, Parameters<HotkeyActionRegistry['registerAction']>[0]>()
  const releases = vi.fn()
  const registry: HotkeyActionRegistry = { registerAction(spec) {
    if (actions.has(spec.id)) throw new Error('duplicate')
    actions.set(spec.id, spec)
    return () => { if (actions.delete(spec.id)) releases(spec.id) }
  } }
  const run = (id: string) => actions.get(id)!.run({ event: new KeyboardEvent('keydown') })
  return { store, service, registry, actions, releases, run }
}

describe('sidebar-owned hotkey registry', () => {
  it('registers exactly six historical IDs/defaults and disposes idempotently across HMR', () => {
    const h = setup()
    const release = registerSidebarHotkeys(h.registry, h.store, h.service)
    expect([...h.actions.keys()]).toEqual(['toggle.bottomPanel', 'toggle.terminal', 'toggle.terminalFullscreen', 'open.git', 'open.sideChat', 'open.subagent'])
    expect([...h.actions.values()].map(a => a.def)).toEqual(['ctrl+j', { mac: 'ctrl+`', default: 'ctrl+`' }, 'ctrl+shift+j', 'ctrl+shift+g', 'alt+e', null])
    for (const action of h.actions.values()) { expect(action.available()).toBe(false); expect(action.run({ event: new KeyboardEvent('keydown') })).toBe(false) }
    release(); release()
    expect(h.actions.size).toBe(0)
    expect(h.releases).toHaveBeenCalledTimes(6)
    registerSidebarHotkeys(h.registry, h.store, h.service)()
    expect(h.releases).toHaveBeenCalledTimes(12)
  })

  it('opens owner tab types, follows sessions and respects tab disablement', () => {
    const h = setup()
    registerSidebarHotkeys(h.registry, h.store, h.service)
    h.store.setSession('hotkey-tabs')
    for (const [id, type] of [['open.git', 'git'], ['open.sideChat', 'sidechat'], ['open.subagent', 'subagent']]) {
      expect(h.run(id!)).toBe(true)
      expect(allLeaves(h.store.getSnapshot().state!.bottomSplits).flatMap(l => l.tabs).some(t => t.type === type)).toBe(true)
    }
    h.store.setPrefs({ ...h.store.getPrefs(), tabsEnabled: { git: false } })
    expect(h.actions.get('open.git')!.available()).toBe(false)
    expect(h.run('open.git')).toBe(false)
    h.store.setSession('hotkey-tabs-next')
    expect(h.run('open.subagent')).toBe(true)
    expect(allLeaves(h.store.getSnapshot().state!.bottomSplits).flatMap(l => l.tabs).some(t => t.type === 'subagent')).toBe(true)
  })

  it('reuses/activates a terminal without creating one and dispatches the shared fullscreen button action', () => {
    const h = setup()
    h.store.setSession('hotkey-terminal')
    h.store.reduce(s => ({ ...s, bottomOpen: false, bottomSplits: { kind: 'leaf', id: 'pane', active: 'other', tabs: [
      { id: 'shell', type: 'terminal', title: 'shell' }, { id: 'other', type: 'git', title: 'git' },
    ] } }))
    registerSidebarHotkeys(h.registry, h.store, h.service)
    const toggleFullscreen = vi.fn(), focusTerminal = vi.fn()
    const detach = attachWorkbenchControls(h.store, { toggleFullscreen, focusTerminal })
    expect(h.run('toggle.terminal')).toBe(true)
    const state = h.store.getSnapshot().state!
    expect(state.bottomOpen).toBe(true)
    expect(allLeaves(state.bottomSplits)[0]!.active).toBe('shell')
    expect(allLeaves(state.bottomSplits)[0]!.tabs).toHaveLength(2)
    expect(focusTerminal).toHaveBeenCalledOnce()
    expect(h.run('toggle.terminalFullscreen')).toBe(true)
    expect(toggleFullscreen).toHaveBeenCalledOnce()
    detach()
    expect(h.run('toggle.terminalFullscreen')).toBe(false)
    const newest = attachWorkbenchControls(h.store, { toggleFullscreen, focusTerminal })
    detach() // stale HMR cleanup cannot detach the replacement owner.
    expect(h.run('toggle.terminalFullscreen')).toBe(true)
    newest()
  })

  it('acquires a missing terminal once through its provider with the captured workspace cwd', async () => {
    const h = setup()
    h.store.setSession('hotkey-acquire')
    const create = vi.fn(async () => ({ terminalId: 'created', title: 'shell', cwd: '/remote', createdBySessionId: 'hotkey-acquire', createdAt: 1, exited: false }))
    const match = vi.fn(() => true)
    const terminate = vi.fn()
    h.service.registerTerminalProvider({ id: 'remote', match, createTransport: () => undefined,
      createWorkspaceSource: () => ({ create, list: async () => ({ terminals: [] }), terminate, createTransport: () => { throw new Error('unused') } }),
    })
    registerSidebarHotkeys(h.registry, h.store, h.service, () => '/remote')
    expect(h.run('toggle.terminal')).toBe(true)
    expect(h.run('toggle.terminal')).toBe(true)
    await vi.waitFor(() => expect(allLeaves(h.store.getSnapshot().state!.bottomSplits).flatMap(l => l.tabs)).toHaveLength(1))
    expect(match).toHaveBeenCalledWith('hotkey-acquire', '/remote', 'terminal:workspace-management')
    expect(create).toHaveBeenCalledOnce()
    expect(terminate).not.toHaveBeenCalled()
  })

  it('rolls back partial registrations on a duplicate ID', () => {
    const h = setup()
    const registerAction: HotkeyActionRegistry['registerAction'] = spec => {
      if (spec.id === 'open.git') throw new Error('duplicate')
      return h.registry.registerAction(spec)
    }
    expect(() => registerSidebarHotkeys({ registerAction }, h.store, h.service)).toThrow('duplicate')
    expect(h.actions.size).toBe(0)
    expect(h.releases).toHaveBeenCalledTimes(3)
  })

  it('uses the optional injected fiber for absent, late, unloaded and replaced hotkey services', () => {
    const h = setup()
    let callback: (scope: Context) => void = () => {}
    const ctx = { inject: vi.fn((_keys, cb) => { callback = cb }), sessions: { list: { getSnapshot: () => ({ byId: {} }) } } } as unknown as Context
    installSidebarHotkeys(ctx, h.store, h.service)
    expect(ctx.inject).toHaveBeenCalledWith(['hotkey'], expect.any(Function))
    const effects: Array<() => void> = []
    const scope = (registry?: HotkeyActionRegistry) => ({ get: () => registry, effect: (start: () => () => void) => effects.push(start()) }) as unknown as Context
    callback(scope())
    expect(h.actions.size).toBe(0)
    callback(scope(h.registry))
    expect(h.actions.size).toBe(6)
    effects.pop()!()
    expect(h.actions.size).toBe(0)
    callback(scope(h.registry))
    expect(h.actions.size).toBe(6)
    effects.pop()!()
  })
})
