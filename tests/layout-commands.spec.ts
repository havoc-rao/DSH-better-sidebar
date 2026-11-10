// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerLayoutCommands, installLayoutCommands, type LayoutController, type LayoutPalette } from '../src/client/layout-commands.ts'
import type { Context } from '../src/context-types.ts'

function setup() {
  let session: string | undefined = 'current'
  const listeners = new Set<() => void>()
  const source = <T,>(getSnapshot: () => T) => ({ getSnapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } })
  const rows = [{ sessionId: 'current', tabId: 'files', kind: 'files' }]
  const controller: LayoutController = {
    mounted: source(() => session), openTabs: source(() => rows), active: () => ({ id: 'editor', kind: 'text' }),
    applyLayoutPreset: vi.fn<LayoutController['applyLayoutPreset']>(() => ({ status: 'applied', changed: true, sessionId: 'current' })),
  }
  const commands = new Map<string, Parameters<LayoutPalette['registerCommand']>[0]>()
  const palette: LayoutPalette = { registerCommand(command) { if (commands.has(command.id)) throw new Error('duplicate'); commands.set(command.id, command); return () => { commands.delete(command.id) } }, refresh: vi.fn() }
  const run = (preset: string, signal = new AbortController().signal) => commands.get(`better-sidebar.layout.${preset}`)!.target.execute({ signal })
  document.body.innerHTML = '<div data-sidebar-right-session="current"><section data-dockkit-pane="left"><div data-dockkit-tab="files"></div></section></div>'
  return { controller, palette, commands, run, rows, listeners, setSession: (value: string | undefined) => { session = value } }
}
afterEach(() => { document.body.replaceChildren() })
describe('explicit sidebar layout CMD contributions', () => {
  it('registers bilingual searchable actions and applies CODE to the Files pane only on execution', () => {
    const h = setup(), release = registerLayoutCommands(h.palette, () => h.controller)
    expect(h.commands.size).toBe(2)
    expect(h.commands.get('better-sidebar.layout.code')!.describe().aliases).toContain('CODE')
    expect(h.controller.applyLayoutPreset).not.toHaveBeenCalled()
    expect(h.run('code')).toEqual({ kind: 'completed' })
    expect(h.controller.applyLayoutPreset).toHaveBeenCalledExactlyOnceWith({ preset: 'code', navigationPaneId: 'left', navigationWidthPx: 240 })
    expect(h.run('equal')).toEqual({ kind: 'completed' })
    expect(h.controller.applyLayoutPreset).toHaveBeenLastCalledWith({ preset: 'equal' })
    release(); release()
    expect(h.commands.size).toBe(0); expect(h.listeners.size).toBe(0)
  })
  it('rejects cancellation, missing Files, stale sessions and floating targets without applying', () => {
    const h = setup(); registerLayoutCommands(h.palette, () => h.controller)
    const abort = new AbortController(); abort.abort()
    expect(h.run('code', abort.signal)).toEqual({ kind: 'cancelled' })
    h.setSession('other'); expect(h.run('code').kind).toBe('failed')
    h.setSession(undefined); expect(h.run('equal').kind).toBe('failed')
    h.setSession('current')
    document.querySelector('section')!.removeAttribute('data-dockkit-pane')
    document.querySelector('section')!.setAttribute('data-dockkit-float', 'floating')
    expect(h.run('code').kind).toBe('failed')
    h.rows.splice(0)
    expect(h.run('code').kind).toBe('failed')
    expect(h.controller.applyLayoutPreset).not.toHaveBeenCalled()
  })
  it('rejects duplicate/hidden ownership markers and never falls back to another session pane', () => {
    const h = setup(); registerLayoutCommands(h.palette, () => h.controller)
    const owner = document.querySelector('[data-sidebar-right-session]')!
    const duplicate = owner.cloneNode(true)
    document.body.append(duplicate)
    expect(h.run('code').kind).toBe('failed')
    duplicate.parentNode!.removeChild(duplicate)
    owner.setAttribute('hidden', '')
    expect(h.run('code').kind).toBe('failed')
    owner.removeAttribute('hidden')
    owner.setAttribute('data-sidebar-right-session', 'other')
    expect(h.run('code').kind).toBe('failed')
    expect(h.controller.applyLayoutPreset).not.toHaveBeenCalled()
  })

  it('treats an already applied preset as completed without opening or moving any tabs', () => {
    const h = setup(); registerLayoutCommands(h.palette, () => h.controller)
    vi.mocked(h.controller.applyLayoutPreset).mockReturnValue({ status: 'applied', changed: false, sessionId: 'current' })
    expect(h.run('code')).toEqual({ kind: 'completed' })
    expect(h.run('code')).toEqual({ kind: 'completed' })
    expect(h.rows).toEqual([{ sessionId: 'current', tabId: 'files', kind: 'files' }])
    expect(h.controller.applyLayoutPreset).toHaveBeenCalledTimes(2)
  })

  it('revalidates the Session after resolving the navigation pane', () => {
    const h = setup(); registerLayoutCommands(h.palette, () => h.controller)
    vi.spyOn(h.controller, 'active').mockImplementation(() => { h.setSession('next'); return undefined })
    expect(h.run('code').kind).toBe('failed')
    expect(h.controller.applyLayoutPreset).not.toHaveBeenCalled()
  })

  it('shows host rejection and missing capability without claiming success', () => {
    const h = setup(); let owner: LayoutController | undefined = h.controller
    registerLayoutCommands(h.palette, () => owner)
    vi.mocked(h.controller.applyLayoutPreset).mockReturnValue({ status: 'rejected', reason: 'too-narrow' })
    expect(h.run('code')).toMatchObject({ kind: 'failed', message: expect.stringMatching(/宽度|fullscreen/) })
    owner = undefined
    expect(h.commands.get('better-sidebar.layout.code')!.describe().disabledReason).toBeTruthy()
    expect(h.run('code').kind).toBe('failed')
  })
  it('refreshes availability and rolls back partial registration', () => {
    const h = setup(); const release = registerLayoutCommands(h.palette, () => h.controller)
    for (const notify of h.listeners) notify()
    expect(h.palette.refresh).toHaveBeenCalledTimes(2)
    release()
    const register = h.palette.registerCommand
    h.palette.registerCommand = command => { if (command.id.endsWith('.equal')) throw new Error('duplicate'); return register(command) }
    expect(() => registerLayoutCommands(h.palette, () => h.controller)).toThrow('duplicate')
    expect(h.commands.size).toBe(0)
  })
  it('releases the first subscription if the second subscription fails', () => {
    const h = setup()
    vi.spyOn(h.controller.openTabs, 'subscribe').mockImplementation(() => { throw new Error('subscribe failed') })
    expect(() => registerLayoutCommands(h.palette, () => h.controller)).toThrow('subscribe failed')
    expect(h.commands.size).toBe(0)
    expect(h.listeners.size).toBe(0)
  })
  it('installs optionally in the injected scope and releases on unload', () => {
    const h = setup(); let callback!: (scope: Context) => void
    const ctx = { inject: vi.fn((_keys, cb) => { callback = cb }), get: () => h.controller } as unknown as Context
    installLayoutCommands(ctx)
    expect(ctx.inject).toHaveBeenCalledWith(['commandPalette'], expect.any(Function))
    let release!: () => void
    callback({ get: () => h.palette, effect: (start: () => () => void) => { release = start() } } as unknown as Context)
    expect(h.commands.size).toBe(2)
    release(); expect(h.commands.size).toBe(0)
  })
})
