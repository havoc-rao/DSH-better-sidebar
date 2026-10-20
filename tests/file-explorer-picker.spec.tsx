// @vitest-environment jsdom
/** Exercise the public explorer seat, not a mocked tree or picker helper.
 * The v2 fixture uses the provider's real renderer (as file-tree-service does).
 * All listings belong to source.fsTrees; no filesystem mutation is supplied.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree as ProviderFileTree } from 'dsh-file-tree-ui/src/client/FileTree.tsx'
import type { FileTreeUiServiceV2 } from 'dsh-file-tree-ui/client-contract'
import { createBetterSidebarService, type FileExplorerRenderProps, type FsLevel } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { installFileTreeUiSeat } from '../src/client/file-tree-ui.ts'
import { api } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

type Picker = NonNullable<FileExplorerRenderProps['picker']>
type Interaction = Parameters<NonNullable<Picker['bind']>>[0]
type Row = { path: string; isDir: boolean }
const file = (path: string): Row => ({ path, isDir: false })
const dir = (path: string): Row => ({ path, isDir: true })
function level(path: string, rows: readonly Row[]): FsLevel {
  return { path, truncated: false, entries: rows.map(row => ({ ...row, name: row.path.split('/').pop()!, isSymlink: false, hidden: false, broken: false })) }
}
const levels = [
  level('/remote', [dir('/remote/sub'), file('/remote/alpha.ts'), file('/remote/beta.md')]),
  level('/remote/sub', [dir('/remote/sub/nested'), file('/remote/sub/deep.ts')]),
  level('/remote/sub/nested', [file('/remote/sub/nested/leaf.ts')]),
]
const disposers: (() => void)[] = []
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
  Element.prototype.scrollTo = vi.fn()
})
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  installFileTreeUiSeat(null)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function installRenderer(renderer: 'fallback' | 'fileTreeUi v2', onTreeKey?: (key: string) => void): void {
  const provider: FileTreeUiServiceV2 = {
    protocolVersion: 2,
    renderFileTree: props => { onTreeKey?.(props.treeKey); return <ProviderFileTree {...props} /> },
    renderRowMenu: () => <span />,
  }
  installFileTreeUiSeat({
    get: (key: string) => key === 'fileTreeUi' && renderer === 'fileTreeUi v2' ? provider : undefined,
    on: () => () => {},
  } as unknown as Context)
}

async function mount(overrides: Partial<FileExplorerRenderProps> = {}, pickerOverrides: Partial<Picker> = {}) {
  const service = createBetterSidebarService(createSidebarStore())
  const dispatch = vi.spyOn(service, 'dispatchFileActivation')
  const localListing = vi.spyOn(api, 'fsTrees')
  const localSearch = vi.spyOn(api, 'fsSearch')
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const onSelect = vi.fn(); const onAccept = vi.fn(); const onOpenFile = vi.fn()
  const onVisibleRowsChange = vi.fn<(rows: readonly Row[]) => void>()
  const cleanup = vi.fn()
  const handles: Interaction[] = []
  const bind = vi.fn((interaction: Interaction) => { handles.push(interaction); return cleanup })
  const fsTrees = vi.fn(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => levels.find(item => item.path === path) ?? level(path, [])) }))
  let props: FileExplorerRenderProps = {
    scope: { sessionId: 's', cwd: '/remote' }, sourceKey: 'machine-a', source: { fsTrees },
    expanded: [], onToggle: vi.fn(), onOpenFile, onReferenceFile: vi.fn(),
    picker: { query: '', onSelect, onAccept, onVisibleRowsChange, bind, ...pickerOverrides }, ...overrides,
  }
  let mounted = true
  function unmount() { if (mounted) { act(() => root.unmount()); mounted = false } }
  disposers.push(() => { unmount(); host.remove(); service.dispose() })
  async function render(patch: Partial<FileExplorerRenderProps> = {}) {
    props = { ...props, ...patch }
    await act(async () => { root.render(service.renderFileExplorer(props)) })
  }
  async function picker(patch: Partial<Picker>) { await render({ picker: { ...props.picker!, ...patch } }) }
  function row(path: string): HTMLElement {
    const label = [...host.querySelectorAll<HTMLElement>('[title]')].find(node => node.title === path)
    const result = label?.closest<HTMLElement>('[role="button"]')
    if (!result) throw new Error(`Missing explorer row: ${path}`)
    return result
  }
  function visible(): readonly Row[] { return onVisibleRowsChange.mock.calls.at(-1)?.[0] ?? [] }
  function interaction(): Interaction {
    const handle = handles.at(-1)
    if (!handle) throw new Error('picker.bind did not receive an interaction')
    return handle
  }
  await render()
  return { service, host, render, picker, row, visible, interaction, handles, bind, cleanup, unmount, dispatch, localListing, localSearch, onSelect, onAccept, onOpenFile, onVisibleRowsChange, fsTrees, props: () => props }
}

for (const renderer of ['fallback', 'fileTreeUi v2'] as const) describe(`public file explorer picker: ${renderer}`, () => {
  it('selects files without activating documents and keeps highlight controlled', async () => {
    installRenderer(renderer)
    const tree = await mount({}, { selectedPath: '/remote/alpha.ts' })
    expect(tree.service.features).toContain('fileExplorerPicker:v1')
    expect(Boolean(tree.host.querySelector('[role="tree"]'))).toBe(renderer === 'fileTreeUi v2')
    expect(tree.row('/remote/alpha.ts').className).toContain('explorerRowSelected')
    await act(async () => { tree.row('/remote/beta.md').click() })
    expect(tree.onSelect).toHaveBeenCalledExactlyOnceWith('/remote/beta.md', false)
    expect(tree.onAccept).not.toHaveBeenCalled()
    expect(tree.dispatch).not.toHaveBeenCalled()
    expect(tree.onOpenFile).not.toHaveBeenCalled()
    // A click proposes selection; the parent alone owns the highlight.
    expect(tree.row('/remote/alpha.ts').className).toContain('explorerRowSelected')
    expect(tree.row('/remote/beta.md').className).not.toContain('explorerRowSelected')
    await tree.picker({ selectedPath: '/remote/beta.md' })
    expect(tree.row('/remote/beta.md').className).toContain('explorerRowSelected')
    expect(tree.row('/remote/alpha.ts').className).not.toContain('explorerRowSelected')
    expect(tree.localListing).not.toHaveBeenCalled()
    expect(tree.localSearch).not.toHaveBeenCalled()
  })

  it('binds move/accept against the current visible order and controlled selection', async () => {
    installRenderer(renderer)
    const tree = await mount()
    const rows = tree.visible()
    expect(rows).toEqual([dir('/remote/sub'), file('/remote/alpha.ts'), file('/remote/beta.md')])
    await tree.picker({ selectedPath: rows[0]!.path })
    act(() => { tree.interaction().move(1) })
    expect(tree.onSelect).toHaveBeenLastCalledWith(rows[1]!.path, rows[1]!.isDir)
    await tree.picker({ selectedPath: rows[1]!.path })
    act(() => { tree.interaction().move(-1) })
    expect(tree.onSelect).toHaveBeenLastCalledWith(rows[0]!.path, rows[0]!.isDir)
    // Neither proposal changes controlled selectedPath until the parent renders.
    act(() => { tree.interaction().accept() })
    expect(tree.onAccept).toHaveBeenCalledExactlyOnceWith(rows[1]!.path, false)
    await tree.picker({ selectedPath: rows[0]!.path })
    act(() => { tree.interaction().accept() })
    expect(tree.onSelect).toHaveBeenLastCalledWith(rows[0]!.path, true)
    expect(tree.props().onToggle).toHaveBeenCalledExactlyOnceWith(rows[0]!.path)
    expect(tree.onAccept).toHaveBeenCalledTimes(1)
    expect(tree.dispatch).not.toHaveBeenCalled()
    expect(tree.onOpenFile).not.toHaveBeenCalled()
  })

  it('filters files by query but keeps navigable directories and reports expansion/collapse', async () => {
    installRenderer(renderer)
    const tree = await mount()
    await tree.picker({ query: 'deep' })
    expect(tree.visible()).toEqual([dir('/remote/sub')])
    expect(tree.host.textContent).not.toContain('alpha.ts')
    await act(async () => { tree.row('/remote/sub').click() })
    expect(tree.props().onToggle).toHaveBeenCalledExactlyOnceWith('/remote/sub')
    await tree.render({ expanded: ['/remote/sub'] })
    expect(tree.visible()).toEqual([dir('/remote/sub'), dir('/remote/sub/nested'), file('/remote/sub/deep.ts')])
    expect(tree.row('/remote/sub/deep.ts').textContent).toContain('deep.ts')
    await act(async () => { tree.row('/remote/sub').click() })
    expect(tree.props().onToggle).toHaveBeenCalledTimes(2)
    await tree.render({ expanded: [] })
    expect(tree.visible()).toEqual([dir('/remote/sub')])
    // The real v2 framework retains folded DOM during its exit animation.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
    expect(tree.host.textContent).not.toContain('deep.ts')
    await tree.picker({ query: '' })
    expect(tree.visible()).toEqual([dir('/remote/sub'), file('/remote/alpha.ts'), file('/remote/beta.md')])
    expect(tree.localSearch).not.toHaveBeenCalled()
  })

  it('proposes visible selection fallbacks after filtering or folding the selected descendant', async () => {
    installRenderer(renderer)
    const tree = await mount({ expanded: ['/remote/sub'] }, { selectedPath: '/remote/sub/deep.ts' })
    await tree.render({ expanded: [] })
    expect(tree.onSelect).toHaveBeenLastCalledWith('/remote/sub', true)
    await tree.picker({ selectedPath: '/remote/alpha.ts' })
    tree.onSelect.mockClear()
    await tree.picker({ query: 'missing' })
    expect(tree.visible()).toEqual([dir('/remote/sub')])
    expect(tree.onSelect).toHaveBeenCalledExactlyOnceWith('/remote/sub', true)
    expect(tree.onAccept).not.toHaveBeenCalled()
  })

  it('scrolls its own tree viewport when the controlled highlight moves outside it', async () => {
    installRenderer(renderer)
    const tree = await mount()
    // TreePanel also owns a hidden search results body; use the viewport
    // which actually contains the tree rows, not that sibling search pane.
    const body = tree.row('/remote/alpha.ts').closest<HTMLElement>('[class*="explorerBody"]')!
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 200, width: 200, height: bottom - top, x: 0, y: top, toJSON() {} })
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(rect(100, 200))
    vi.spyOn(tree.row('/remote/beta.md'), 'getBoundingClientRect').mockReturnValue(rect(230, 254))
    body.scrollTop = 20
    await tree.picker({ selectedPath: '/remote/beta.md' })
    expect(body.scrollTop).toBe(74)
    vi.spyOn(tree.row('/remote/alpha.ts'), 'getBoundingClientRect').mockReturnValue(rect(70, 94))
    await tree.picker({ selectedPath: '/remote/alpha.ts' })
    expect(body.scrollTop).toBe(44)
    expect(tree.onOpenFile).not.toHaveBeenCalled()
  })

  it('refreshes registered file icons in the mounted picker without relisting', async () => {
    installRenderer(renderer)
    const tree = await mount()
    let release!: () => void
    await act(async () => { release = tree.service.registerFileIcon({ id: 'picker-test-icon', exts: ['ts'], icon: () => <i data-picker-icon="ts" /> }) })
    expect(tree.row('/remote/alpha.ts').querySelector('[data-picker-icon="ts"]')).not.toBeNull()
    expect(tree.row('/remote/beta.md').querySelector('[data-picker-icon]')).toBeNull()
    await act(async () => { release() })
    expect(tree.row('/remote/alpha.ts').querySelector('[data-picker-icon]')).toBeNull()
    expect(tree.fsTrees).toHaveBeenCalledTimes(1)
  })

  it('ignores mutation capabilities even when the source supplies them', async () => {
    installRenderer(renderer)
    const mutate = vi.fn(async () => ({ path: '/remote/changed.ts' }))
    const fsTrees = vi.fn(async () => ({ levels: [levels[0]!] }))
    const tree = await mount({ source: { fsTrees, fsRename: mutate, fsMove: mutate, fsCopy: mutate, fsMkdir: mutate, fsCreateFile: mutate, fsRemove: mutate } })
    await act(async () => {
      tree.row('/remote/alpha.ts').click()
      tree.row('/remote/alpha.ts').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      tree.row('/remote/alpha.ts').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
      tree.row('/remote/alpha.ts').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    })
    expect(tree.row('/remote/alpha.ts').getAttribute('draggable')).not.toBe('true')
    expect(tree.host.querySelector('input:not([type="file"])')).toBeNull()
    expect(mutate).not.toHaveBeenCalled()
    expect(tree.props().source.fsRemove).not.toHaveBeenCalled()
    expect(tree.dispatch).not.toHaveBeenCalled()
  })

  it('ignores IME/repeat/nested-button keys and accepts one direct Enter without document activation', async () => {
    installRenderer(renderer)
    const tree = await mount({}, { selectedPath: '/remote/alpha.ts' })
    const row = tree.row('/remote/alpha.ts')
    const key = (target: HTMLElement, init: KeyboardEventInit = {}) => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }))
    }
    act(() => {
      key(row, { isComposing: true })
      key(row, { keyCode: 229 })
      key(row, { repeat: true })
    })
    expect(tree.onSelect).not.toHaveBeenCalled()
    expect(tree.onAccept).not.toHaveBeenCalled()
    // Simulate a consumer/provider's nested action; its bubbling Enter must
    // never activate the containing row (even if the action did not stop it).
    const button = document.createElement('button'); row.append(button)
    act(() => { key(button) })
    button.remove()
    expect(tree.onSelect).not.toHaveBeenCalled()
    expect(tree.onAccept).not.toHaveBeenCalled()
    act(() => { key(row); tree.interaction().accept() })
    expect(tree.onSelect).toHaveBeenCalledWith('/remote/alpha.ts', false)
    expect(tree.onAccept).toHaveBeenCalledExactlyOnceWith('/remote/alpha.ts', false)
    expect(tree.dispatch).not.toHaveBeenCalled()
    expect(tree.onOpenFile).not.toHaveBeenCalled()
    // A later key gesture is a new turn, not the same-frame duplicate above.
    await act(async () => { await Promise.resolve() })
    tree.onSelect.mockClear(); tree.onAccept.mockClear()
    await act(async () => { key(tree.row('/remote/sub')) })
    expect(tree.onSelect).toHaveBeenCalledExactlyOnceWith('/remote/sub', true)
    expect(tree.props().onToggle).toHaveBeenCalledExactlyOnceWith('/remote/sub')
    expect(tree.onAccept).not.toHaveBeenCalled()
  })

  it('fails closed when filtering leaves no visible rows despite a stale controlled selection', async () => {
    installRenderer(renderer)
    const source = { fsTrees: vi.fn(async () => ({ levels: [level('/remote', [file('/remote/alpha.ts')])] })) }
    const tree = await mount({ source }, { selectedPath: '/remote/alpha.ts' })
    await tree.picker({ query: 'no-match' })
    expect(tree.visible()).toEqual([])
    tree.onSelect.mockClear()
    act(() => { tree.interaction().accept(); tree.interaction().move(1) })
    expect(tree.onAccept).not.toHaveBeenCalled()
    expect(tree.onSelect).not.toHaveBeenCalled()
    expect(tree.dispatch).not.toHaveBeenCalled()
  })

  it('gives simultaneous framework trees distinct stable hover seats', async () => {
    const keys: string[] = []
    installRenderer(renderer, key => { keys.push(key) })
    const first = await mount()
    const firstKey = keys.at(-1)
    const second = await mount()
    const secondKey = keys.at(-1)
    if (renderer === 'fileTreeUi v2') {
      expect(firstKey).toBeTruthy()
      expect(secondKey).not.toBe(firstKey)
      await first.picker({ query: 'alpha' })
      expect(keys.at(-1)).toBe(firstKey)
      await second.picker({ query: 'beta' })
      expect(keys.at(-1)).toBe(secondKey)
    } else expect(keys).toEqual([])
  })

  it('cleans up bind on replacement/unmount and retires every old interaction handle', async () => {
    installRenderer(renderer)
    const tree = await mount({}, { selectedPath: '/remote/alpha.ts' })
    const old = tree.interaction()
    const replacementCleanup = vi.fn()
    let replacement: Interaction | undefined
    const replacementBind = vi.fn((handle: Interaction) => { replacement = handle; return replacementCleanup })
    await tree.picker({ bind: replacementBind })
    expect(tree.cleanup).toHaveBeenCalledTimes(1)
    expect(replacementBind).toHaveBeenCalledTimes(1)
    act(() => { old.move(1); old.accept() })
    expect(tree.onSelect).not.toHaveBeenCalled()
    expect(tree.onAccept).not.toHaveBeenCalled()
    act(() => { replacement!.accept() })
    expect(tree.onAccept).toHaveBeenCalledExactlyOnceWith('/remote/alpha.ts', false)
    tree.onSelect.mockClear(); tree.onAccept.mockClear()
    tree.unmount()
    expect(replacementCleanup).toHaveBeenCalledTimes(1)
    act(() => { replacement!.move(1); replacement!.accept(); old.accept() })
    expect(tree.onSelect).not.toHaveBeenCalled()
    expect(tree.onAccept).not.toHaveBeenCalled()
  })

  it('keeps the replacement binding live when a hidden keyed source is retired', async () => {
    installRenderer(renderer)
    let current: Interaction | undefined
    const cleanup = vi.fn()
    const bind = (handle: Interaction) => {
      current = handle
      return () => { cleanup(); if (current === handle) current = undefined }
    }
    const tree = await mount({ visible: false }, { bind, selectedPath: '/remote/alpha.ts' })
    const old = current!
    await tree.render({ sourceKey: 'replacement', visible: true })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(current).toBeDefined()
    expect(current).not.toBe(old)
    tree.onSelect.mockClear()
    act(() => { old.move(1); old.accept() })
    expect(tree.onSelect).not.toHaveBeenCalled()
    expect(tree.onAccept).not.toHaveBeenCalled()
    act(() => { current!.accept() })
    expect(tree.onAccept).toHaveBeenCalledExactlyOnceWith('/remote/alpha.ts', false)
  })

  it('isolates pending sourceKey listings, visible rows and bound handles across machine swaps', async () => {
    installRenderer(renderer)
    let settle!: (value: { levels: FsLevel[] }) => void
    const pending = vi.fn((_scope: unknown, _paths: readonly string[], _exclude?: readonly string[], _signal?: AbortSignal) => new Promise<{ levels: FsLevel[] }>(resolve => { settle = resolve }))
    const tree = await mount({ source: { fsTrees: pending } }, { selectedPath: '/remote/alpha.ts' })
    const old = tree.interaction()
    const signal = pending.mock.calls[0]?.[3]
    const current = vi.fn(async () => ({ levels: [level('/remote', [file('/remote/current.ts')])] }))
    await tree.render({ sourceKey: 'machine-b', source: { fsTrees: current } })
    await tree.picker({ selectedPath: '/remote/current.ts' })
    expect(signal?.aborted).toBe(true)
    expect(tree.visible()).toEqual([file('/remote/current.ts')])
    expect(tree.cleanup).toHaveBeenCalledTimes(1)
    tree.onSelect.mockClear(); tree.onAccept.mockClear()
    act(() => { old.move(1); old.accept() })
    expect(tree.onSelect).not.toHaveBeenCalled()
    expect(tree.onAccept).not.toHaveBeenCalled()
    const notifications = tree.onVisibleRowsChange.mock.calls.length
    await act(async () => { settle({ levels: [level('/remote', [file('/remote/stale.ts')])] }) })
    expect(tree.host.textContent).toContain('current.ts')
    expect(tree.host.textContent).not.toContain('stale.ts')
    expect(tree.visible()).toEqual([file('/remote/current.ts')])
    expect(tree.onVisibleRowsChange).toHaveBeenCalledTimes(notifications)
    act(() => { tree.interaction().accept() })
    expect(tree.onAccept).toHaveBeenCalledExactlyOnceWith('/remote/current.ts', false)
    expect(tree.dispatch).not.toHaveBeenCalled()
    expect(tree.onOpenFile).not.toHaveBeenCalled()
  })
})
