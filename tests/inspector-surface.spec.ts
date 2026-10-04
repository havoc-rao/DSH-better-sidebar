import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { INSPECTOR_ROOT_SLOT, INSPECTOR_VIEW_ID, registerInspectorSurface } from '../src/client/inspector-surface.tsx'

function setup(throwSlot = false) {
  const declarations = new Map<string, () => () => void>()
  const unregister = vi.fn()
  const register = vi.fn((_options: Record<string, unknown>, _component: unknown) => {
    if (throwSlot) throw Error('slot failure')
    return unregister
  })
  const ctx = { slots: { inject: (name: string, cb: () => () => void) => {
    declarations.set(name, cb); return () => {}
  }, register } } as unknown as Context
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerInspector({ id: 'dsh-gca-plans', title: 'Recent plans', entry: true, component: () => null })
  const releaseKey = vi.fn()
  const controller = { register: vi.fn(() => releaseKey), open: vi.fn(), close: vi.fn() }
  registerInspectorSurface(ctx, service, controller)
  return { declarations, unregister, register, store, service, controller, releaseKey }
}
const seed = { type: 'dsh-gca-plans', id: 'dsh-gca-plans', resource: {}, location: { section: 'summary' } }

describe('root inspector public seat', () => {
  it('registers actual host key/slot, opens without session and releases registration', () => {
    const { declarations, register, service, controller, store, releaseKey, unregister } = setup()
    expect(service.openInspector(seed)).toBe(false)
    const release = declarations.get(INSPECTOR_ROOT_SLOT)!()
    expect(controller.register).toHaveBeenCalledWith(INSPECTOR_VIEW_ID)
    expect(register.mock.calls[0]?.[0]).toMatchObject({ name: 'rightbar.root', key: INSPECTOR_VIEW_ID })
    const inject = register.mock.calls[0]![0].inject as () => Record<string, unknown>
    expect(inject()).toMatchObject({ visible: true, service })
    expect(service.openInspector(seed)).toBe(true)
    expect(controller.open).toHaveBeenCalledWith(INSPECTOR_VIEW_ID)
    expect(store.getSnapshot().sessionId).toBeUndefined()
    expect(store.getSnapshot().state).toBeUndefined()
    service.closeInspector(seed.type, seed.id)
    expect(controller.close).toHaveBeenCalledWith(INSPECTOR_VIEW_ID)
    release()
    expect(unregister).toHaveBeenCalledOnce()
    expect(releaseKey).toHaveBeenCalledOnce()
    expect(service.openInspector(seed)).toBe(false)
  })
  it('does not contribute inspector entries to the root footer', () => {
    const { declarations } = setup()
    expect([...declarations.keys()]).toEqual([INSPECTOR_ROOT_SLOT])
    expect(declarations.has('sidebar.footer.action')).toBe(false)
  })
  it('rolls back the occupied key when slot registration fails', () => {
    const { declarations, service, releaseKey } = setup(true)
    expect(() => declarations.get(INSPECTOR_ROOT_SLOT)!()).toThrow('slot failure')
    expect(releaseKey).toHaveBeenCalledOnce()
    expect(service.openInspector(seed)).toBe(false)
  })
  it('returns false if actual host open throws', () => {
    const { declarations, service, controller } = setup()
    declarations.get(INSPECTOR_ROOT_SLOT)!()
    controller.open.mockImplementation(() => { throw Error('unregistered') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(service.openInspector(seed)).toBe(false)
    expect(service.getInspectorSnapshot().active).toBeUndefined()
    log.mockRestore()
  })
})
