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
import { FileTree, fileMetaTime, humanFileSize, metaSuffixCramped, metaSuffixFits } from '../src/client/FileTree.tsx'
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

  describe('level loading indicator (v0.20.0)', () => {
    it('an expansion whose listing is in flight renders a loading row; the listing lands → children replace it', async () => {
      let release!: (level: FileTreeListResult) => void
      const subListing = new Promise<FileTreeListResult>(resolve => { release = resolve })
      harness = await mountTree({
        listEntries: [
          { name: 'sub', path: '/r/sub', isDir: true },
          { name: 'a.txt', path: '/r/a.txt', isDir: false },
        ],
      })
      harness.list.mockImplementation((dir: string) =>
        dir === '/r/sub'
          ? subListing
          : Promise.resolve({ entries: [{ name: 'sub', path: '/r/sub', isDir: true }] }),
      )
      await harness.rerender({ expanded: ['/r/sub'] })
      // The spinning glyph (its class also contains "explorerLoading" — the
      // label span matches too, so the SVG is the precise target).
      const spinner = harness.container.querySelector('[class*="explorerLoadingSpin"]')
      expect(spinner).not.toBeNull()
      // The status row carrying it shows the localized loading label.
      const loading = spinner?.closest('[role="status"]')
      expect(loading).not.toBeNull()
      expect(loading?.textContent).toContain('Loading')
      await act(async () => {
        release({ entries: [{ name: 'x.txt', path: '/r/sub/x.txt', isDir: false }] })
        await subListing
      })
      expect(harness.container.querySelector('[class*="explorerLoading"]')).toBeNull()
      expect(rowNamed(harness.container, 'x.txt')).toBeDefined()
    })

    it('a loaded EMPTY level renders nothing — only in-flight listings show the loading row', async () => {
      harness = await mountTree({
        listEntries: [{ name: 'empty', path: '/r/empty', isDir: true }],
      })
      harness.list.mockImplementation((dir: string) =>
        dir === '/r/empty'
          ? Promise.resolve({ entries: [] })
          : Promise.resolve({ entries: [{ name: 'empty', path: '/r/empty', isDir: true }] }),
      )
      await harness.rerender({ expanded: ['/r/empty'] })
      expect(harness.container.querySelector('[class*="explorerLoading"]')).toBeNull()
    })
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

  describe('file-row open delegation (v0.20.0)', () => {
    it('click AND Enter/Space delegate to source.open when capabilities.open is declared', async () => {
      const open = vi.fn()
      const list = vi.fn(async () => ({ entries: [{ name: 'a.txt', path: '/r/a.txt', isDir: false }] }))
      const store = createSidebarStore()
      const service = createBetterSidebarService(store)
      service.registerFileTreeProvider({
        id: 'remote',
        match: () => true,
        createSource: () => ({ list, open }),
        capabilities: { open: true },
      })
      harness = await mountTree({ ctx: { betterSidebar: service } as unknown as Context })
      const opens: string[] = []
      await harness.rerender({ onOpenFile: (path: string) => { opens.push(path) } })
      // Click: the provider owns the open.
      act(() => { rowNamed(harness.container, 'a.txt')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
      expect(open).toHaveBeenCalledWith('/r/a.txt')
      expect(opens).toEqual([])
      // Enter: same delegation.
      act(() => { rowNamed(harness.container, 'a.txt')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
      expect(open).toHaveBeenCalledTimes(2)
      // Space: same delegation.
      act(() => { rowNamed(harness.container, 'a.txt')
        .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })) })
      expect(open).toHaveBeenCalledTimes(3)
      expect(opens).toEqual([])
    })

    it('WITHOUT the declared capability the caller onOpenFile keeps running; a declared capability without source.open too', async () => {
      const list = vi.fn(async () => ({ entries: [{ name: 'a.txt', path: '/r/a.txt', isDir: false }] }))
      const opens: string[] = []
      // Capability absent → the original path.
      let service = createBetterSidebarService(createSidebarStore())
      service.registerFileTreeProvider({ id: 'remote', match: () => true, createSource: () => ({ list }), capabilities: {} })
      harness = await mountTree({ ctx: { betterSidebar: service } as unknown as Context })
      await harness.rerender({ onOpenFile: (path: string) => { opens.push(path) } })
      act(() => { rowNamed(harness.container, 'a.txt')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
      expect(opens).toEqual(['/r/a.txt'])
      // Capability declared but the source provides no open() → the
      // original path still runs (the delegation is capability AND
      // function gated).
      harness.unmount()
      document.body.innerHTML = ''
      service = createBetterSidebarService(createSidebarStore())
      service.registerFileTreeProvider({ id: 'remote', match: () => true, createSource: () => ({ list }), capabilities: { open: true } })
      harness = await mountTree({ ctx: { betterSidebar: service } as unknown as Context })
      await harness.rerender({ onOpenFile: (path: string) => { opens.push(path) } })
      act(() => { rowNamed(harness.container, 'a.txt')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
      expect(opens).toEqual(['/r/a.txt', '/r/a.txt'])
    })
  })

  describe('row stat suffix (v0.20.0)', () => {
    it('provider rows carry the dimmed size/mtime suffix; rows without meta never do', async () => {
      harness = await mountTree({
        listEntries: [
          { name: 'big.bin', path: '/r/big.bin', isDir: false, meta: { size: 3565158, mtime: new Date(2026, 8, 6, 14, 30).getTime() } },
          { name: 'tiny.txt', path: '/r/tiny.txt', isDir: false, meta: { size: 42 } },
          { name: 'plain', path: '/r/plain', isDir: false },
        ],
      })
      expect(rowNamed(harness.container, 'big.bin').querySelector('[class*="explorerMeta"]')?.textContent)
        .toBe('3.4 MB 9-6 14:30')
      expect(rowNamed(harness.container, 'tiny.txt').querySelector('[class*="explorerMeta"]')?.textContent)
        .toBe('42 B')
      expect(rowNamed(harness.container, 'plain').querySelector('[class*="explorerMeta"]')).toBeNull()
    })

    it('display priority: a cramped row (name truncated) drops its suffix; room brings it back', async () => {
      harness = await mountTree({
        listEntries: [
          { name: 'big.bin', path: '/r/big.bin', isDir: false, meta: { size: 3565158, mtime: new Date(2026, 8, 6, 14, 30).getTime() } },
          { name: 'tiny.txt', path: '/r/tiny.txt', isDir: false, meta: { size: 42 } },
          { name: 'pkg', path: '/r/pkg', isDir: true, meta: { mtime: new Date(2026, 8, 6, 14, 30).getTime() } },
        ],
      })
      const row = rowNamed(harness.container, 'big.bin')
      const name = row.querySelector<HTMLElement>('[class*="explorerName"]')!
      // Cramped: the name span is clipped (scrollWidth > clientWidth) —
      // jsdom has no layout, so the geometry is injected like
      // tab-bar-wheel.spec.tsx does.
      Object.defineProperty(name, 'scrollWidth', { value: 500, configurable: true })
      Object.defineProperty(name, 'clientWidth', { value: 120, configurable: true })
      // The directory row follows the same priority (dirs may carry meta too).
      const dirRow = rowNamed(harness.container, 'pkg')
      const dirName = dirRow.querySelector<HTMLElement>('[class*="explorerName"]')!
      Object.defineProperty(dirName, 'scrollWidth', { value: 300, configurable: true })
      Object.defineProperty(dirName, 'clientWidth', { value: 100, configurable: true })
      await harness.rerender({})
      expect(rowNamed(harness.container, 'big.bin').querySelector('[class*="explorerMeta"]')).toBeNull()
      expect(rowNamed(harness.container, 'pkg').querySelector('[class*="explorerMeta"]')).toBeNull()
      // Unaffected rows (plenty of room, name at full width) keep theirs.
      expect(rowNamed(harness.container, 'tiny.txt').querySelector('[class*="explorerMeta"]')?.textContent)
        .toBe('42 B')
      // The name fits again and the row has room right of it: the suffix
      // re-shows (re-rendering with the suffix must not re-cramp the row).
      Object.defineProperty(name, 'scrollWidth', { value: 120, configurable: true })
      Object.defineProperty(name, 'clientWidth', { value: 120, configurable: true })
      Object.defineProperty(name, 'offsetLeft', { value: 40, configurable: true })
      Object.defineProperty(row, 'clientWidth', { value: 400, configurable: true })
      await harness.rerender({})
      expect(rowNamed(harness.container, 'big.bin').querySelector('[class*="explorerMeta"]')?.textContent)
        .toBe('3.4 MB 9-6 14:30')
    })

    it('display priority: a still-truncated name never re-shows the suffix, whatever the row width', async () => {
      harness = await mountTree({
        listEntries: [
          { name: 'long-name-file-here.txt', path: '/r/long-name-file-here.txt', isDir: false, meta: { size: 42 } },
        ],
      })
      const row = rowNamed(harness.container, 'long-name-file-here.txt')
      const name = row.querySelector<HTMLElement>('[class*="explorerName"]')!
      Object.defineProperty(name, 'scrollWidth', { value: 500, configurable: true })
      Object.defineProperty(name, 'clientWidth', { value: 120, configurable: true })
      await harness.rerender({})
      expect(rowNamed(harness.container, 'long-name-file-here.txt').querySelector('[class*="explorerMeta"]')).toBeNull()
      // A wide row still cannot host the suffix while the name is clipped.
      Object.defineProperty(row, 'clientWidth', { value: 800, configurable: true })
      await harness.rerender({})
      expect(rowNamed(harness.container, 'long-name-file-here.txt').querySelector('[class*="explorerMeta"]')).toBeNull()
    })

    it('local (no-provider) rows never render the suffix — the default listing has no meta', async () => {
      harness = await mountTree({ withProvider: false })
      expect(rowNamed(harness.container, 'local.txt').querySelector('[class*="explorerMeta"]')).toBeNull()
    })
  })

  describe('stat suffix formatters (v0.20.0, pure)', () => {
    it('humanFileSize: bytes under 1024, one-decimal KB/MB/GB above', () => {
      expect(humanFileSize(0)).toBe('0 B')
      expect(humanFileSize(42)).toBe('42 B')
      expect(humanFileSize(1023)).toBe('1023 B')
      expect(humanFileSize(1024)).toBe('1.0 KB')
      expect(humanFileSize(1228)).toBe('1.2 KB')
      expect(humanFileSize(3565158)).toBe('3.4 MB')
      expect(humanFileSize(4 * 1024 * 1024 * 1024)).toBe('4.0 GB')
      expect(humanFileSize(Number.NaN)).toBe('')
      expect(humanFileSize(-1)).toBe('')
    })

    it('fileMetaTime: compact local M-D hh:mm with zero padding', () => {
      expect(fileMetaTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe('1-2 03:04')
      expect(fileMetaTime(new Date(2026, 8, 6, 14, 30).getTime())).toBe('9-6 14:30')
    })

    it('metaSuffixCramped: the name is squeezed only when its rendered width falls short', () => {
      expect(metaSuffixCramped(101, 100)).toBe(true)
      expect(metaSuffixCramped(100, 100)).toBe(false)
      expect(metaSuffixCramped(0, 0)).toBe(false)
    })

    it('metaSuffixFits: a fitting name plus free room ≥ suffix width + margin', () => {
      // Free space right of the name = rowClient − (nameOffset + nameClient).
      expect(metaSuffixFits(100, 100, 400, 40, 80)).toBe(true)   // free 260 ≥ 92
      expect(metaSuffixFits(100, 100, 200, 40, 80)).toBe(false)  // free 60 < 92
      expect(metaSuffixFits(100, 100, 400, 40, 300)).toBe(false) // suffix alone too wide
      expect(metaSuffixFits(150, 100, 400, 40, 80)).toBe(false)  // name still truncated
      expect(metaSuffixFits(100, 100, 112, 0, 0)).toBe(true)    // free 12 — the exact margin
      expect(metaSuffixFits(100, 100, 111, 0, 0)).toBe(false)   // free 11 — one px short
    })
  })
})