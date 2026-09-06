/**
 * FileTree with a registered data-source provider (v0.17.0+): the provider's
 * `list` replaces the local host fs.tree for a matching session (root +
 * expansions), the local route is never touched, refreshTick reloads
 * through the provider, and the declared capabilities gate the local-only
 * surfaces (drag-drop upload, download / upload-here / open-with menu
 * entries, git decorations) — absent capabilities degrade them OFF.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import type { Context } from '../src/context-types.ts'
import type { FileTreeListResult, FileTreeProviderCapabilities } from '../src/client/file-tree-source.ts'
import type { GitRowStatus } from '../src/client/git-status.ts'
import type { UploadItem } from '../src/client/upload.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

// The LOCAL host route spy: remote-mode tests assert it is never called;
// the fallback test asserts it serves the local path.
const fsTreeMock = vi.hoisted(() => vi.fn())
vi.mock('../src/client/api.ts', () => ({
  api: { fsTree: fsTreeMock },
  downloadUrl: () => '/sidebar/file',
}))

beforeEach(() => {
  fsTreeMock.mockReset()
  fsTreeMock.mockResolvedValue({ entries: [{ name: 'local.txt', path: '/r/local.txt', isDir: false }] })
})

interface Harness {
  container: HTMLDivElement
  list: Mock<(dir: string) => Promise<FileTreeListResult>>
  uploads: { dir: string; items: UploadItem[] }[]
  rerender: (patch: Record<string, unknown>) => Promise<void>
  unmount: () => void
}

async function mountTree(options: {
  caps?: FileTreeProviderCapabilities
  listEntries?: Array<Record<string, unknown>>
  expanded?: string[]
  gitStatus?: ReadonlyMap<string, GitRowStatus>
  withProvider?: boolean
  providerMatches?: boolean
  ctx?: Context | undefined
} = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const uploads: { dir: string; items: UploadItem[] }[] = []
  const list = vi.fn()
  list.mockImplementation(async () => ({ entries: options.listEntries ?? [
    { name: 'a.txt', path: '/r/a.txt', isDir: false },
  ] }))
  // An explicit ctx wins; otherwise build one with (or without) a provider.
  let ctx = options.ctx
  if (ctx === undefined && options.withProvider !== false) {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerFileTreeProvider({
      id: 'remote',
      match: () => options.providerMatches !== false,
      createSource: () => ({ list }),
      capabilities: options.caps,
    })
    ctx = { betterSidebar: service } as unknown as Context
  }

  const props: Record<string, unknown> = {
    sessionId: 's1',
    cwd: '/r',
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
    // The open-with feature is wired (one target), so the file-row menu
    // actually renders the section when the capability is on.
    openWithTargets: [openWithVscode],
    onOpenWith: () => {},
  }
  const render = (patch: Record<string, unknown> = {}): void => {
    root.render(createElement(FileTree, { ...props, ...patch } as never))
  }
  await act(async () => { render() })
  return {
    container,
    list,
    uploads,
    rerender: async (patch: Record<string, unknown>) => { await act(async () => { render(patch) }) },
    unmount: () => { act(() => { root.unmount() }) },
  }
}

/** The file row of the one-level tree (role="button" with the name span). */
function rowNamed(container: HTMLDivElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** The workspace ROOT row (a plain div — no role="button" — labelled with
 *  the cwd's baseName, 'r' for cwd '/r'). */
function rootRow(container: HTMLDivElement): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === 'r')
  if (row === undefined) throw new Error('root row not found')
  return row
}

/** A bubbling drag event carrying a stub dataTransfer (jsdom has no DragEvent). */
function dragEvent(type: string, dataTypes: string[] = ['Files']): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    // No entry API on the items, so drops fall back to the flat file list.
    value: {
      types: dataTypes,
      items: [],
      files: [new File(['x'], 'dropped.txt')],
      dropEffect: '',
    },
  })
  return event
}

/** Dispatch inside act() so React flushes the state update. */
function fire(target: Element, type: string, dataTypes?: string[]): Event {
  const event = dragEvent(type, dataTypes)
  act(() => { target.dispatchEvent(event) })
  return event
}

const dropZone = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[class*="uploadDropZone"]')

const modified: GitRowStatus = { letter: 'M', kind: 'modified', deleted: false }

/** One open-with target the harness wires (so the menu section renders and
 *  its capability gate is actually exercised). */
const openWithVscode = {
  id: 'vscode',
  nameKey: 'openWithVscode',
  name: '',
  kind: 'url' as const,
  urlTemplate: 'vscode://file/{path}',
  isVscodeFamily: true,
  localOnly: false,
}

describe('FileTree with a registered data source provider', () => {
  let harness: Harness
  afterEach(() => {
    harness?.unmount()
    document.body.innerHTML = ''
  })

  it('lists the root and every expansion through the provider, never the local host', async () => {
    harness = await mountTree({ expanded: ['/r/sub'] })
    expect(harness.list).toHaveBeenCalledTimes(2)
    expect(harness.list).toHaveBeenCalledWith('/r')
    expect(harness.list).toHaveBeenCalledWith('/r/sub')
    expect(fsTreeMock).not.toHaveBeenCalled()
    expect(rowNamed(harness.container, 'a.txt')).toBeDefined()
  })

  it('provider rows carry the optional cosmetic fields with safe defaults', async () => {
    harness = await mountTree({
      listEntries: [
        { name: 'd', path: '/r/d', isDir: true, hidden: true },
        { name: 'plain', path: '/r/plain', isDir: false },
      ],
    })
    expect(rowNamed(harness.container, 'd')).toBeDefined()
    expect(rowNamed(harness.container, 'plain')).toBeDefined()
    // No symlink badge anywhere (isSymlink/broken omitted → false).
    expect(harness.container.querySelector('[class*="explorerSymlink"]')).toBeNull()
  })

  it('falls back to the local host when the session has no provider (or no ctx)', async () => {
    harness = await mountTree({ withProvider: false })
    expect(fsTreeMock).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/r' }, '/r')
    expect(harness.list).not.toHaveBeenCalled()
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
    harness.unmount()
    harness = await mountTree({ withProvider: false, ctx: { betterSidebar: undefined } as unknown as Context })
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
  })

  it('a provider whose match declines leaves the local host in charge', async () => {
    harness = await mountTree({ providerMatches: false })
    expect(fsTreeMock).toHaveBeenCalled()
    expect(harness.list).not.toHaveBeenCalled()
  })

  it('refreshTick bump wipes the cache and reloads the visible set through the provider', async () => {
    harness = await mountTree()
    expect(harness.list).toHaveBeenCalledTimes(1)
    await harness.rerender({ refreshTick: 1 })
    expect(harness.list).toHaveBeenCalledTimes(2)
    expect(harness.list).toHaveBeenLastCalledWith('/r')
  })

  it('a provider registered while the tree is mounted takes effect live (registry subscription)', async () => {
    // Mount with a service that has NO provider yet → the local host serves.
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    harness = await mountTree({ ctx: { betterSidebar: service } as unknown as Context })
    expect(fsTreeMock).toHaveBeenCalledTimes(1)
    // Register the provider; resolution re-runs and the visible set reloads
    // through the provider WITHOUT any refresh bump.
    act(() => {
      service.registerFileTreeProvider({
        id: 'remote',
        match: () => true,
        createSource: () => ({ list: (dir: string) => harness.list(dir) }),
        capabilities: {},
      })
    })
    await act(async () => { await Promise.resolve() })
    expect(harness.list).toHaveBeenCalledWith('/r')
    expect(fsTreeMock).toHaveBeenCalledTimes(1)
  })

  it('renders a provider listing error as the level error row', async () => {
    harness = await mountTree()
    harness.list.mockResolvedValue({ error: 'boom-remote' })
    await harness.rerender({ refreshTick: 1 })
    expect(harness.container.textContent).toContain('boom-remote')
  })

  describe('capability degradation (absent capabilities = off)', () => {
    it('upload: drag-drop is inert (no drop zone, no upload request, drop passes through)', async () => {
      harness = await mountTree({ caps: {} })
      const body = harness.container.firstElementChild as HTMLElement
      fire(body, 'dragenter')
      expect(dropZone()).toBeNull()
      fire(body, 'drop')
      expect(harness.uploads).toEqual([])
      fire(rowNamed(harness.container, 'a.txt'), 'dragenter')
      expect(dropZone()).toBeNull()
      fire(rowNamed(harness.container, 'a.txt'), 'drop')
      expect(harness.uploads).toEqual([])
    })

    it('upload: the upload-here context entry is hidden (dir/root rows)', async () => {
      harness = await mountTree({ caps: {} })
      // The root row's context menu.
      act(() => { rootRow(harness.container)
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) })
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      expect(items.map(item => item.textContent?.trim())).not.toContain('Upload here')
    })

    it('download + open-with: the file-row entries are hidden', async () => {
      harness = await mountTree({ caps: {} })
      act(() => { rowNamed(harness.container, 'a.txt')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) })
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      expect(items.map(item => item.textContent?.trim())).not.toContain('Download')
      expect(items.some(item => item.textContent?.includes('Open with'))).toBe(false)
    })

    it('git: a caller-supplied status map is ignored (no badges)', async () => {
      harness = await mountTree({ caps: {}, gitStatus: new Map([['/r/a.txt', modified]]) })
      expect(harness.container.querySelector('[class*="explorerGitBadge"]')).toBeNull()
    })
  })

  describe('declared capabilities keep the surfaces', () => {
    it('upload: drag-drop reports through onUploadRequest', async () => {
      harness = await mountTree({ caps: { upload: true } })
      const body = harness.container.firstElementChild as HTMLElement
      fire(body, 'dragenter')
      expect(dropZone()).not.toBeNull()
      fire(body, 'drop')
      // The upload request rides uploadItemsFromDrop(...).then — flush the
      // microtask chain before asserting.
      await act(async () => { await Promise.resolve() })
      expect(harness.uploads).toHaveLength(1)
      expect(harness.uploads[0]!.dir).toBe('/r')
    })

    it('upload: the upload-here entry appears on dir/root rows', async () => {
      harness = await mountTree({ caps: { upload: true } })
      act(() => { rootRow(harness.container)
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) })
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      expect(items.map(item => item.textContent?.trim())).toContain('Upload here')
    })

    it('download + open-with: the file-row entries are present and functional', async () => {
      harness = await mountTree({ caps: { download: true, openWith: true } })
      act(() => { rowNamed(harness.container, 'a.txt')
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) })
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      expect(items.map(item => item.textContent?.trim())).toContain('Download')
      expect(items.some(item => item.textContent?.includes('Open with'))).toBe(true)
    })

    it('git: a caller-supplied status map renders badges', async () => {
      harness = await mountTree({ caps: { git: true }, gitStatus: new Map([['/r/a.txt', modified]]) })
      const badge = harness.container.querySelector('[class*="explorerGitBadge"]')
      expect(badge).not.toBeNull()
      expect(badge!.textContent).toBe('M')
    })
  })
})