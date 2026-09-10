/**
 * TreePanel git decorations: the explorer fetches git status per session and
 * renders VSCode-style letter badges on file rows (M/A/D/U…), aggregates the
 * status onto folder rows, dims + strikes deleted files, and shows a change
 * count footer. The fetch re-runs on the refresh button AND on the shared
 * git-status change bus (bumped by the git panel after stage/commit/discard),
 * so the two surfaces stay in sync without a file watcher.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { api, type FsEntry, type GitStatusResult } from '../src/client/api.ts'
import { notifyGitStatusChanged } from '../src/client/git-status.ts'
import { TreePanel } from '../src/client/TreePanel.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileTreeProviderDescriptor } from '../src/client/file-tree-source.ts'
import type { GitDataSource } from '../src/client/git-source.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const file = (name: string, path: string): FsEntry =>
  ({ name, path, isDir: false, hidden: false, isSymlink: false, broken: false })
const dir = (name: string, path: string): FsEntry =>
  ({ name, path, isDir: true, hidden: false, isSymlink: false, broken: false })

/** The status snapshot: a.ts modified, gone.ts deleted, src/new.ts untracked. */
const STATUS: GitStatusResult = {
  isRepo: true, branch: 'main', root: '/repo',
  entries: [
    { path: 'a.ts', xy: ' M' },
    { path: 'gone.ts', xy: ' D' },
    { path: 'src/new.ts', xy: '??' },
  ],
}

/**
 * The tree's expansion set lives in the CALLER (the host owns it in the real
 * app) — a tiny stateful wrapper mirrors that contract so a row click really
 * expands the folder.
 */
function Harness(props: Partial<Parameters<typeof TreePanel>[0]>) {
  const [expanded, setExpanded] = useState<string[]>([])
  return createElement(TreePanel, {
    full: true,
    sessionId: 's',
    cwd: '/repo',
    expanded,
    onToggle: (path: string) => {
      setExpanded(current => current.includes(path) ? current.filter(p => p !== path) : [...current, path])
    },
    onOpenFile: () => {},
    onReferenceFile: () => {},
    ...props,
  })
}

function mountTree(props: Partial<Parameters<typeof TreePanel>[0]> = {}): {
  container: HTMLDivElement
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(Harness, props)) })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

beforeEach(() => { vi.restoreAllMocks() })

describe('TreePanel git decorations', () => {
  it('renders status badges + tinted names on rows, aggregates folders, strikes deleted files, and shows counts', async () => {
    vi.spyOn(api, 'fsTree').mockImplementation(async (_scope, path) => {
      if (path === '/repo') return { path, entries: [file('a.ts', '/repo/a.ts'), file('gone.ts', '/repo/gone.ts'), dir('src', '/repo/src')], truncated: false }
      if (path === '/repo/src') return { path, entries: [file('new.ts', '/repo/src/new.ts')], truncated: false }
      return { path, entries: [], truncated: false }
    })
    vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    const { container, unmount } = mountTree()
    try {
      // The a.ts row carries the Modified badge AND a warn-tinted NAME (the
      // primary VSCode signal — the label itself changes color).
      await vi.waitFor(() => expect(container.querySelector('[title="Modified"]')).not.toBeNull())
      const modified = container.querySelector<HTMLElement>('[title="Modified"]')!
      expect(modified.textContent).toBe('M')
      // Its parent row is the a.ts row (title = path, not broken).
      const modifiedRow = modified.parentElement!
      expect(modifiedRow.getAttribute('title')).toBe('/repo/a.ts')
      const modifiedName = modifiedRow.querySelector<HTMLElement>('[class*="explorerName"]')!
      expect(modifiedName.className).toContain('explorerGitWarn')

      // The gone.ts row is the Deleted badge, struck through + error-tinted
      // (the CSS-module class keeps the `explorerDeleted` local name).
      const deleted = container.querySelector<HTMLElement>('[title="Deleted"]')!
      expect(deleted.textContent).toBe('D')
      const deletedRow = deleted.parentElement!
      expect(deletedRow.className).toContain('explorerDeleted')
      const deletedName = deletedRow.querySelector<HTMLElement>('[class*="explorerName"]')!
      expect(deletedName.className).toContain('explorerGitError')

      // The src FOLDER aggregates the untracked new.ts → U badge + a
      // success-tinted (green) folder name.
      const untracked = container.querySelector<HTMLElement>('[title="Untracked"]')!
      expect(untracked.textContent).toBe('U')
      const srcRow = untracked.parentElement!
      expect(srcRow.className).toContain('explorerDir')
      const srcName = srcRow.querySelector<HTMLElement>('[class*="explorerName"]')!
      expect(srcName.className).toContain('explorerGitSuccess')

      // Expanding src reveals new.ts with its own U badge (now two: the
      // folder row + the file row).
      act(() => { srcRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await vi.waitFor(() =>
        expect(container.querySelectorAll('[title="Untracked"]')).toHaveLength(2))
      const rows = [...container.querySelectorAll<HTMLElement>('[title="Untracked"]')]
      const titles = rows.map(row => row.parentElement?.getAttribute('title'))
      // One sits on the file row (title = its path)…
      expect(titles).toContain('/repo/src/new.ts')
      // …the other on the src FOLDER row, which carries no title attribute.
      expect(titles.filter(title => title === null)).toHaveLength(1)

      // The footer summarizes the changed files (M1 · D1 · U1, severe first).
      const footer = container.querySelector<HTMLElement>('[title^="Git status"]')!
      expect(footer.textContent).toBe('M1D1U1')
    } finally {
      unmount()
    }
  })

  it('re-fetches status on the refresh button and on the shared change bus', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({ path: '/repo', entries: [], truncated: false })
    const gitStatus = vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    const { container, unmount } = mountTree()
    try {
      await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1))
      // The git panel staged/committed → the bus recolors the explorer. The
      // fetch starts synchronously; flush the status promise inside act.
      act(() => { notifyGitStatusChanged() })
      await act(async () => {})
      expect(gitStatus).toHaveBeenCalledTimes(2)
      // The explorer's own refresh button bumps both the tree and the status.
      act(() => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {})
      expect(gitStatus).toHaveBeenCalledTimes(3)
      expect(vi.mocked(api.fsTree)).toHaveBeenCalledTimes(2)
    } finally {
      unmount()
    }
  })

  it('never fetches git status without a tree root (no-session placeholder)', async () => {
    const gitStatus = vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    const { container, unmount } = mountTree({ cwd: undefined })
    try {
      expect(container.innerHTML).toContain('Select a conversation')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(gitStatus).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('renders a clean tree when the session is not a repository (no badges, no footer)', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({
      path: '/repo', entries: [file('a.ts', '/repo/a.ts')], truncated: false,
    })
    vi.spyOn(api, 'gitStatus').mockResolvedValue({ isRepo: false, entries: [] })
    const { container, unmount } = mountTree()
    try {
      await vi.waitFor(() =>
        expect(container.querySelector('[data-dsh-sidebar-search]')).not.toBeNull())
      // Give the status promise a tick to settle, then assert nothing appeared.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(container.querySelector('[title^="Git status"]')).toBeNull()
      expect(container.querySelector('[class*="explorerGitBadge"]')).toBeNull()
    } finally {
      unmount()
    }
  })

  describe('git data-source provider sessions (feature gitSource, v0.23.0+)', () => {
    const ctxOf = (): Parameters<typeof TreePanel>[0]['ctx'] => {
      const service = createBetterSidebarService(createSidebarStore())
      return { betterSidebar: service } as unknown as NonNullable<Parameters<typeof TreePanel>[0]['ctx']>
    }

    /** A single-source file-tree provider owning this session: the tree rows
     *  carry REMOTE paths ('/remote-root/…'), so the local host git.status
     *  can never describe them — the git provider's status snapshot must. */
    const treeProvider = (capabilities: FileTreeProviderDescriptor['capabilities']): FileTreeProviderDescriptor => ({
      id: 'remote',
      match: (sessionId, cwd) => sessionId === 's' && cwd === '/p',
      createSource: () => ({
        list: async (dir: string) =>
          dir === '/p' ? { entries: [file('a.ts', '/remote-root/a.ts')] } : { entries: [] },
      }),
      capabilities,
    })

    const providerStatus = (root = '/remote-root'): GitStatusResult => ({
      isRepo: true,
      branch: 'main',
      root,
      entries: [{ path: 'a.ts', xy: ' M' }],
    })

    const gitSource = (gitStatus: GitDataSource['gitStatus']): GitDataSource => ({
      gitStatus,
      gitWorktrees: async () => [],
      gitBranch: async () => ({ current: 'main', names: [] }),
      gitBranchStatus: async () => ({ upstream: undefined, ahead: 0, behind: 0, gone: false }),
      gitBranchTips: async () => ({ tips: [] }),
      gitLogGraph: async () => [],
      gitDiff: async () => ({ diff: '' }),
      gitCommitDiff: async () => ({ diff: '' }),
      gitStage: async () => ({ ok: true }),
      gitUnstage: async () => ({ ok: true }),
      gitCommit: async () => ({ ok: true }),
      gitCheckout: async () => ({ ok: true }),
      gitFetch: async () => ({ ok: true }),
      gitDiscard: async () => ({ ok: true }),
      gitRevert: async () => ({ ok: true }),
      gitCherryPick: async () => ({ ok: true }),
    })

    it('decorates remote rows from the git provider when the tree provider declared git support', async () => {
      const ctx = ctxOf()
      const service = ctx!.betterSidebar
      service.registerFileTreeProvider(treeProvider({ git: true }))
      const gitStatus = vi.fn(async () => providerStatus())
      vi.spyOn(api, 'gitStatus') // must never be reached: the git provider owns the data
      service.registerGitProvider({
        id: 'remote-git',
        match: () => true,
        createSource: () => gitSource(gitStatus),
      })
      const { container, unmount } = mountTree({ sessionId: 's', cwd: '/p', ctx })
      try {
        await vi.waitFor(() => expect(gitStatus).toHaveBeenCalled())
        await vi.waitFor(() => expect(container.querySelector('[title="Modified"]')).not.toBeNull())
        const modified = container.querySelector<HTMLElement>('[title="Modified"]')!
        expect(modified.textContent).toBe('M')
        expect(modified.parentElement?.getAttribute('title')).toBe('/remote-root/a.ts')
        // The provider's own status root scopes the overlay: the fetch goes
        // through the git source, never the local host route.
        expect(api.gitStatus).not.toHaveBeenCalled()
      } finally {
        unmount()
      }
    })

    it('keeps the tree clean when the file-tree provider did not declare git support', async () => {
      const ctx = ctxOf()
      const service = ctx!.betterSidebar
      service.registerFileTreeProvider(treeProvider(undefined))
      const gitStatus = vi.fn(async () => providerStatus())
      service.registerGitProvider({
        id: 'remote-git',
        match: () => true,
        createSource: () => gitSource(gitStatus),
      })
      const { container, unmount } = mountTree({ sessionId: 's', cwd: '/p', ctx })
      try {
        // The provider row renders (single-source takeover serves the
        // listing); the git capability gate is closed: no fetch, no badges,
        // no footer.
        await vi.waitFor(() =>
          expect(container.querySelector('[title="/remote-root/a.ts"]')).not.toBeNull())
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(gitStatus).not.toHaveBeenCalled()
        expect(container.querySelector('[title^="Git status"]')).toBeNull()
        expect(container.querySelector('[class*="explorerGitBadge"]')).toBeNull()
      } finally {
        unmount()
      }
    })

    it('falls back to the host route when git support is declared but no git provider matches', async () => {
      const ctx = ctxOf()
      const service = ctx!.betterSidebar
      service.registerFileTreeProvider(treeProvider({ git: true }))
      const hostStatus = vi.spyOn(api, 'gitStatus').mockResolvedValue(providerStatus())
      const { container, unmount } = mountTree({ sessionId: 's', cwd: '/p', ctx })
      try {
        await vi.waitFor(() => expect(hostStatus).toHaveBeenCalled())
        expect(container.querySelector('[title^="Git status"]')).toBeNull()
      } finally {
        unmount()
      }
    })
  })
})
