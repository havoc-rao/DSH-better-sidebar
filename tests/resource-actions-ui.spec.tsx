// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useLayoutEffect } from 'react'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ResourceActions } from '../src/client/ResourceActions.tsx'
import { FileTree } from '../src/client/FileTree.tsx'
import { createResourceActionRegistry, type ResourceActionContext } from '../src/client/resource-actions.ts'
import type { BetterSidebarService, FileViewerProps } from '../src/client/service.ts'
import { setupReactAct } from './test-utils.ts'
setupReactAct()
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: async (_scope: unknown, paths: string[]) => ({ levels: paths.map(path => ({ path, entries: [
      { name: 'a.ts', path: '/tmp/a.ts', isDir: false }, { name: 'dir', path: '/tmp/dir', isDir: true },
    ], truncated: false })) }),
    gitStatus: async () => ({ isRepo: false, entries: [] }),
    fsRead: async () => ({ kind: 'text', content: 'clean document', truncated: false }),
  }, downloadUrl: () => '/file', mediaUrl: () => '/file', isOutsideWorkspaceMessage: () => false,
}))
const scope = { sessionId: 'actions-ui', cwd: '/tmp' }
function registryService() {
  const listeners = new Set<() => void>()
  const registry = createResourceActionRegistry(() => { for (const listener of listeners) listener() })
  const service = { ...registry, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, fileIcon: () => null, folderIcon: () => null } as unknown as BetterSidebarService
  return { registry, service }
}
function context(service: BetterSidebarService): ResourceActionContext {
  return { kind: 'file', surface: 'file-viewer-toolbar', scope, absolutePath: '/tmp/a.ts', isDirectory: false,
    ...service.getFileDocumentState(scope, '/tmp/a.ts') }
}
let root: Root | undefined
let container: HTMLDivElement
async function mount(element: ReturnType<typeof createElement>) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(element) })
}
afterEach(() => { act(() => root?.unmount()); root = undefined; container?.remove() })
async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
function actionButton(name: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
    ?? [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)
  if (!button) throw new Error(`Missing button: ${name}`)
  return button
}

describe('shared resource toolbar', () => {
  it('subscribes to actual registry registrations and unregistrations; icon optional', async () => {
    const { registry, service } = registryService()
    await mount(createElement(ResourceActions, { service, readContext: () => context(service) }))
    expect(container.textContent).toBe('')
    let unregister!: () => void
    act(() => { unregister = registry.registerResourceAction({ id: 'one', label: 'One', surfaces: ['file-viewer-toolbar'], run: () => {} }) })
    expect(actionButton('One').textContent).toBe('One')
    act(unregister)
    expect(container.textContent).toBe('')
  })
  it('rechecks dirty state at invocation, not render time', async () => {
    const { registry, service } = registryService()
    const run = vi.fn()
    registry.registerResourceAction({ id: 'clean', label: 'Clean', surfaces: ['file-viewer-toolbar'], available: ctx => ctx.kind === 'file' && ctx.dirty === false, run })
    await mount(createElement(ResourceActions, { service, readContext: () => context(service) }))
    const button = actionButton('Clean')
    // Synchronous notification has not yet committed a render when the click lands.
    await act(async () => {
      registry.setFileDocumentState('editor', scope, '/tmp/a.ts', { dirty: true, readOnly: false })
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(run).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('unavailable')
  })
  it('contains available exceptions and shows run failures; abort is silent', async () => {
    const { registry, service } = registryService()
    const unregister = registry.registerResourceAction({ id: 'bad', label: 'Bad', surfaces: ['file-viewer-toolbar'], available: () => { throw new Error('available failed') }, run: () => {} })
    await mount(createElement(ResourceActions, { service, readContext: () => context(service) }))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('available failed')
    act(() => { unregister(); registry.registerResourceAction({ id: 'run', label: 'Run', surfaces: ['file-viewer-toolbar'], run: () => { throw new Error('run failed') } }) })
    await click(actionButton('Run'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('run failed')
    act(() => { registry.registerResourceAction({ id: 'abort', label: 'Abort', surfaces: ['file-viewer-toolbar'], run: () => { throw new DOMException('cancelled', 'AbortError') } }) })
    await click(actionButton('Abort'))
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
  it('old fake services and no providers render nothing without errors', async () => {
    await mount(createElement(ResourceActions, { service: {} as BetterSidebarService, readContext: () => { throw new Error('should not be read') } }))
    expect(container.textContent).toBe('')
  })
})

async function mountTree(service: BetterSidebarService, onOpenFile = vi.fn()) {
  await mount(createElement(FileTree, { service, ...scope, expanded: [], revealed: [], onToggle: () => {}, onOpenFile,
    onReferenceFile: () => {}, refreshTick: 0, onUploadRequest: () => {}, busy: false }))
  const row = () => [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(el => el.title === '/tmp/a.ts')!
  return { onOpenFile, row }
}
describe('EditorHost document reporting', () => {
  it('reports actual editable state, scopes owners, and does not erase another mounted owner on cleanup', async () => {
    const { registry, service } = registryService()
    const store = createSidebarStore()
    const ctx = { get: (key: string) => key === 'betterSidebar' ? service : undefined } as unknown as Context
    function Viewer(props: FileViewerProps) {
      useLayoutEffect(() => {
        props.onToolbarState?.({ modes: false, mode: 'edit', dirty: props.title === 'dirty', editable: true, saveState: 'idle' })
      }, [props.onToolbarState, props.title])
      return null
    }
    service.matchFileViewer = () => ({ id: 'stub', exts: [], fetchStrategy: 'none', component: Viewer })
    const host = (id: string, title: string, sessionId = scope.sessionId) => createElement(EditorHost, {
      key: id, ctx, store, scope: { ...scope, sessionId }, tab: { id, title, path: '/tmp/a.ts', type: 'editor' },
      expanded: [], revealed: [], onToggleDir: () => {}, onReferenceFile: () => {},
    })
    await mount(createElement('div', null, host('a', 'dirty'), host('b', 'clean')))
    expect(registry.getFileDocumentState(scope, '/tmp/a.ts')).toEqual({ dirty: true, readOnly: false })
    await act(async () => { root!.render(createElement('div', null, host('b', 'clean'))) })
    expect(registry.getFileDocumentState(scope, '/tmp/a.ts')).toEqual({ dirty: false, readOnly: false })
    await act(async () => { root!.render(createElement('div', null, host('b', 'dirty', 'other'))) })
    expect(registry.getFileDocumentState(scope, '/tmp/a.ts')).toEqual({ dirty: false, readOnly: false })
    expect(registry.getFileDocumentState({ sessionId: 'other' }, '/tmp/a.ts')).toEqual({ dirty: true, readOnly: false })
  })
  it('actual TextEditor re-reports a clean merged file switch and manual refresh', async () => {
    const { registry, service } = registryService()
    const store = createSidebarStore()
    service.matchFileViewer = () => ({ id: 'markdown', exts: [], fetchStrategy: 'fsRead', component: TextEditor })
    const ctx = { get: (key: string) => key === 'betterSidebar' ? service : undefined } as unknown as Context
    const render = (path: string) => createElement(EditorHost, { ctx, store, scope,
      tab: { id: 'merged', title: 'Clean', path, type: 'editor' }, expanded: [], revealed: [], onToggleDir: () => {}, onReferenceFile: () => {} })
    await mount(render('/tmp/a.md'))
    expect(registry.getFileDocumentState(scope, '/tmp/a.md')).toEqual({ dirty: false, readOnly: false })
    await act(async () => { root!.render(render('/tmp/b.md')) })
    expect(registry.getFileDocumentState(scope, '/tmp/b.md')).toEqual({ dirty: false, readOnly: false })
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')
      ?? [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.querySelector('svg') && /refresh/i.test(button.title))
    if (!refresh) throw new Error('Refresh action absent')
    await click(refresh)
    expect(registry.getFileDocumentState(scope, '/tmp/b.md')).toEqual({ dirty: false, readOnly: false })
  })
  it('custom viewers without toolbar reports remain unknown and readonly', async () => {
    const { registry, service } = registryService()
    service.matchFileViewer = () => ({ id: 'custom', exts: [], fetchStrategy: 'none', component: () => null })
    const ctx = { get: (key: string) => key === 'betterSidebar' ? service : undefined } as unknown as Context
    await mount(createElement(EditorHost, { ctx, store: createSidebarStore(), scope,
      tab: { id: 'custom', title: 'Custom', path: '/tmp/a.ts', type: 'editor' }, expanded: [], revealed: [], onToggleDir: () => {}, onReferenceFile: () => {} }))
    expect(registry.getFileDocumentState(scope, '/tmp/a.ts')).toEqual({ dirty: 'unknown', readOnly: true })
  })
})

describe('FileTree resource interactions', () => {
  it.each(['failure', 'abort'] as const)('accepted target %s never falls back', async kind => {
    const { registry, service } = registryService()
    registry.registerFileOpenTarget({ id: 'target', priority: 1, accept: () => true, open: () => { throw kind === 'abort' ? new DOMException('cancelled', 'AbortError') : new Error('target failed') } })
    const { row, onOpenFile } = await mountTree(service)
    await click(row())
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(container.textContent?.includes('target failed')).toBe(kind === 'failure')
  })
  it('declined target falls back, modifiers never dispatch', async () => {
    const { registry, service } = registryService()
    const open = vi.fn(() => 'declined' as const)
    registry.registerFileOpenTarget({ id: 'decline', priority: 1, accept: () => true, open })
    const { row, onOpenFile } = await mountTree(service)
    await act(async () => { row().dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })) })
    expect(open).not.toHaveBeenCalled()
    await click(row())
    expect(onOpenFile).toHaveBeenCalledWith('/tmp/a.ts')
  })
  it('does not dispatch the next target or fallback after a deferred decline crosses sessions', async () => {
    const { registry, service } = registryService()
    let decline!: (result: 'declined') => void
    registry.registerFileOpenTarget({ id: 'slow', priority: 1, accept: () => true, open: () => new Promise(resolve => { decline = resolve }) })
    const next = vi.fn(() => 'handled' as const)
    registry.registerFileOpenTarget({ id: 'next', priority: 2, accept: () => true, open: next })
    const { row, onOpenFile } = await mountTree(service)
    await click(row())
    await act(async () => {
      root!.render(createElement(FileTree, { service, sessionId: 'new-session', cwd: '/other', expanded: [], revealed: [], onToggle: () => {}, onOpenFile,
        onReferenceFile: () => {}, refreshTick: 0, onUploadRequest: () => {}, busy: false }))
    })
    await act(async () => { decline('declined') })
    expect(next).not.toHaveBeenCalled()
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('scope changed')
  })
  it('adds files-only descriptor menu entries and rechecks latest document state', async () => {
    const { registry, service } = registryService()
    const run = vi.fn()
    const unregister = registry.registerResourceAction({ id: 'custom', label: 'Custom Action', surfaces: ['file-tree-context'], run })
    const { row } = await mountTree(service)
    await act(async () => { row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const button = actionButton('Custom Action')
    await act(async () => {
      registry.setFileDocumentState('owner', scope, '/tmp/a.ts', { dirty: true, readOnly: true })
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(run.mock.calls[0]?.[0]).toMatchObject({ dirty: true, readOnly: true, scope, absolutePath: '/tmp/a.ts' })
    await act(async () => { row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    act(unregister)
    expect(document.body.textContent).not.toContain('Custom Action')
    const dir = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(el => el.querySelector('[class*="explorerName"]')?.textContent === 'dir')!
    await act(async () => { dir.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(document.body.textContent).not.toContain('Custom Action')
  })
})
