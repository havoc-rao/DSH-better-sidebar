import './browser-globals.ts'
import { describe, expect, it, vi } from 'vitest'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

const scope = { sessionId: 'central-session', cwd: '/workspace' }

describe('central editor service controller', () => {
  it('returns false without capability and does not open another surface', () => {
    const store = createSidebarStore()
    store.setSession(scope.sessionId)
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Editor', component: () => null })
    const before = store.getSnapshot()
    expect(service.features).toContain('centralEditor')
    expect(service.openCentralFile(scope, '/workspace/file.ts')).toBe(false)
    expect(service.isCentralEditorActive(scope.sessionId)).toBe(false)
    expect(store.getSnapshot()).toBe(before)
  })

  it('delegates exact scope/path and propagates controller refusal', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const controller = {
      openFile: vi.fn(() => true),
      isActive: vi.fn((id: string) => id === scope.sessionId),
    }
    service.setCentralEditor(controller)
    expect(service.openCentralFile(scope, '/workspace/file.ts')).toBe(true)
    expect(controller.openFile).toHaveBeenCalledWith(scope, '/workspace/file.ts')
    expect(service.isCentralEditorActive(scope.sessionId)).toBe(true)
    expect(service.isCentralEditorActive('other-session')).toBe(false)
    controller.openFile.mockReturnValue(false)
    expect(service.openCentralFile(scope, '/workspace/refused.ts')).toBe(false)
  })

  it('replaces the controller and stops invoking it after unload', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const old = { openFile: vi.fn(() => true), isActive: vi.fn(() => true) }
    const next = { openFile: vi.fn(() => false), isActive: vi.fn(() => false) }
    service.setCentralEditor(old)
    service.setCentralEditor(next)
    expect(service.openCentralFile(scope, 'file.ts')).toBe(false)
    expect(service.isCentralEditorActive(scope.sessionId)).toBe(false)
    expect(old.openFile).not.toHaveBeenCalled()
    expect(old.isActive).not.toHaveBeenCalled()
    service.setCentralEditor(undefined)
    next.openFile.mockClear()
    next.isActive.mockClear()
    expect(service.openCentralFile(scope, 'file.ts')).toBe(false)
    expect(service.isCentralEditorActive(scope.sessionId)).toBe(false)
    expect(next.openFile).not.toHaveBeenCalled()
    expect(next.isActive).not.toHaveBeenCalled()
  })

  it('does not redirect the old openFile path even with a controller installed', () => {
    const store = createSidebarStore()
    store.setSession(scope.sessionId)
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'editor', title: 'Editor', component: () => null })
    const controller = { openFile: vi.fn(() => true), isActive: vi.fn(() => true) }
    service.setCentralEditor(controller)
    service.openFile(scope, '/workspace/file.ts')
    expect(controller.openFile).not.toHaveBeenCalled()
    expect(store.tabOpen(scope.sessionId, 'editor:/workspace/file.ts')).toBe(true)
  })
})
