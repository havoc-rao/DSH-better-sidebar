/**
 * The SOURCE-form file-tree section renderer (v0.20.0,
 * `src/client/section-source-tree.tsx`): the HOST draws the upper module's
 * tree with its own FileTree bound to the plugin's data source. Covers:
 * root resolution (sync + async, FIRST root only, no roots / empty /
 * rejected / throwing → unrendered, never a crash), the single-source
 * binding (listings all through the source's `list`, the local host route
 * never touched), the component-owned expansion with resets on session /
 * root changes, and the file-open delegation (`capabilities.open` +
 * `source.open`). The TreePanel-side integration (ExplorerDual picking
 * the source form) lives in file-tree-section.spec.tsx; the FileTree-side
 * open delegation is covered in file-tree-remote.spec.tsx.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SectionSourceTree } from '../src/client/section-source-tree.tsx'
import type {
  FileTreeDataSource, FileTreeListResult, FileTreeProviderCapabilities, FileTreeProviderRoot,
} from '../src/client/file-tree-source.ts'
import type { FileTreeSectionDescriptor, FileTreeSectionScope } from '../src/client/file-tree-section.ts'
import type { Context } from '../src/context-types.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

// The LOCAL host route spy: a source-form tree must NEVER touch it.
const fsTreeMock = vi.hoisted(() => vi.fn())
vi.mock('../src/client/api.ts', () => ({
  api: { fsTree: fsTreeMock },
  downloadUrl: () => '/sidebar/file',
}))

const root = (dir: string, label = 'Remote Proj', id = 'root'): FileTreeProviderRoot => ({ id, label, dir })

const entries = (list: Array<Record<string, unknown>>): FileTreeListResult => ({ entries: list as never })

interface Harness {
  container: HTMLDivElement
  list: ReturnType<typeof vi.fn>
  createSource: ReturnType<typeof vi.fn>
  unmount: () => void
  rerender: (patch: Record<string, unknown>) => Promise<void>
}

async function mountSource(options: {
  roots?: (() => FileTreeProviderRoot[] | Promise<FileTreeProviderRoot[]>) | null
  /** The dir whose listing carries the fixture entries (default
   *  '/remote/proj'); every OTHER dir lists EMPTY — a mock that returned
   *  the same entries everywhere would self-reference its own 'src' row
   *  and recurse forever when that dir is expanded. */
  rootDir?: string
  listEntries?: Array<Record<string, unknown>>
  capabilities?: FileTreeProviderCapabilities
  open?: (path: string) => void
  sessionId?: string
  /** Replace the whole section object (root change / re-registration). */
  section?: FileTreeSectionDescriptor
} = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const rootEl: Root = createRoot(container)
  fsTreeMock.mockReset()
  const rootDir = options.rootDir ?? '/remote/proj'
  const list = vi.fn(async (dir: string) => entries(dir === rootDir ? options.listEntries ?? [
    { name: 'a.txt', path: `${rootDir}/a.txt`, isDir: false },
    { name: 'src', path: `${rootDir}/src`, isDir: true },
    { name: 'big.bin', path: `${rootDir}/big.bin`, isDir: false, meta: { size: 3565158, mtime: new Date(2026, 8, 6, 14, 30).getTime() } },
  ] : []))
  const createSource = vi.fn(() => {
    const source: FileTreeDataSource = { list }
    if (options.open !== undefined) source.open = options.open
    return source
  })
  const section: FileTreeSectionDescriptor = options.section ?? {
    id: 'remote',
    match: () => true,
    source: {
      createSource,
      // null = no roots declared at all; undefined = the default root.
      roots: options.roots === undefined ? () => [root('/remote/proj')] : options.roots ?? undefined,
      capabilities: options.capabilities,
    },
  }
  const scope = {
    sessionId: options.sessionId ?? 's1',
    cwd: '/local',
    ctx: undefined as unknown as Context,
  } satisfies FileTreeSectionScope
  const render = (patch: Record<string, unknown> = {}): void => {
    rootEl.render(createElement(SectionSourceTree, { section, scope, ...patch } as never))
  }
  await act(async () => { render() })
  await act(async () => { await Promise.resolve() })
  return {
    container,
    list,
    createSource,
    rerender: async (patch: Record<string, unknown>) => {
      await act(async () => { render(patch) })
      await act(async () => { await Promise.resolve() })
    },
    unmount: () => { act(() => { rootEl.unmount() }); container.remove() },
  }
}

/** A tree row (role="button") whose name span matches. */
function rowNamed(container: HTMLDivElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

const rowMaybe = (container: HTMLDivElement, name: string): HTMLElement | undefined =>
  [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('SectionSourceTree (v0.20.0 source form)', () => {
  let harness: Harness
  afterEach(() => {
    harness?.unmount()
    document.body.innerHTML = ''
  })

  it('renders the host FileTree bound to the source: root = FIRST declared root, listings only through list()', async () => {
    harness = await mountSource({
      roots: () => [root('/remote/proj'), root('/remote/other', 'Other')],
    })
    expect(harness.container.querySelector('[data-dsh-file-tree-section-source="remote"]')).not.toBeNull()
    // The tree loaded the FIRST root only.
    expect(harness.list).toHaveBeenCalledTimes(1)
    expect(harness.list).toHaveBeenCalledWith('/remote/proj')
    expect(fsTreeMock).not.toHaveBeenCalled()
    // The tree lists remote rows and the root row shows the remote basename.
    expect(rowNamed(harness.container, 'a.txt')).toBeDefined()
    expect(harness.container.textContent).toContain('proj')
    // createSource received the session scope verbatim.
    expect(harness.createSource).toHaveBeenCalledWith('s1', '/local')
  })

  it('resolves ASYNC roots after a pending window (null first, then the tree)', async () => {
    let resolveRoots!: (list: FileTreeProviderRoot[]) => void
    harness = await mountSource({
      rootDir: '/async/proj',
      roots: () => new Promise<FileTreeProviderRoot[]>(resolve => { resolveRoots = resolve }),
    })
    // Pending: nothing rendered yet.
    expect(harness.container.querySelector('[data-dsh-file-tree-section-source="remote"]')).toBeNull()
    await act(async () => { resolveRoots([root('/async/proj', 'Async')]) })
    await act(async () => { await Promise.resolve() })
    expect(harness.container.querySelector('[data-dsh-file-tree-section-source="remote"]')).not.toBeNull()
    expect(harness.list).toHaveBeenCalledWith('/async/proj')
    // The root row shows the remote root's BASENAME (single-source rows
    // ignore the label); the listing came from the source.
    expect(rowNamed(harness.container, 'a.txt')).toBeDefined()
    expect(harness.container.textContent).toContain('proj')
  })

  it('no roots / empty roots / rejected roots / throwing createSource → unrendered, never a crash', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // No roots declared at all.
      harness = await mountSource({ roots: null })
      expect(harness.container.querySelector('[data-dsh-file-tree-section-source]')).toBeNull()
      harness.unmount()
      document.body.innerHTML = ''
      // Empty array.
      harness = await mountSource({ roots: () => [] })
      expect(harness.container.querySelector('[data-dsh-file-tree-section-source]')).toBeNull()
      harness.unmount()
      document.body.innerHTML = ''
      // Rejected promise.
      harness = await mountSource({ roots: () => Promise.reject(new Error('roots down')) })
      expect(harness.container.querySelector('[data-dsh-file-tree-section-source]')).toBeNull()
      harness.unmount()
      document.body.innerHTML = ''
      // Throwing roots function.
      harness = await mountSource({ roots: () => { throw new Error('roots boom') } })
      expect(harness.container.querySelector('[data-dsh-file-tree-section-source]')).toBeNull()
      harness.unmount()
      document.body.innerHTML = ''
      // Throwing createSource (root resolves fine, factory fails).
      harness = await mountSource({
        section: {
          id: 'remote',
          match: () => true,
          source: {
            createSource: () => { throw new Error('factory boom') },
            roots: () => [root('/remote/proj')],
          },
        },
      })
      expect(harness.container.querySelector('[data-dsh-file-tree-section-source]')).toBeNull()
    } finally {
      error.mockRestore()
    }
  })

  it('expands directories through the source and keeps the expansion component-owned (collapsible)', async () => {
    harness = await mountSource()
    click(rowNamed(harness.container, 'src'))
    await act(async () => { await Promise.resolve() })
    expect(harness.list.mock.calls.map(call => call[0])).toEqual(['/remote/proj', '/remote/proj/src'])
    // Collapse again: no new listing (the collapsed dir is not reloaded).
    click(rowNamed(harness.container, 'src'))
    await act(async () => { await Promise.resolve() })
    expect(harness.list).toHaveBeenCalledTimes(2)
  })

  it('resets the expansion on session change (no stale remote paths across switches)', async () => {
    harness = await mountSource()
    click(rowNamed(harness.container, 'src'))
    await act(async () => { await Promise.resolve() })
    expect(harness.list).toHaveBeenCalledWith('/remote/proj/src')
    await harness.rerender({ scope: { sessionId: 's2', cwd: '/local', ctx: undefined } })
    // The new session re-resolves the root AND wipes the level cache (the
    // tick bump + expansion reset land with the new root in one commit) —
    // the root listing reloads, while the previously expanded dir is NOT
    // reloaded after the switch (no stale paths resurface).
    expect(harness.list.mock.calls.map(call => call[0]))
      .toEqual(['/remote/proj', '/remote/proj/src', '/remote/proj'])
  })

  it('re-resolves on a section re-registration and resets the expansion when the ROOT changes', async () => {
    // Rebuild with local mounts (the root-change simulation swaps the
    // whole section descriptor object, like a section re-registration).
    const container = document.createElement('div')
    document.body.append(container)
    const rootEl: Root = createRoot(container)
    fsTreeMock.mockReset()
    const list = vi.fn(async (dir: string) => entries(
      dir === '/remote/proj' ? [{ name: 'src', path: '/remote/proj/src', isDir: true }] : [],
    ))
    const scope = { sessionId: 's1', cwd: '/local', ctx: undefined as unknown as Context }
    let section: FileTreeSectionDescriptor = {
      id: 'remote',
      match: () => true,
      source: { createSource: () => ({ list }), roots: () => [root('/remote/proj')] },
    }
    await act(async () => { rootEl.render(createElement(SectionSourceTree, { section, scope })) })
    await act(async () => { await Promise.resolve() })
    click(rowNamed(container, 'src'))
    await act(async () => { await Promise.resolve() })
    expect(list).toHaveBeenCalledWith('/remote/proj/src')
    // A re-registration with a DIFFERENT root dir: the tree switches root
    // and the expansion (reset) never reloads the old subtree.
    section = {
      id: 'remote',
      match: () => true,
      source: { createSource: () => ({ list }), roots: () => [root('/remote/other', 'Other')] },
    }
    await act(async () => { rootEl.render(createElement(SectionSourceTree, { section, scope })) })
    await act(async () => { await Promise.resolve() })
    expect(list).toHaveBeenLastCalledWith('/remote/other')
    expect(list).not.toHaveBeenCalledWith('/remote/other/src')
    act(() => { rootEl.unmount() })
    container.remove()
  })

  it('file-row open delegates to source.open when capabilities.open is declared; inert without it', async () => {
    const open = vi.fn()
    harness = await mountSource({ open, capabilities: { open: true } })
    click(rowNamed(harness.container, 'a.txt'))
    expect(open).toHaveBeenCalledWith('/remote/proj/a.txt')
    harness.unmount()
    document.body.innerHTML = ''
    // Without the declared capability the row is inert (the section tree's
    // onOpenFile is a no-op — the plugin owns opening by design).
    open.mockClear()
    harness = await mountSource({ open })
    click(rowNamed(harness.container, 'a.txt'))
    expect(open).not.toHaveBeenCalled()
  })

  it('provider rows render the dimmed stat suffix and the container fills the module', async () => {
    harness = await mountSource()
    const meta = rowNamed(harness.container, 'big.bin').querySelector('[class*="explorerMeta"]')
    expect(meta?.textContent).toBe('3.4 MB 9-6 14:30')
    expect(rowNamed(harness.container, 'a.txt').querySelector('[class*="explorerMeta"]')).toBeNull()
    const wrapper = harness.container.querySelector('[data-dsh-file-tree-section-source="remote"]')!
    expect(wrapper.className).toContain('sectionSourceTree')
    expect(harness.container.querySelector('[class*="explorerBody"]')).toBeDefined()
    // Local-less tree: the host route was never consulted.
    expect(fsTreeMock).not.toHaveBeenCalled()
  })
})