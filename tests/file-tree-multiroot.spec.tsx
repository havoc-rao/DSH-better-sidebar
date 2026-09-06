/**
 * FileTree multi-root mode (v0.18.0+): a provider's `roots` declarations
 * turn the session's tree into a root LIST — the local cwd root (full
 * local semantics, listed through the local fs.tree route, NEVER taken
 * over by a provider) plus one expandable row per remote root (browsed
 * through that provider's `list`). Covers: two-source rendering, root
 * expansion/independence, async roots resolution, throwing roots skipped,
 * zero-roots regression (byte-identical single-root behavior), refreshTick
 * wiping every root's cache, per-root capability degradation (upload /
 * download / open-with / git) with the local root unconditionally full,
 * and TreePanel's panel-level gates staying local in multi-root mode.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { TreePanel } from '../src/client/TreePanel.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import type { Context } from '../src/context-types.ts'
import type {
  FileTreeListResult, FileTreeProviderCapabilities, FileTreeProviderDescriptor, FileTreeProviderRoot,
} from '../src/client/file-tree-source.ts'
import type { GitRowStatus } from '../src/client/git-status.ts'
import type { UploadItem } from '../src/client/upload.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

// Host route spies: multi-root tests assert the LOCAL root is served by
// fsTree (never the provider) and the remote roots by the providers.
const fsTreeMock = vi.hoisted(() => vi.fn())
const gitStatusMock = vi.hoisted(() => vi.fn())
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: fsTreeMock,
    gitStatus: gitStatusMock,
    fsSearch: vi.fn(),
    uploadFile: vi.fn(),
  },
  downloadUrl: () => '/sidebar/file',
}))

beforeEach(() => {
  fsTreeMock.mockReset()
  fsTreeMock.mockResolvedValue({ entries: [{ name: 'local.txt', path: '/r/local.txt', isDir: false }] })
  gitStatusMock.mockReset()
  gitStatusMock.mockResolvedValue({ isRepo: true, branch: 'main', entries: [] })
})

/** One provider to register: `roots` may throw (declared as an Error),
 *  return an array, or return a promise of one. */
interface ProviderSpec {
  id: string
  matches?: boolean
  roots?: () => FileTreeProviderRoot[] | Promise<FileTreeProviderRoot[]> | Error
  caps?: FileTreeProviderCapabilities
  /** The listing the provider serves under ANY of its dirs (dir → entries). */
  listEntries?: Record<string, Array<Record<string, unknown>>>
}

interface Harness {
  container: HTMLDivElement
  lists: Map<string, Mock<(dir: string) => Promise<FileTreeListResult>>>
  uploads: { dir: string; items: UploadItem[] }[]
  rerender: (patch: Record<string, unknown>) => Promise<void>
  unmount: () => void
  service: ReturnType<typeof createBetterSidebarService>
}

async function mountTree(options: {
  specs?: ProviderSpec[]
  cwd?: string
  expanded?: string[]
  ctx?: Context
  gitStatus?: ReadonlyMap<string, GitRowStatus>
  component?: typeof FileTree | typeof TreePanel
  withService?: boolean
} = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const lists = new Map<string, Mock<(dir: string) => Promise<FileTreeListResult>>>()
  const uploads: { dir: string; items: UploadItem[] }[] = []
  let ctx = options.ctx
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  if (ctx === undefined && options.withService !== false) {
    for (const spec of options.specs ?? []) {
      const list = vi.fn()
      list.mockImplementation(async (dir: string) => ({
        entries: spec.listEntries?.[dir] ?? [
          { name: `remote-${spec.id}.txt`, path: `${dir}/remote-${spec.id}.txt`, isDir: false },
        ],
      }))
      lists.set(spec.id, list)
      service.registerFileTreeProvider({
        id: spec.id,
        match: () => spec.matches !== false,
        createSource: () => ({ list }),
        roots: spec.roots === undefined
          ? undefined
          : () => {
              const result = spec.roots!()
              if (result instanceof Error) throw result
              return result
            },
        capabilities: spec.caps,
      } satisfies FileTreeProviderDescriptor)
    }
    ctx = { betterSidebar: service } as unknown as Context
  }
  const Component = options.component ?? FileTree
  const props: Record<string, unknown> = {
    sessionId: 's1',
    cwd: options.cwd ?? '/r',
    expanded: options.expanded ?? [],
    revealed: [],
    ctx,
    onToggle: () => {},
    onOpenFile: () => {},
    onOpenFileNewTab: () => {},
    onOpenFileSide: () => {},
    onReferenceFile: () => {},
    refreshTick: 0,
    gitStatus: options.gitStatus,
    onUploadRequest: (dir: string, items: UploadItem[]) => { uploads.push({ dir, items }) },
    busy: false,
    openWithTargets: [openWithVscode],
    onOpenWith: () => {},
  }
  const render = (patch: Record<string, unknown> = {}): void => {
    root.render(createElement(Component, { ...props, ...patch } as never))
  }
  await act(async () => { render() })
  // Flush the async roots resolution (settled roots flip the mode).
  await act(async () => { await Promise.resolve() })
  return {
    container,
    lists,
    uploads,
    service,
    rerender: async (patch: Record<string, unknown>) => {
      await act(async () => { render(patch) })
      await act(async () => { await Promise.resolve() })
    },
    unmount: () => { act(() => { root.unmount() }) },
  }
}

/** A tree row (role="button") whose name span matches. */
function rowNamed(container: HTMLDivElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** rowNamed without the throw (for absence assertions). */
function rowMaybe(container: HTMLDivElement, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
}

/** A multi-root starting-point row (has the root-row class). */
function rootRowNamed(container: HTMLDivElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[class*="explorerRootRow"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === label)
  if (row === undefined) throw new Error(`root row not found: ${label}`)
  return row
}

/** Click a row inside act() (the open/close state update). */
function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function dragEvent(type: string, dataTypes: string[] = ['Files']): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: dataTypes,
      items: [],
      files: [new File(['x'], 'dropped.txt')],
      dropEffect: '',
    },
  })
  return event
}

function fire(target: Element, type: string, dataTypes?: string[]): Event {
  const event = dragEvent(type, dataTypes)
  act(() => { target.dispatchEvent(event) })
  return event
}

const dropZone = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[class*="uploadDropZone"]')

const modified: GitRowStatus = { letter: 'M', kind: 'modified', deleted: false }

const openWithVscode = {
  id: 'vscode',
  nameKey: 'openWithVscode',
  name: '',
  kind: 'url' as const,
  urlTemplate: 'vscode://file/{path}',
  isVscodeFamily: true,
  localOnly: false,
}

/** The standard two-root setup: local cwd '/r' + a remote root provider. */
const twoRootSpecs = (): ProviderSpec[] => [{
  id: 'remote',
  roots: () => [{ id: 'proj', label: 'Remote Project', dir: '/remote/proj' }],
  caps: {},
}]

describe('FileTree multi-root mode', () => {
  let harness: Harness
  afterEach(() => {
    harness?.unmount()
    document.body.innerHTML = ''
  })

  it('renders the local + remote root list; the LOCAL root starts open through the local host, remote roots start collapsed', async () => {
    harness = await mountTree({ specs: twoRootSpecs() })
    // Both starting points are visible: the local cwd basename and the
    // declared remote label.
    expect(rootRowNamed(harness.container, 'r')).toBeDefined()
    expect(rootRowNamed(harness.container, 'Remote Project')).toBeDefined()
    // The local root is OPEN by default and served by the local route.
    expect(fsTreeMock).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/r' }, '/r')
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
    // The remote root is COLLAPSED: no provider listings, no remote rows.
    expect(harness.lists.get('remote')!).not.toHaveBeenCalled()
    expect(harness.container.textContent).not.toContain('remote-remote.txt')
  })

  it('expanding a remote root browses through the provider list, expansions included; the local route is never consulted for remote dirs', async () => {
    harness = await mountTree({ specs: twoRootSpecs(), expanded: ['/remote/proj/src'] })
    expect(fsTreeMock).toHaveBeenCalledTimes(2) // pending-window read + post-flip reload
    click(rootRowNamed(harness.container, 'Remote Project'))
    await act(async () => { await Promise.resolve() })
    const list = harness.lists.get('remote')!
    expect(list).toHaveBeenCalledWith('/remote/proj')
    // The caller's expanded dir under the remote root loads too.
    expect(list).toHaveBeenCalledWith('/remote/proj/src')
    // Remote dirs NEVER hit the local route.
    expect(fsTreeMock).not.toHaveBeenCalledWith(expect.anything(), '/remote/proj')
    expect(rowNamed(harness.container, 'remote-remote.txt')).toBeDefined()
  })

  it('the LOCAL root is never taken over in multi-root mode — a v0.17 provider without roots is bypassed for listings entirely', async () => {
    harness = await mountTree({
      specs: [
        // A v0.17-style provider: matches the session, no roots — in
        // single-root mode it would take the whole tree over. In
        // multi-root mode its listings must never run.
        { id: 'plain', caps: {} },
        ...twoRootSpecs(),
      ],
    })
    expect(fsTreeMock).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/r' }, '/r')
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
    expect(harness.container.textContent).not.toContain('plain.txt')
    expect(harness.lists.get('plain')).not.toHaveBeenCalled()
    expect(harness.lists.get('remote')).not.toHaveBeenCalled()
  })

  it('each root opens and collapses INDEPENDENTLY (local root collapsible; cache survives a collapse/reopen)', async () => {
    const specs = twoRootSpecs()
    harness = await mountTree({ specs })
    const localRow = rootRowNamed(harness.container, 'r')
    const remoteRow = rootRowNamed(harness.container, 'Remote Project')
    click(remoteRow) // open remote
    await act(async () => { await Promise.resolve() })
    expect(harness.lists.get('remote')!).toHaveBeenCalledWith('/remote/proj')
    // Local root loads: once in the pending window, once after the mode
    // flip wiped the cache (the flip reloads the visible set).
    expect(fsTreeMock).toHaveBeenCalledTimes(2)
    // Collapse the LOCAL root: its subtree disappears, remote stays open.
    click(localRow)
    expect(rowMaybe(harness.container, 'local.txt')).toBeUndefined()
    expect(rowNamed(harness.container, 'remote-remote.txt')).toBeDefined()
    // Re-open the local root: the level CACHE survived (no refetch).
    click(localRow)
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
    expect(fsTreeMock).toHaveBeenCalledTimes(2)
  })

  it('refreshTick wipes EVERY open root cache (local + remote both reload)', async () => {
    harness = await mountTree({ specs: twoRootSpecs() })
    click(rootRowNamed(harness.container, 'Remote Project'))
    await act(async () => { await Promise.resolve() })
    const localCalls = fsTreeMock.mock.calls.length
    const remoteCalls = harness.lists.get('remote')!.mock.calls.length
    await harness.rerender({ refreshTick: 1 })
    expect(fsTreeMock.mock.calls.length).toBe(localCalls + 1)
    expect(harness.lists.get('remote')!.mock.calls.length).toBe(remoteCalls + 1)
  })

  it('async roots (a promise) settle into multi-root; the local root stays local', async () => {
    harness = await mountTree({ specs: [{
      id: 'remote',
      roots: async () => [{ id: 'proj', label: 'Async Project', dir: '/async/proj' }],
      caps: {},
    }] })
    expect(rootRowNamed(harness.container, 'Async Project')).toBeDefined()
    // The local root is served by the local route even after the switch.
    expect(fsTreeMock).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/r' }, '/r')
    click(rootRowNamed(harness.container, 'Async Project'))
    await act(async () => { await Promise.resolve() })
    expect(harness.lists.get('remote')!).toHaveBeenCalledWith('/async/proj')
  })

  it('a throwing roots is skipped: the tree stays intact (single-root local), other providers still contribute', async () => {
    harness = await mountTree({ specs: [
      { id: 'boom', roots: () => { throw new Error('roots exploded') }, caps: {} },
      { id: 'good', roots: () => [{ id: 'g', label: 'Good Root', dir: '/good/root' }], caps: {} },
    ] })
    // The good provider's root renders; the throwing one contributed
    // nothing; the local root keeps working.
    expect(rootRowNamed(harness.container, 'Good Root')).toBeDefined()
    expect(fsTreeMock).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/r' }, '/r')
    expect(harness.container.querySelectorAll('[class*="explorerRootRow"]').length).toBe(2)

    harness.unmount()
    harness = await mountTree({ specs: [{ id: 'boom', roots: () => { throw new Error('roots exploded') }, caps: {} }] })
    // Zero roots settled → the session is NOT multi-root: the v0.17
    // single-source takeover serves the tree through the (matching)
    // provider, exactly like any roots-less provider session. The
    // throwing roots only lost its ROOTS — the tree never breaks. (The
    // one local read is the pending-window render before the settlement.)
    expect(harness.container.querySelector('[class*="explorerRootRow"]')).toBeNull()
    expect(rowNamed(harness.container, 'remote-boom.txt')).toBeDefined()
    expect(harness.lists.get('boom')).toHaveBeenCalledWith('/r')
  })

  it('no roots declared: single-root behavior is byte-identical (provider takeover path intact)', async () => {
    // A v0.17 provider (no roots): the whole tree through its list.
    harness = await mountTree({ specs: [{ id: 'plain', caps: {} }] })
    expect(harness.container.querySelector('[class*="explorerRootRow"]')).toBeNull()
    const list = harness.lists.get('plain')!
    expect(list).toHaveBeenCalledWith('/r')
    expect(fsTreeMock).not.toHaveBeenCalled()

    // No providers at all: the local host serves, no root rows.
    harness.unmount()
    harness = await mountTree({ specs: [], withService: true })
    expect(harness.container.querySelector('[class*="explorerRootRow"]')).toBeNull()
    expect(fsTreeMock).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/r' }, '/r')
  })

  it('remote roots merge across providers in registration order with first-id wins', async () => {
    harness = await mountTree({ specs: [
      { id: 'a', roots: () => [{ id: 'dup', label: 'A-Dup', dir: '/a/dup' }, { id: 'a-only', label: 'A Only', dir: '/a/only' }], caps: {} },
      { id: 'b', roots: () => [{ id: 'dup', label: 'B-Dup', dir: '/b/dup' }, { id: 'b-only', label: 'B Only', dir: '/b/only' }], caps: {} },
    ] })
    const labels = [...harness.container.querySelectorAll<HTMLElement>('[class*="explorerRootRow"] [class*="explorerName"]')]
      .map(el => el.textContent)
    // Local root first, then a's roots, then b's unique root (dup dropped).
    expect(labels).toEqual(['r', 'A-Dup', 'A Only', 'B Only'])
  })

  it('a provider registered while the tree is mounted flips the mode live and reloads through the new composition', async () => {
    harness = await mountTree({ specs: [], withService: true })
    expect(fsTreeMock).toHaveBeenCalledTimes(1)
    act(() => {
      harness.service.registerFileTreeProvider({
        id: 'live',
        match: () => true,
        createSource: () => ({ list: async () => ({ entries: [{ name: 'live.txt', path: '/live/proj/live.txt', isDir: false }] }) }),
        roots: () => [{ id: 'live', label: 'Live Root', dir: '/live/proj' }],
        capabilities: {},
      })
    })
    await act(async () => { await Promise.resolve() })
    // The mode flip wiped the cache: the local root reloaded through the
    // local route again (it had a cached listing already).
    expect(rootRowNamed(harness.container, 'Live Root')).toBeDefined()
    expect(fsTreeMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('the local root row carries the full local face: upload works even when the provider declares nothing', async () => {
    harness = await mountTree({ specs: twoRootSpecs() })
    click(rootRowNamed(harness.container, 'Remote Project'))
    await act(async () => { await Promise.resolve() })
    // A drop on the BODY targets the LOCAL root (cwd) — remote capabilities
    // must not degrade the local starting point.
    const body = harness.container.firstElementChild as HTMLElement
    fire(body, 'dragenter')
    expect(dropZone()).not.toBeNull()
    fire(body, 'drop')
    await act(async () => { await Promise.resolve() })
    expect(harness.uploads).toHaveLength(1)
    expect(harness.uploads[0]!.dir).toBe('/r')
  })

  it('remote root upload degrades by ITS capability face: undeclared → inert, declared → reports the remote dir', async () => {
    harness = await mountTree({ specs: twoRootSpecs() })
    click(rootRowNamed(harness.container, 'Remote Project'))
    await act(async () => { await Promise.resolve() })
    const remoteRow = rowNamed(harness.container, 'remote-remote.txt')
    // Undeclared upload: the drop on a remote row is swallowed (no zone,
    // no request, and it never falls through to the local root).
    fire(remoteRow, 'dragenter')
    fire(remoteRow, 'dragover')
    fire(remoteRow, 'drop')
    await act(async () => { await Promise.resolve() })
    expect(harness.uploads).toEqual([])

    // Declared upload: the remote row becomes a real drop target.
    harness.unmount()
    harness = await mountTree({ specs: [{ id: 'remote', roots: () => [{ id: 'proj', label: 'Remote Project', dir: '/remote/proj' }], caps: { upload: true } }] })
    click(rootRowNamed(harness.container, 'Remote Project'))
    await act(async () => { await Promise.resolve() })
    const remoteRow2 = rowNamed(harness.container, 'remote-remote.txt')
    fire(remoteRow2, 'dragover')
    fire(remoteRow2, 'drop')
    await act(async () => { await Promise.resolve() })
    expect(harness.uploads).toHaveLength(1)
    expect(harness.uploads[0]!.dir).toBe('/remote/proj')
  })

  it('context-menu ability entries gate per row face: remote rows degrade (download / open-with / upload-here), the local root keeps everything', async () => {
    // Remote FILE row with an empty capability face: no download, no
    // open-with section.
    harness = await mountTree({ specs: twoRootSpecs() })
    click(rootRowNamed(harness.container, 'Remote Project'))
    await act(async () => { await Promise.resolve() })
    act(() => { rowNamed(harness.container, 'remote-remote.txt')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) })
    let items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent?.trim() ?? '')
    expect(items).not.toContain('Download')
    expect(items.some(text => text.includes('Open with'))).toBe(false)
    harness.unmount()
    document.body.innerHTML = ''

    // Remote DIR row: no upload-here with an empty face…
    harness = await mountTree({ specs: [{
      id: 'remote',
      roots: () => [{ id: 'dirs', label: 'Remote Dirs', dir: '/remote/dirs' }],
      caps: {},
      listEntries: {
        '/remote/dirs': [{ name: 'sub', path: '/remote/dirs/sub', isDir: true }],
      },
    }] })
    click(rootRowNamed(harness.container, 'Remote Dirs'))
    await act(async () => { await Promise.resolve() })
    act(() => { rowNamed(harness.container, 'sub')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) })
    items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent?.trim() ?? '')
    expect(items).not.toContain('Upload here')
    harness.unmount()
    document.body.innerHTML = ''

    // …while the LOCAL root row (full local face) keeps upload-here even
    // with the same empty provider capability face.
    harness = await mountTree({ specs: twoRootSpecs() })
    act(() => { rootRowNamed(harness.container, 'r')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) })
    items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent?.trim() ?? '')
    expect(items).toContain('Upload here')
  })

  it('declared remote download + open-with surfaces appear on remote rows', async () => {
    harness = await mountTree({ specs: [{
      id: 'remote',
      roots: () => [{ id: 'proj', label: 'Remote Project', dir: '/remote/proj' }],
      caps: { download: true, openWith: true },
    }] })
    click(rootRowNamed(harness.container, 'Remote Project'))
    await act(async () => { await Promise.resolve() })
    act(() => { rowNamed(harness.container, 'remote-remote.txt')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) })
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent?.trim() ?? '')
    expect(items).toContain('Download')
    expect(items.some(text => text.includes('Open with'))).toBe(true)
  })

  it('git decorations stay data-driven: the LOCAL map decorates local rows only, remote rows stay clean', async () => {
    harness = await mountTree({
      specs: twoRootSpecs(),
      gitStatus: new Map([['/r/local.txt', modified]]),
    })
    click(rootRowNamed(harness.container, 'Remote Project'))
    await act(async () => { await Promise.resolve() })
    const localBadge = rowNamed(harness.container, 'local.txt').querySelector('[class*="explorerGitBadge"]')
    expect(localBadge).not.toBeNull()
    expect(localBadge!.textContent).toBe('M')
    const remoteRow = rowNamed(harness.container, 'remote-remote.txt')
    expect(remoteRow.querySelector('[class*="explorerGitBadge"]')).toBeNull()
  })

  it('a "Show in folder" reveal of local paths re-opens a collapsed local root', async () => {
    harness = await mountTree({ specs: twoRootSpecs() })
    click(rootRowNamed(harness.container, 'r'))
    expect(rowMaybe(harness.container, 'local.txt')).toBeUndefined()
    await harness.rerender({ revealed: ['/r/sub/deep.txt'] })
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
  })
})

describe('TreePanel in multi-root mode (local root exists ⇒ panel gates stay local)', () => {
  let harness: Harness
  afterEach(() => {
    harness?.unmount()
    document.body.innerHTML = ''
  })

  it('keeps the search box, upload pickers and git status fully local even with an empty provider capability face', async () => {
    harness = await mountTree({
      component: TreePanel,
      specs: twoRootSpecs(),
    })
    expect(harness.container.querySelector('[data-dsh-sidebar-search]')).not.toBeNull()
    expect(harness.container.querySelector('[aria-label="Upload files"]')).not.toBeNull()
    expect(harness.container.querySelector('[aria-label="Upload folder"]')).not.toBeNull()
    expect(gitStatusMock).toHaveBeenCalled()
    // The tree below the panels is the multi-root tree.
    expect(rootRowNamed(harness.container, 'Remote Project')).toBeDefined()
  })

  it('a declared provider search is NOT consulted (the box serves the local root)', async () => {
    const search = vi.fn(async () => ({ matches: ['src/remote.ts'], truncated: false }))
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileTreeProvider({
      id: 'remote',
      match: () => true,
      createSource: () => ({ list: async () => ({ entries: [] }), search }),
      roots: () => [{ id: 'proj', label: 'Remote Project', dir: '/remote/proj' }],
      capabilities: { search: true },
    })
    harness = await mountTree({ ctx: { betterSidebar: service } as unknown as Context, component: TreePanel })
    await harness.rerender({})
    const input = harness.container.querySelector<HTMLInputElement>('[data-dsh-sidebar-search]')
    expect(input).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'anything')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })
    expect(search).not.toHaveBeenCalled()
  })
})