/**
 * The Git panel's changed-file list layouts: the default TREE view groups
 * the entries under collapsible directory rows (subtree counts; files stay
 * hidden until their folder expands), the header toggle switches to the
 * FLAT one-row-per-file list (full paths) and back, the choice persists in
 * the git tab's pluginSettings blob, and a persisted 'flat' wins on mount.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitView } from '../src/client/GitView.tsx'
import { api, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../src/prefs-shared.ts'
import type { SidebarStore } from '../src/client/state.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const REPO = 'C:/repo/main'

const inventory: GitWorktree[] = [
  { path: REPO, branch: 'main', current: true, changes: 0 },
]

function statusWith(paths: Array<{ path: string; xy: string }>): GitStatusResult {
  return { isRepo: true, branch: 'main', entries: paths }
}

/** A minimal store: prefs drive the persisted layout choice. */
function fakeStore(prefs: SidebarPrefs): SidebarStore {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ prefs }),
    getPrefs: () => prefs,
    setPrefs: () => {},
    reduce: () => {},
  } as unknown as SidebarStore
}

function prefsWith(blob: Record<string, unknown> | undefined): SidebarPrefs {
  return { ...SIDEBAR_PREFS_DEFAULTS, pluginSettings: blob === undefined ? {} : { git: blob } }
}

/** Mock the whole git api for one deterministic status. */
function mockApi(status: GitStatusResult): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue(inventory)
  vi.spyOn(api, 'gitStatus').mockResolvedValue(status)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitBranchStatus').mockResolvedValue({ upstream: undefined, ahead: 0, behind: 0, gone: false })
  vi.spyOn(api, 'gitLogGraph').mockResolvedValue([])
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  })
}

function mountView(prefs: SidebarPrefs | undefined): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(GitView, {
      scope: { sessionId: 'tree-session', cwd: REPO },
      store: prefs === undefined ? undefined : fakeStore(prefs),
      onOpenFile: () => {},
      onOpenDiff: () => {},
      visible: true,
    }))
  })
  return { container, root }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('GitView changed-file tree layout', () => {
  it('groups entries under collapsible directory rows by default (files hidden until expanded)', async () => {
    mockApi(statusWith([
      { path: 'src/a.ts', xy: ' M' },
      { path: 'src/b.ts', xy: ' M' },
      { path: 'src/sub/c.ts', xy: ' M' },
      { path: 'README.md', xy: ' M' },
      { path: 'lib/one.ts', xy: 'M ' }, // staged → its own tree in the staged section
    ]))
    const view = mountView(undefined)
    try {
      await flushEffects()
      // Directory rows: 'src' (count 3, unstaged) and 'lib' (count 1,
      // staged — the staged section renders first). Their files are NOT
      // rendered while collapsed; only the root file stays a plain row.
      const counts = view.container.querySelectorAll('[class*="gitTreeDirCount"]')
      expect(counts).toHaveLength(2)
      expect([...counts].map(el => el.textContent).sort()).toEqual(['1', '3'])
      expect(view.container.querySelector('button[title="src"]')).not.toBeNull()
      expect(view.container.querySelector('button[title="lib"]')).not.toBeNull()
      expect(view.container.textContent).toContain('README.md')
      expect(view.container.textContent).not.toContain('src/a.ts')
      expect(view.container.textContent).not.toContain('b.ts')
    } finally {
      act(() => { view.root.unmount() })
      view.container.remove()
    }
  })

  it('expands a directory row on click (subdirectories stay collapsed) and collapses again', async () => {
    mockApi(statusWith([
      { path: 'src/a.ts', xy: ' M' },
      { path: 'src/b.ts', xy: ' M' },
      { path: 'src/sub/c.ts', xy: ' M' },
    ]))
    const view = mountView(undefined)
    try {
      await flushEffects()
      const dirRow = view.container.querySelector('button[title="src"]') as HTMLButtonElement
      act(() => { dirRow.click() })
      await flushEffects()
      expect(view.container.textContent).toContain('a.ts')
      expect(view.container.textContent).toContain('b.ts')
      // The nested directory stays collapsed: its file is still hidden.
      expect(view.container.querySelector('button[title="src/sub"]')).not.toBeNull()
      expect(view.container.textContent).not.toContain('c.ts')
      // A second click collapses the directory again.
      act(() => { (view.container.querySelector('button[title="src"]') as HTMLButtonElement).click() })
      await flushEffects()
      expect(view.container.textContent).not.toContain('a.ts')
    } finally {
      act(() => { view.root.unmount() })
      view.container.remove()
    }
  })

  it('the header toggle switches to the flat list (full paths) and back, and persists the choice', async () => {
    mockApi(statusWith([
      { path: 'src/a.ts', xy: ' M' },
      { path: 'README.md', xy: ' M' },
    ]))
    const settingsUpdate = vi.spyOn(api, 'settingsUpdate')
      .mockResolvedValue({ value: prefsWith({ fileList: 'flat' }) } as never)
    const view = mountView(prefsWith(undefined))
    try {
      await flushEffects()
      // Flat: one row per file with the full path, no directory rows.
      const toggle = view.container.querySelector('button[aria-label="Flat view"]') as HTMLButtonElement
      act(() => { toggle.click() })
      await flushEffects()
      expect(view.container.querySelector('[class*="gitTreeDirCount"]')).toBeNull()
      expect(view.container.textContent).toContain('src/a.ts')
      expect(view.container.textContent).toContain('README.md')
      // The choice landed in the git descriptor's pluginSettings blob.
      const patch = settingsUpdate.mock.calls[0]![0] as { pluginSettings: Record<string, Record<string, unknown>> }
      expect(patch.pluginSettings.git?.fileList).toBe('flat')
      // Back to the tree: the directory row returns and its files hide again.
      act(() => { (view.container.querySelector('button[aria-label="Tree view"]') as HTMLButtonElement).click() })
      await flushEffects()
      expect(view.container.querySelector('button[title="src"]')).not.toBeNull()
      expect(view.container.textContent).not.toContain('src/a.ts')
    } finally {
      act(() => { view.root.unmount() })
      view.container.remove()
    }
  })

  it('a persisted flat layout in the pluginSettings blob wins on mount', async () => {
    mockApi(statusWith([
      { path: 'src/a.ts', xy: ' M' },
      { path: 'README.md', xy: ' M' },
    ]))
    const view = mountView(prefsWith({ fileList: 'flat' }))
    try {
      await flushEffects()
      expect(view.container.querySelector('[class*="gitTreeDirCount"]')).toBeNull()
      expect(view.container.textContent).toContain('src/a.ts')
    } finally {
      act(() => { view.root.unmount() })
      view.container.remove()
    }
  })
})