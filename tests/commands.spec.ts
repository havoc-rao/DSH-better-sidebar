/**
 * Tests for the commands extension point (src/client/commands.ts + the
 * service surface): registry lifecycle, executeCommand semantics (unknown
 * id no-op, throwing run swallowed), the pure menu-row builder
 * (commandMenuRows), and the payload shape the menus hand to `run`.
 */
import { describe, expect, it } from 'vitest'

// Mock browser globals (SidebarStore uses window.setTimeout + localStorage).
const g = globalThis as Record<string, unknown>
if (g.window === undefined) {
  g.window = {
    clearTimeout: () => {},
    setTimeout: (_fn: () => void) => 0,
    innerWidth: 1024,
  }
}
if (g.localStorage === undefined) {
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
}

import { createBetterSidebarService, SIDEBAR_FEATURES } from '../src/client/service.ts'
import { createSidebarStore, type SidebarTab } from '../src/client/state.ts'
import {
  commandMenuRows, type CommandDescriptor, type CommandRunPayload,
} from '../src/client/commands.ts'

const svgData = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
/** A minimal tab instance for payload assertions. */
const TAB: SidebarTab = { id: 't1', type: 'terminal', title: 'Term' }

function command(overrides: Partial<CommandDescriptor> = {}): CommandDescriptor {
  return {
    id: 'cmd',
    title: () => 'Run',
    run: () => {},
    ...overrides,
  }
}

describe('commands service surface', () => {
  it('register/get/dispose lifecycle + registry notifications + duplicate id throws', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    expect(service.getCommands()).toHaveLength(0)
    let calls = 0
    const unsub = service.subscribe(() => { calls++ })
    const dispose = service.registerCommand(command({ id: 'my:cmd' }))
    expect(service.getCommands().map(c => c.id)).toEqual(['my:cmd'])
    expect(calls).toBe(1)
    expect(() => service.registerCommand(command({ id: 'my:cmd' }))).toThrow(/already registered/)
    dispose()
    expect(service.getCommands()).toHaveLength(0)
    expect(calls).toBe(2)
    unsub()
  })

  it('executeCommand runs the command with the payload and returns true', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const payloads: Array<CommandRunPayload | undefined> = []
    service.registerCommand(command({ id: 'my:run', run: (payload) => { payloads.push(payload) } }))
    const payload: CommandRunPayload = { where: 'file-row', path: '/repo/a.ts', isDir: false, isRoot: false }
    expect(service.executeCommand('my:run', payload)).toBe(true)
    expect(payloads).toEqual([payload])
    // Without a payload the where defaults to 'programmatic'.
    service.executeCommand('my:run')
    expect(payloads[1]).toEqual({ where: 'programmatic' })
  })

  it('executeCommand: unknown id is a strict false no-op; a THROWING run is swallowed and still reports true', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerCommand(command({ id: 'my:boom', run: () => { throw new Error('boom') } }))
    expect(service.executeCommand('missing', { where: 'programmatic' })).toBe(false)
    expect(service.executeCommand('my:boom', { where: 'tab', tab: TAB })).toBe(true)
  })

  it('features advertise commands', () => {
    expect(SIDEBAR_FEATURES).toContain('commands')
  })
})

describe('commandMenuRows (pure builder)', () => {
  it('collects only the commands whose menus target the surface, sorted by order (stable)', () => {
    const commands = [
      command({ id: 'late', title: () => 'Late', menus: [{ where: 'file-row', order: 50 }] }),
      command({ id: 'early', title: () => 'Early', menus: [{ where: 'dir-row', order: 10 }] }),
      command({ id: 'both', title: () => 'Both', menus: [{ where: 'file-row', order: 10 }, { where: 'tab', order: 1 }] }),
      command({ id: 'nowhere', title: () => 'Nowhere' }), // no menus → invisible
    ]
    expect(commandMenuRows(commands, 'file-row', {}).map(r => r.id)).toEqual(['both', 'late'])
    expect(commandMenuRows(commands, 'dir-row', {}).map(r => r.id)).toEqual(['early'])
    expect(commandMenuRows(commands, 'tab', {}).map(r => r.id)).toEqual(['both'])
    expect(commandMenuRows(commands, 'root-row', {})).toEqual([])
    // Stable sort: equal orders keep registration order.
    const tied = [
      command({ id: 'a', menus: [{ where: 'file-row' }] }),
      command({ id: 'b', menus: [{ where: 'file-row' }] }),
    ]
    expect(commandMenuRows(tied, 'file-row', {}).map(r => r.id)).toEqual(['a', 'b'])
  })

  it('resolves labels at render and passes icons through', () => {
    const icon = () => 'icon-node'
    const commands = [
      command({
        id: 'x',
        title: () => 'Fmt',
        icon: (size: number) => `${icon()}-${size}`,
        menus: [{ where: 'file-row' }],
      }),
      command({ id: 'y', title: 'Static', menus: [{ where: 'dir-row', order: -10 }] }),
    ]
    expect(commandMenuRows(commands, 'file-row', {})).toEqual([{ id: 'x', label: 'Fmt', icon: 'icon-node-14' }])
    expect(commandMenuRows(commands, 'dir-row', {})).toEqual([{ id: 'y', label: 'Static', icon: undefined }])
  })

  it('when: false hides the row; a THROWING predicate keeps it visible (fail-open)', () => {
    const commands = [
      command({ id: 'hidden', menus: [{ where: 'file-row', when: () => false }] }),
      command({ id: 'throwing', menus: [{ where: 'file-row', when: () => { throw new Error('boom') } }] }),
      command({ id: 'gated', menus: [{ where: 'file-row', when: (menu) => menu.isDir === true }] }),
    ]
    expect(commandMenuRows(commands, 'file-row', {}).map(r => r.id)).toEqual(['throwing'])
    expect(commandMenuRows(commands, 'file-row', { isDir: true }).map(r => r.id)).toEqual(['throwing', 'gated'])
  })

  it('an svg asset is passed through untouched (the icons stay plugin-side)', () => {
    const commands = [command({
      id: 'x',
      icon: svgData,
      menus: [{ where: 'tab' }],
    })]
    expect(commandMenuRows(commands, 'tab', { tab: undefined })[0]?.icon).toBe(svgData)
  })
})