// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createBetterSidebarService, type FileExplorerRenderProps, type FsLevel, type FileActivationContext } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { api } from '../src/client/api.ts'
import { strictExplorerApi } from '../src/client/file-explorer.tsx'
import { setupReactAct } from './test-utils.ts'
setupReactAct()
const level = (path: string, name: string): FsLevel => ({ path, truncated: false, entries: [{ path: `${path}/${name}`, name, isDir: false, isSymlink: false, hidden: false, broken: false }] })

describe('public strict file explorer', () => {
  it('uses the actual explorer toolbar/tree with no local list/search/git/watch and fences machine swaps', async () => {
    const list = vi.spyOn(api, 'fsTrees')
    const search = vi.spyOn(api, 'fsSearch')
    const git = vi.spyOn(api, 'gitStatus')
    const socket = vi.spyOn(globalThis, 'WebSocket')
    const service = createBetterSidebarService(createSidebarStore())
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    let settle!: (value: { levels: FsLevel[] }) => void
    const remote = vi.fn((_scope: unknown, _paths: readonly string[], _exclude?: readonly string[], _signal?: AbortSignal) => new Promise<{ levels: FsLevel[] }>(resolve => { settle = resolve }))
    const open = vi.fn(); const reference = vi.fn()
    const props: FileExplorerRenderProps = { scope: { sessionId: 's', cwd: '/remote' }, sourceKey: 'machine1', source: { fsTrees: remote }, expanded: [], onToggle: vi.fn(), onOpenFile: open, onReferenceFile: reference }
    await act(async () => { root.render(service.renderFileExplorer(props)) })
    const oldSignal = remote.mock.calls[0]?.[3] as AbortSignal | undefined
    expect(host.querySelector('input:not([type])')?.hasAttribute('disabled')).toBe(true)
    await act(async () => { root.render(service.renderFileExplorer({ ...props, sourceKey: 'machine2', source: { fsTrees: async () => ({ levels: [level('/remote', 'current.ts')] }) } })) })
    await act(async () => { settle({ levels: [level('/remote', 'stale.ts')] }) })
    expect(host.textContent).toContain('current.ts')
    expect(host.textContent).not.toContain('stale.ts')
    expect(oldSignal?.aborted).toBe(true)
    const row = host.querySelector<HTMLElement>('[role="button"][title="/remote/current.ts"]')!
    expect(row).not.toBeNull()
    await act(async () => { row.click() })
    expect(open).toHaveBeenCalledWith('/remote/current.ts')
    await act(async () => { row.querySelector<HTMLButtonElement>('button')!.click() })
    expect(reference).toHaveBeenCalledWith('/remote/current.ts', false)
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })) })
    const menuLabels = [...document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent)
    expect(menuLabels.join(' ')).not.toMatch(/Rename|Delete|Download|重命名|删除|下载/)
    expect(list).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled(); expect(git).not.toHaveBeenCalled(); expect(socket).not.toHaveBeenCalled()
    expect(service.features).toContain('fileExplorer:v1')
    await act(async () => { root.unmount() }); host.remove(); service.dispose(); vi.restoreAllMocks()
  })
  it.each(['handled', 'declined'] as const)('keeps remote listing paths but uses mirror document authority (%s)', async result => {
    const service = createBetterSidebarService(createSidebarStore())
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const scope = { sessionId: 's', cwd: '/remote' }
    const activationScope = { sessionId: 's', cwd: '/local/mirror' }
    const remote = vi.fn(async (_scope: FileExplorerRenderProps['scope']) => ({ levels: [level('/remote', '.gitignore')] }))
    const open = vi.fn()
    const state = vi.spyOn(service, 'getFileDocumentState').mockReturnValue({ dirty: true, readOnly: true })
    let finish!: (result: 'handled' | 'declined') => void
    const target = vi.fn((_context: FileActivationContext) => new Promise<'handled' | 'declined'>(resolve => { finish = resolve }))
    service.registerFileOpenTarget({ id: 'deferred', priority: 1, accept: () => true, open: target })
    try {
      await act(async () => { root.render(service.renderFileExplorer({ scope, activationScope, sourceKey: 'machine', source: { fsTrees: remote }, expanded: [], onToggle: vi.fn(), onOpenFile: open, onReferenceFile: vi.fn() })) })
      expect(remote.mock.calls[0]?.[0]).toEqual(scope)
      const row = host.querySelector<HTMLElement>('[role="button"][title="/remote/.gitignore"]')!
      await act(async () => { row.click() })
      expect(target.mock.calls[0]?.[0]).toMatchObject({ scope: activationScope, absolutePath: '/remote/.gitignore', dirty: true, readOnly: true })
      expect(state).toHaveBeenCalledWith(activationScope, '/remote/.gitignore')
      expect(open).not.toHaveBeenCalled()
      await act(async () => { finish(result) })
      if (result === 'declined') expect(open).toHaveBeenCalledExactlyOnceWith('/remote/.gitignore')
      else expect(open).not.toHaveBeenCalled()
    } finally { await act(async () => { root.unmount() }); host.remove(); service.dispose(); vi.restoreAllMocks() }
  })

  it.each(['scope', 'roundtrip', 'unmount'] as const)('fences deferred activation after %s without invoking another target or fallback', async change => {
    const service = createBetterSidebarService(createSidebarStore())
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    let finish!: (result: 'declined') => void
    const next = vi.fn(() => 'handled' as const)
    service.registerFileOpenTarget({ id: 'deferred', priority: 1, accept: () => true, open: () => new Promise<'declined'>(resolve => { finish = resolve }) })
    // Scope case exercises the next target's readContext fence; roundtrip and
    // unmount leave no next target, exercising the post-dispatch fallback fence.
    if (change === 'scope') service.registerFileOpenTarget({ id: 'next', priority: 2, accept: () => true, open: next })
    const open = vi.fn()
    const source = { fsTrees: vi.fn(async () => ({ levels: [level('/remote', '.gitignore')] })) }
    const props: FileExplorerRenderProps = { scope: { sessionId: 's', cwd: '/remote' }, activationScope: { sessionId: 's', cwd: '/mirror/a' }, sourceKey: 'machine', source, expanded: [], onToggle: vi.fn(), onOpenFile: open, onReferenceFile: vi.fn() }
    try {
      await act(async () => { root.render(service.renderFileExplorer(props)) })
      await act(async () => { host.querySelector<HTMLElement>('[role="button"][title="/remote/.gitignore"]')!.click() })
      if (change === 'unmount') await act(async () => { root.unmount() })
      else {
        await act(async () => { root.render(service.renderFileExplorer({ ...props, activationScope: { sessionId: 's', cwd: '/mirror/b' } })) })
        if (change === 'roundtrip') await act(async () => { root.render(service.renderFileExplorer(props)) })
        expect(source.fsTrees).toHaveBeenCalledTimes(1)
      }
      await act(async () => { finish('declined') })
      expect(next).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      expect(host.textContent).not.toContain('File activation scope changed')
    } finally { if (change !== 'unmount') await act(async () => { root.unmount() }); host.remove(); service.dispose() }
  })

  it('rejects missing operations and late mutation results, never falls back to local api', async () => {
    const remove = vi.spyOn(api, 'fsRemove')
    const controller = new AbortController()
    let finish!: (value: { path: string }) => void
    const strict = strictExplorerApi({ fsTrees: async () => ({ levels: [] }), fsRename: async () => new Promise(resolve => { finish = resolve }) }, controller.signal)
    await expect(strict.fsRemove({ sessionId: 's' }, '/remote/a')).rejects.toThrow('unavailable')
    const pending = strict.fsRename({ sessionId: 's' }, '/remote/a', 'b')
    controller.abort(); finish({ path: '/remote/b' })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(remove).not.toHaveBeenCalled(); vi.restoreAllMocks()
  })
})
