import { describe, expect, it, vi } from 'vitest'
import { createInspectorApi, INSPECTOR_STORAGE_KEY, type InspectorStorage } from '../src/client/inspectors.ts'

function setup() {
  const values = new Map<string, string>()
  const storage: InspectorStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
  const api = createInspectorApi(vi.fn(), storage)
  const surface = { reveal: vi.fn(() => true), close: vi.fn() }
  const descriptor = { id: 'plan', title: 'Plan', component: () => null, entry: true }
  api.registerInspector(descriptor)
  api.setInspectorSurface(surface)
  return { api, surface, storage, descriptor, values }
}
const seed = { type: 'plan', id: 'p1', resource: { sourceSessionId: 'source', taskId: 'task', planId: 'p1', revision: 1, digest: 'hash' }, location: { section: 'changes', commitId: 'c1', view: 'diff' } }

describe('session-independent inspectors', () => {
  it('opens without any session and dedupes identity while updating location/resource', () => {
    const { api } = setup()
    expect(api.openInspector(seed)).toBe(true)
    expect(api.openInspector({ ...seed, resource: { ...seed.resource, revision: 2 }, location: { section: 'summary' } })).toBe(true)
    expect(api.getInspectorSnapshot().records).toHaveLength(1)
    expect(api.getInspectorSnapshot().active?.location).toEqual({ section: 'summary' })
    expect(api.getInspectorSnapshot().active?.resource.revision).toBe(2)
  })
  it('returns false when unregistered, missing host, host refuses, or JSON is lossy', () => {
    const { api } = setup()
    expect(api.openInspector({ ...seed, type: 'missing' })).toBe(false)
    api.setInspectorSurface(undefined)
    expect(api.openInspector(seed)).toBe(false)
    api.setInspectorSurface({ reveal: () => false, close: () => {} })
    expect(api.openInspector(seed)).toBe(false)
    api.setInspectorSurface({ reveal: () => true, close: () => {} })
    expect(api.openInspector({ ...seed, resource: { bad: NaN } })).toBe(false)
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(api.openInspector({ ...seed, resource: cycle as never })).toBe(false)
    expect(api.getInspectorSnapshot().records).toEqual([])
  })
  it('cold restores exact identity/location and waits for stable type registration', () => {
    const { api, storage, descriptor } = setup()
    api.openInspector(seed)
    const restored = createInspectorApi(() => {}, storage)
    const surface = { reveal: vi.fn(() => true), close: vi.fn() }
    restored.setInspectorSurface(surface)
    expect(surface.reveal).not.toHaveBeenCalled()
    restored.registerInspector(descriptor)
    expect(surface.reveal).toHaveBeenCalledOnce()
    expect(restored.getInspectorSnapshot().active).toEqual(seed)
  })
  it('registration is HMR-safe and preserves resources while dropping stale components', () => {
    const { api } = setup()
    const descriptor = { id: 'other', title: 'Other', component: () => null }
    const dispose = api.registerInspector(descriptor)
    expect(() => api.registerInspector(descriptor)).toThrow()
    api.openInspector({ ...seed, type: 'other' })
    dispose(); dispose()
    expect(api.getInspectors().map(item => item.id)).toEqual(['plan'])
    expect(api.getInspectorSnapshot().active?.type).toBe('other')
    const next = { ...descriptor, component: () => 'new' }
    api.registerInspector(next)
    dispose()
    expect(api.getInspectors()).toContain(next)
  })
  it('close clears active resource and host selection; unknown close is a no-op', () => {
    const { api, surface } = setup()
    const listener = vi.fn(); api.subscribeInspectors(listener)
    api.openInspector(seed)
    api.closeInspector('plan', 'unknown')
    expect(listener).toHaveBeenCalledOnce()
    api.closeInspector('plan', 'p1')
    expect(api.getInspectorSnapshot()).toEqual({ records: [], active: undefined })
    expect(surface.close).toHaveBeenCalledOnce()
  })
  it('copies consumer payloads and tolerates malformed/denied storage', () => {
    const { api, values } = setup()
    const mutable = { ...seed, resource: { nested: { count: 1 } } }
    api.openInspector(mutable); mutable.resource.nested.count = 9
    expect(api.getInspectorSnapshot().active?.resource).toEqual({ nested: { count: 1 } })
    values.set(INSPECTOR_STORAGE_KEY, 'broken')
    expect(createInspectorApi(() => {}, { getItem: key => values.get(key) ?? null, setItem: () => { throw Error() } }).getInspectorSnapshot().records).toEqual([])
  })
})
