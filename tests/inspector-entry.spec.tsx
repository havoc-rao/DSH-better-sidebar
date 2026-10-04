// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
import { InspectorHost } from '../src/client/InspectorHost.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
setupReactAct()

describe('inspector panel entries', () => {
  it('opens an empty resource without a session from the panel entry', async () => {
    localStorage.clear()
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.setInspectorSurface({ reveal: () => true, close: () => {} })
    service.registerInspector({ id: 'dsh-gca-plans', title: 'Recent commit plans', entry: true,
      component: ({ resource, visible }) => createElement('div', { 'data-testid': 'plans' }, `${visible}:${JSON.stringify(resource)}`) })
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => { root.render(createElement(InspectorHost, { service, visible: true })) })
      expect(container.querySelector('[data-dsh-inspector-entries]')).toBeNull()
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === 'Recent commit plans')!
      await act(async () => { button.click() })
      expect(service.getInspectorSnapshot().active).toMatchObject({ type: 'dsh-gca-plans', id: 'dsh-gca-plans', resource: {} })
      expect(store.getSnapshot().sessionId).toBeUndefined()
      expect(container.querySelector('[data-testid="plans"]')?.textContent).toBe('true:{}')
    } finally { await act(async () => root.unmount()); container.remove(); localStorage.clear() }
  })
  it('updates panel entries when descriptors register or unload', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    const container = document.createElement('div'); const root = createRoot(container)
    try {
      await act(async () => { root.render(createElement(InspectorHost, { service, visible: true })) })
      let dispose = () => {}
      await act(async () => { dispose = service.registerInspector({ id: 'late', title: 'Late', entry: true, component: () => null }) })
      expect(container.querySelector('button')?.textContent).toBe('Late')
      await act(async () => { dispose() })
      expect(container.querySelector('button')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
})
