// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DiffPane, type ChangesPreview } from '../src/client/changes/DiffPane.tsx'
import { createResourceActionRegistry } from '../src/client/resource-actions.ts'
import type { BetterSidebarService } from '../src/client/service.ts'
import type { SessionScope } from '../src/client/api.ts'
import css from '../src/client/changes/changes.module.css'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

vi.mock('../src/client/diff/use-git-diff.ts', () => ({
  useGitDiffTarget: () => ({ loading: false, error: null, diffText: '', refresh: () => {}, resolveFold: () => {} }),
}))
const scope: SessionScope = { sessionId: 'preview', cwd: '/repo' }
const git: ChangesPreview = { kind: 'git', ref: { kind: 'worktree', path: 'a.ts', staged: false } }
function op(path: string): ChangesPreview {
  return { kind: 'op', path, op: { callId: path, kind: 'write', path, time: 1, running: false, isError: false, content: 'body' } }
}
function registryService() {
  const listeners = new Set<() => void>()
  const registry = createResourceActionRegistry(() => { for (const listener of listeners) listener() })
  const service = { ...registry, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } } as unknown as BetterSidebarService
  return { registry, service }
}
let root: Root | undefined
let container: HTMLDivElement
async function render(target: ChangesPreview, service?: BetterSidebarService, currentScope = scope) {
  if (!root) {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  }
  await act(async () => { root!.render(createElement(DiffPane, {
    target, service, scope: currentScope, height: 300, onHeightCommit: () => {}, onClose: () => {}, onExpand: () => {},
  })) })
}
afterEach(() => { act(() => root?.unmount()); root = undefined; container?.remove() })
function button(label: string) { return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)! }

describe('DiffPane resource actions in the preview header', () => {
  it('renders a single git action in diffHead and invokes the latest target and scope', async () => {
    const { registry, service } = registryService()
    const run = vi.fn()
    registry.registerResourceAction({ id: 'git', label: 'Git edit box', surfaces: ['git-preview-toolbar'], run })
    await render(git, service)
    expect(container.querySelectorAll('button[aria-label="Git edit box"]')).toHaveLength(1)
    expect(button('Git edit box').parentElement?.classList.contains(css.diffHead!)).toBe(true)
    const next: ChangesPreview = { kind: 'git', ref: { kind: 'worktree', path: 'b.ts', staged: true, worktree: '/linked' } }
    const nextScope = { sessionId: 'other', cwd: '/other', repoRoot: '/linked' }
    await render(next, service, nextScope)
    await act(async () => { button('Git edit box').click() })
    expect(run.mock.calls[0]?.[0]).toEqual({ kind: 'git-diff', surface: 'git-preview-toolbar', scope: nextScope, ref: next.ref })
  })

  it('resolves op files and reads the latest document state at click time', async () => {
    const { registry, service } = registryService()
    const run = vi.fn()
    registry.registerResourceAction({ id: 'file', label: 'File edit box', surfaces: ['file-viewer-toolbar'], run })
    await render(op('a.ts'), service)
    expect(button('File edit box').parentElement?.classList.contains(css.diffHead!)).toBe(true)
    await act(async () => { button('File edit box').click() })
    expect(run.mock.calls[0]?.[0]).toEqual({ kind: 'file', surface: 'file-viewer-toolbar', scope, absolutePath: '/repo/a.ts', isDirectory: false, dirty: false, readOnly: false })
    const nextScope = { sessionId: 'other', cwd: '/other' }
    await render(op('b.ts'), service, nextScope)
    const currentButton = button('File edit box')
    await act(async () => {
      registry.setFileDocumentState('editor', nextScope, '/other/b.ts', { dirty: true, readOnly: true })
      currentButton.click()
    })
    expect(run.mock.calls[1]?.[0]).toEqual({ kind: 'file', surface: 'file-viewer-toolbar', scope: nextScope, absolutePath: '/other/b.ts', isDirectory: false, dirty: true, readOnly: true })
    expect(container.querySelectorAll('button[aria-label="File edit box"]')).toHaveLength(1)
  })

  it('rechecks consumer availability when a clean preview becomes dirty before click', async () => {
    const { registry, service } = registryService()
    const run = vi.fn()
    registry.registerResourceAction({ id: 'clean', label: 'Clean only', surfaces: ['file-viewer-toolbar'], available: context => context.kind === 'file' && context.dirty === false && !context.readOnly, run })
    await render(op('/absolute/a.ts'), service, { sessionId: 'preview' })
    const currentButton = button('Clean only')
    await act(async () => {
      registry.setFileDocumentState('editor', scope, '/absolute/a.ts', { dirty: true, readOnly: false })
      currentButton.click()
    })
    expect(run).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('unavailable')
  })

  it('omits actions without a service or a resolvable absolute file path', async () => {
    await render(git)
    expect(button('Git edit box')).toBeNull()
    await render(op('a.ts'))
    expect(button('File edit box')).toBeNull()
    const { registry, service } = registryService()
    const available = vi.fn(() => true)
    registry.registerResourceAction({ id: 'file', label: 'File edit box', surfaces: ['file-viewer-toolbar'], available, run: () => {} })
    await render(op('a.ts'), service, { sessionId: 'preview' })
    expect(button('File edit box')).toBeNull()
    expect(available).not.toHaveBeenCalled()
  })

  it.each(['C:\\repo\\a.ts', '\\\\server\\share\\a.ts'])('preserves absolute Windows file path %s', async path => {
    const { registry, service } = registryService()
    const run = vi.fn()
    registry.registerResourceAction({ id: 'file', label: 'File edit box', surfaces: ['file-viewer-toolbar'], run })
    await render(op(path), service)
    await act(async () => { button('File edit box').click() })
    expect(run.mock.calls[0]?.[0]).toMatchObject({ absolutePath: path })
  })
})
