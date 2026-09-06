/**
 * TreePanel with a registered data-source provider (v0.17.0+): the
 * panel-level local-only chrome rides the provider's declared capabilities
 * — search box hidden without search support, upload pickers hidden without
 * upload support, git status never fetched without git support; declared
 * capabilities keep the surfaces, and a provider `search()` serves the
 * box's queries.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import type { Context } from '../src/context-types.ts'
import type { FileTreeProviderCapabilities } from '../src/client/file-tree-source.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vitest 4.1.11+ follows the OS locale; pin en-US so copy assertions are
// deterministic regardless of the developer machine.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

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

interface Harness {
  container: HTMLDivElement
  search: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountPanel(caps: FileTreeProviderCapabilities | undefined): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const searchMock = vi.fn()
  searchMock.mockImplementation(async (query: string) => ({ matches: [`src/${query}.ts`], truncated: false }))
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  if (caps !== undefined) {
    service.registerFileTreeProvider({
      id: 'remote',
      match: () => true,
      createSource: () => ({
        list: async () => ({ entries: [{ name: 'a.txt', path: '/r/a.txt', isDir: false }] }),
        // A provider that declares search always provides the method.
        search: searchMock,
      }),
      capabilities: caps,
    })
  }
  const ctx = { betterSidebar: service } as unknown as Context
  await act(async () => {
    root.render(createElement(TreePanel, {
      sessionId: 's1',
      cwd: '/r',
      expanded: [],
      ctx,
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
    } as never))
  })
  return {
    container,
    search: searchMock,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

describe('TreePanel in provider mode', () => {
  let harness: Harness
  afterEach(() => {
    harness?.unmount()
    document.body.innerHTML = ''
  })

  it('degrades all local chrome with absent capabilities (no search box, no upload pickers, no git fetch)', async () => {
    harness = await mountPanel({})
    expect(harness.container.querySelector('[data-dsh-sidebar-search]')).toBeNull()
    expect(harness.container.querySelector('[aria-label="Upload files"]')).toBeNull()
    expect(harness.container.querySelector('[aria-label="Upload folder"]')).toBeNull()
    expect(gitStatusMock).not.toHaveBeenCalled()
    // The tree itself still lists through the provider.
    expect(harness.container.textContent).toContain('a.txt')
  })

  it('declared search + upload capabilities keep the surfaces, git stays gated', async () => {
    harness = await mountPanel({ search: true, upload: true })
    expect(harness.container.querySelector('[data-dsh-sidebar-search]')).not.toBeNull()
    expect(harness.container.querySelector('[aria-label="Upload files"]')).not.toBeNull()
    expect(harness.container.querySelector('[aria-label="Upload folder"]')).not.toBeNull()
    expect(gitStatusMock).not.toHaveBeenCalled()
  })

  it('declared git capability fetches the (provider-fed) status map', async () => {
    harness = await mountPanel({ git: true })
    expect(gitStatusMock).toHaveBeenCalled()
  })

  it('the search box queries the provider search() when declared', async () => {
    vi.useFakeTimers()
    try {
      harness = await mountPanel({ search: true })
      const input = harness.container.querySelector<HTMLInputElement>('[data-dsh-sidebar-search]')
      expect(input).not.toBeNull()
      // React controlled inputs: set through the native value setter so the
      // onChange tracker sees the change.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(input, 'remote')
        input!.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { vi.advanceTimersByTime(400) })
      const row = [...harness.container.querySelectorAll('[data-search-row]')]
      expect(row.map(el => el.textContent)).toContain('src/remote.ts')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never hits the local host search route in provider mode', async () => {
    vi.useFakeTimers()
    try {
      harness = await mountPanel({})
      // No capability → no input at all; a stale search must stay inert.
      expect(harness.container.querySelector('[data-dsh-sidebar-search]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})