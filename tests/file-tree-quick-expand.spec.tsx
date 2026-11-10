/**
 * User-initiated directory expansion follows actual singleton-directory listings,
 * including later asynchronous arrivals. Files count as entries, and terminal
 * listings (empty/file/multiple/error/truncated) end the gesture. Safety valves
 * shared with compact folding bound the walk: a symlink child (including a
 * self-referential one) is never followed and the chain stops at
 * MAX_COMPACT_DEPTH. Controlled expansion is fed back by a React parent, just as
 * in the mounted explorer. Restored expansion, refreshes and watch updates must
 * not start a new gesture; collapsing the chain (or below it) cancels a pending
 * one and closing an unrelated folder keeps it, while two overlapping gestures
 * finish independently. Both fallback activation and the optional File UI
 * row/chevron contract obey this, without moving picker selection to any of the
 * automatically opened descendants.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, isValidElement, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { FileTreeNode, FileTreeProps, FileTreeUiServiceV2 } from 'dsh-file-tree-ui/client-contract'
import { FileTree } from '../src/client/FileTree.tsx'
import { MAX_COMPACT_DEPTH } from '../src/client/file-tree-compact.ts'
import type { FileExplorerPicker, FsEntry, FsLevel } from '../src/client/file-explorer.tsx'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

const { fsTrees, uiSeat } = vi.hoisted(() => ({ fsTrees: vi.fn(), uiSeat: { value: undefined as FileTreeUiServiceV2 | undefined } }))
vi.mock('../src/client/api.ts', () => ({
  api: { fsTrees, gitStatus: async () => ({ isRepo: false, entries: [] }) },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))
vi.mock('../src/client/file-tree-ui.ts', () => ({ useFileTreeUi: () => uiSeat.value }))

/** Render only the provider's public interaction contract, not its animations. */
function providerNodes(nodes: readonly FileTreeNode[]): ReactNode {
  return nodes.map((node, index) => {
    if (node === null || typeof node !== 'object' || isValidElement(node)) return createElement('div', { key: index }, node as ReactNode)
    const row = node as Exclude<FileTreeNode, ReactNode>
    return createElement('div', { key: row.key },
      createElement('div', { role: row.role, onClick: row.onClick }, row.label),
      row.onToggle === undefined ? null : createElement('button', { 'aria-label': `Toggle ${row.key}`, onClick: row.onToggle }, 'Toggle'),
      row.expanded === false ? null : providerNodes(row.children ?? []))
  })
}
const provider: FileTreeUiServiceV2 = {
  protocolVersion: 2,
  renderFileTree: (props: FileTreeProps) => createElement('div', null, providerNodes(props.rows)),
  renderRowMenu: () => createElement('span'),
}

type Mode = 'fallback row' | 'File UI row' | 'File UI chevron'
const A = '/tmp/a'; const B = `${A}/b`; const C = `${B}/c`
const dir = (path: string): FsEntry => ({ path, name: path.split('/').pop()!, isDir: true, hidden: false, isSymlink: false, broken: false })
const file = (path: string): FsEntry => ({ ...dir(path), isDir: false })
const level = (path: string, entries: FsEntry[], extra: Partial<FsLevel> = {}): FsLevel => ({ path, entries, truncated: false, ...extra })
let levels: Map<string, FsLevel>
let pending: Map<string, Promise<FsLevel>>
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { FakeSocket.instances.push(this) }
  send(): void {}
  close(): void { this.readyState = 3 }
  open(): void { this.readyState = 1; this.onopen?.() }
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
}

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
  Element.prototype.scrollTo = vi.fn()
})
beforeEach(() => {
  uiSeat.value = undefined
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  levels = new Map([
    ['/tmp', level('/tmp', [dir(A), file('/tmp/readme.md')])],
    [A, level(A, [dir(B)])],
    [B, level(B, [dir(C)])],
    [C, level(C, [file(`${C}/leaf.txt`)])],
  ])
  pending = new Map()
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
    levels: await Promise.all(paths.map(path => pending.get(path) ?? Promise.resolve(levels.get(path) ?? level(path, [])))),
  }))
})

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function settle(): Promise<void> {
  // Each arrival may cause the next level to be requested in a separate effect.
  for (let wave = 0; wave < 8; wave += 1) await act(async () => { await Promise.resolve() })
}

function mount(mode: Mode, initialExpanded: string[] = [], pickerMode = false, query = '') {
  uiSeat.value = mode === 'fallback row' ? undefined : provider
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const toggled = vi.fn(); const selected = vi.fn(); const accepted = vi.fn(); const opened = vi.fn()
  let currentExpanded: string[] = []
  let refresh!: () => void
  const source = { fsTrees: (...args: Parameters<typeof fsTrees>) => fsTrees(...args) }
  function Harness() {
    const [expanded, setExpanded] = useState(initialExpanded)
    const [tick, setTick] = useState(0)
    const [selectedPath, setSelectedPath] = useState<string>()
    currentExpanded = expanded
    refresh = () => { setTick(value => value + 1) }
    const picker: FileExplorerPicker | undefined = pickerMode ? {
      query, selectedPath,
      onSelect: (path, isDir) => { selected(path, isDir); setSelectedPath(path) },
      onAccept: accepted,
    } : undefined
    return createElement(FileTree, {
      sessionId: 'quick-expand', cwd: '/tmp', expanded, revealed: [],
      onToggle: (path: string) => {
        toggled(path)
        setExpanded(current => current.includes(path) ? current.filter(item => item !== path) : [...current, path])
      },
      onOpenFile: opened, onReferenceFile: () => {}, refreshTick: tick,
      onUploadRequest: () => {}, busy: false,
      ...(picker === undefined ? {} : { picker, source }),
    })
  }
  act(() => { root.render(createElement(Harness)) })
  cleanups.push(() => { act(() => { root.unmount() }); container.remove() })
  function activate(path: string) {
    const label = [...container.querySelectorAll<HTMLElement>('[title]')].find(node => node.title === path)
    const target = mode === 'File UI chevron'
      ? [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === `Toggle ${path}`)
      : label?.closest<HTMLElement>('[role="button"]')
    if (target === undefined || target === null) throw new Error(`No ${mode} for ${path}`)
    act(() => { target.click() })
  }
  return { container, activate, toggled, selected, accepted, opened, expanded: () => currentExpanded, refresh: () => { act(refresh) } }
}

for (const mode of ['fallback row', 'File UI row', 'File UI chevron'] as const) describe(`FileTree quick expansion: ${mode}`, () => {
  it('opens each actual singleton directory, even without compact hints, and reveals the leaf', async () => {
    const tree = mount(mode)
    await settle()
    expect(tree.toggled).not.toHaveBeenCalled()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A, B, C])
    expect(tree.toggled.mock.calls.map(call => call[0])).toEqual([A, B, C])
    expect(tree.container.textContent).toContain('leaf.txt')
    expect(tree.opened).not.toHaveBeenCalled()
  })

  it('does not automatically follow a singleton symlink directory', async () => {
    levels.set(A, level(A, [{ ...dir(B), isSymlink: true }]))
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A])
    expect(tree.toggled.mock.calls.map(call => call[0])).toEqual([A])
    expect(fsTrees.mock.calls.flatMap(call => call[1] as string[])).not.toContain(B)
  })

  it('stops before a self-referential directory symlink can generate endless paths', async () => {
    levels.set(C, level(C, [{ ...dir(`${C}/link`), isSymlink: true }]))
    fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => levels.get(path) ?? level(path, [{ ...dir(`${path}/link`), isSymlink: true }])),
    }))
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A, B, C])
    const requested = fsTrees.mock.calls.flatMap(call => call[1] as string[])
    expect(requested).not.toContain(`${C}/link`)
    expect(requested.some(path => path.startsWith(`${C}/link/`))).toBe(false)
  })

  it('caps a long singleton chain instead of expanding and requesting indefinitely', async () => {
    const chain = Array.from({ length: MAX_COMPACT_DEPTH + 8 }, (_, index) => `${A}${'/next'.repeat(index)}`)
    for (const [index, path] of chain.entries()) {
      levels.set(path, level(path, index + 1 < chain.length ? [dir(chain[index + 1]!)] : [file(`${path}/leaf.txt`)]))
    }
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    for (let wave = 0; wave < chain.length; wave += 1) await settle()
    expect(tree.expanded()).toEqual(chain.slice(0, MAX_COMPACT_DEPTH))
    const requested = fsTrees.mock.calls.flatMap(call => call[1] as string[])
    expect(requested).toContain(chain[MAX_COMPACT_DEPTH - 1])
    expect(requested).not.toContain(chain[MAX_COMPACT_DEPTH])
  })

  it('keeps a pending walk when an unrelated directory is collapsed', async () => {
    const D = '/tmp/d'
    levels.set('/tmp', level('/tmp', [dir(A), dir(D)]))
    levels.set(D, level(D, [file(`${D}/only.txt`)]))
    const listing = deferred<FsLevel>(); pending.set(B, listing.promise)
    const tree = mount(mode)
    await settle()
    tree.activate(D)
    await settle()
    expect(tree.expanded()).toContain(D)
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([D, A, B])
    tree.activate(D)
    await settle()
    expect(tree.expanded()).toEqual([A, B])
    await act(async () => { listing.resolve(level(B, [dir(C)])) })
    await settle()
    expect(tree.expanded()).toEqual([A, B, C])
  })

  it('finishes both walks when a second directory is opened before the first listing arrives', async () => {
    const D = '/tmp/d'; const E = `${D}/e`; const F = `${E}/f`
    levels.set('/tmp', level('/tmp', [dir(A), dir(D)]))
    levels.set(E, level(E, [dir(F)]))
    levels.set(F, level(F, [file(`${F}/other-leaf.txt`)]))
    const first = deferred<FsLevel>(); const second = deferred<FsLevel>()
    pending.set(A, first.promise); pending.set(D, second.promise)
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    tree.activate(D)
    await settle()
    expect(tree.expanded()).toEqual([A, D])
    await act(async () => { second.resolve(level(D, [dir(E)])) })
    await settle()
    expect(tree.expanded()).toContain(F)
    expect(tree.expanded()).not.toContain(B)
    await act(async () => { first.resolve(level(A, [dir(B)])) })
    await settle()
    expect(new Set(tree.expanded())).toEqual(new Set([A, B, C, D, E, F]))
    expect(tree.container.textContent).toContain('leaf.txt')
    expect(tree.container.textContent).toContain('other-leaf.txt')
  })

  it('continues after each deferred directory listing arrives', async () => {
    const first = deferred<FsLevel>(); const second = deferred<FsLevel>()
    pending.set(A, first.promise); pending.set(B, second.promise)
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A])
    await act(async () => { first.resolve(level(A, [dir(B)])) })
    await settle()
    expect(tree.expanded()).toEqual([A, B])
    await act(async () => { second.resolve(level(B, [dir(C)])) })
    await settle()
    expect(tree.expanded()).toEqual([A, B, C])
    expect(tree.container.textContent).toContain('leaf.txt')
  })

  for (const [name, terminal] of [
    ['directory plus file', level(B, [dir(C), file(`${B}/side.txt`)])],
    ['multiple directories', level(B, [dir(C), dir(`${B}/other`)])],
    ['single file', level(B, [file(`${B}/only.txt`)])],
    ['empty directory', level(B, [])],
    ['error', level(B, [dir(C)], { error: 'permission denied' })],
    ['truncated listing', level(B, [dir(C)], { truncated: true })],
  ] as const) it(`stops at ${name}`, async () => {
    levels.set(B, terminal)
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A, B])
    expect(tree.toggled.mock.calls.map(call => call[0])).toEqual([A, B])
    expect(tree.opened).not.toHaveBeenCalled()
  })

  it('does not resume a pending chain after its ancestor is collapsed', async () => {
    const listing = deferred<FsLevel>(); pending.set(B, listing.promise)
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A, B])
    tree.activate(A)
    await settle()
    expect(tree.expanded()).not.toContain(A)
    tree.toggled.mockClear()
    await act(async () => { listing.resolve(level(B, [dir(C)])) })
    await settle()
    expect(tree.expanded()).not.toContain(A)
    expect(tree.expanded()).not.toContain(C)
    expect(tree.toggled).not.toHaveBeenCalled()
  })

  it('stops when the pending listing request rejects', async () => {
    const listing = deferred<FsLevel>(); pending.set(B, listing.promise)
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A, B])
    await act(async () => { listing.reject(new Error('listing offline')) })
    await settle()
    expect(tree.expanded()).toEqual([A, B])
    expect(tree.container.textContent).toContain('listing offline')
    expect(tree.toggled.mock.calls.map(call => call[0])).toEqual([A, B])
  })

  it('cancels a pending expansion when refreshed, even if refreshed data is a singleton', async () => {
    const listing = deferred<FsLevel>(); pending.set(B, listing.promise)
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A, B])
    pending.delete(B)
    tree.toggled.mockClear()
    tree.refresh()
    await settle()
    expect(tree.expanded()).toEqual([A, B])
    await act(async () => { listing.resolve(level(B, [dir(C)])) })
    await settle()
    expect(tree.expanded()).toEqual([A, B])
    expect(tree.toggled).not.toHaveBeenCalled()
  })

  it('does not revive an errored expansion when a later watch listing succeeds', async () => {
    levels.set(B, level(B, [], { error: 'permission denied' }))
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A, B])
    expect(tree.container.textContent).toContain('permission denied')
    tree.toggled.mockClear()
    levels.set(B, level(B, [dir(C)]))
    const socket = FakeSocket.instances.at(-1)
    if (socket === undefined) throw new Error('No directory watcher was created')
    act(() => { socket.open(); socket.frame({ dir: B }) })
    await settle()
    expect(tree.container.textContent).not.toContain('permission denied')
    expect(tree.expanded()).toEqual([A, B])
    expect(tree.toggled).not.toHaveBeenCalled()
  })

  it('does not start from restored expansion or an explicit refresh', async () => {
    const tree = mount(mode, [A])
    await settle()
    expect(tree.expanded()).toEqual([A])
    expect(tree.toggled).not.toHaveBeenCalled()
    tree.refresh()
    await settle()
    expect(tree.expanded()).toEqual([A])
    expect(tree.toggled).not.toHaveBeenCalled()
  })

  it('does not start when a watch update turns an open directory into a singleton', async () => {
    levels.set(A, level(A, [dir(B), file(`${A}/side.txt`)]))
    const tree = mount(mode)
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A])
    tree.toggled.mockClear()
    levels.set(A, level(A, [dir(B)]))
    const socket = FakeSocket.instances.at(-1)
    if (socket === undefined) throw new Error('No directory watcher was created')
    act(() => { socket.open(); socket.frame({ dir: A }) })
    await settle()
    expect(tree.container.textContent).not.toContain('side.txt')
    expect(tree.expanded()).toEqual([A])
    expect(tree.toggled).not.toHaveBeenCalled()
  })

  it('continues when picker filtering leaves exactly one displayed directory', async () => {
    levels.set(B, level(B, [dir(C), file(`${B}/filtered-out.txt`)]))
    const tree = mount(mode, [], true, 'leaf')
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A, B, C])
    expect(tree.container.textContent).not.toContain('filtered-out.txt')
    expect(tree.container.textContent).toContain('leaf.txt')
    expect(tree.selected).toHaveBeenCalledExactlyOnceWith(A, true)
  })

  it('only toggles automatic descendants without moving picker selection', async () => {
    const tree = mount(mode, [], true)
    await settle()
    tree.activate(A)
    await settle()
    expect(tree.expanded()).toEqual([A, B, C])
    expect(tree.selected).toHaveBeenCalledExactlyOnceWith(A, true)
    expect(tree.accepted).not.toHaveBeenCalled()
    expect(tree.opened).not.toHaveBeenCalled()
  })
})
