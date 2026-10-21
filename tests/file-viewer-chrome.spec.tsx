// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createBetterSidebarService, type ResourceActionContext } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

describe('controlled public file viewer chrome', () => {
  it('renders owned slots and updates icons without IO or claiming document ownership', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    const read = vi.spyOn(service, 'readText')
    const report = vi.spyOn(service, 'reportFileDocument')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const action = vi.fn()
    const scope = { sessionId: 'remote', cwd: '/remote' }
    let state = { dirty: false, readOnly: true }
    service.registerResourceAction({ id: 'test', label: 'Resource', surfaces: ['file-viewer-toolbar'], run: action })
    const render = () => service.renderFileViewer({ scope, path: '/remote/a.ts',
      content: createElement('textarea', { defaultValue: 'draft' }),
      actions: createElement('button', {}, 'Download'), status: 'Remote read-only', documentState: state,
    })
    await act(async () => { root.render(render()) })
    expect(service.features).toContain('fileViewerChrome:v1')
    expect(host.textContent).toContain('a.ts')
    expect(host.textContent).toContain('/remote/a.ts')
    expect(host.textContent).toContain('Remote read-only')
    const content = host.querySelector('textarea')!
    content.value = 'unsaved'
    await act(async () => { service.registerFileIcon({ id: 'ts', exts: ['ts'], icon: () => createElement('i', { 'data-custom-icon': '' }) }) })
    expect(host.querySelector('[data-custom-icon]')).not.toBeNull()
    expect(host.querySelector('textarea')).toBe(content)
    expect(content.value).toBe('unsaved')
    state = { dirty: true, readOnly: false }
    await act(async () => { root.render(render()) })
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Resource"]')!.click() })
    expect(action.mock.calls[0]![0]).toMatchObject({ absolutePath: '/remote/a.ts', dirty: true, readOnly: false, scope })
    expect(read).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
    host.remove()
    service.dispose()
  })
  it('defaults to safe unknown/read-only action state and can omit resource actions', async () => {
    const service = createBetterSidebarService(createSidebarStore())
    const seen = vi.fn((_context: ResourceActionContext) => true)
    service.registerResourceAction({ id: 'test', label: 'Resource', surfaces: ['file-viewer-toolbar'], available: seen, run: () => {} })
    const host = document.createElement('div')
    const root = createRoot(host)
    const props = { scope: { sessionId: 's' }, path: '/a', content: 'Loading' }
    await act(async () => { root.render(service.renderFileViewer(props)) })
    expect(seen.mock.calls[0]![0]).toMatchObject({ dirty: 'unknown', readOnly: true })
    await act(async () => { root.render(service.renderFileViewer({ ...props, showResourceActions: false })) })
    expect(host.querySelector('button')).toBeNull()
    await act(async () => { root.unmount() })
    service.dispose()
  })
})
