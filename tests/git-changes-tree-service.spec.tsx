/**
 * The changes tree through the optional fileTreeUi v2 service (provider:
 * dsh-file-tree-ui) — the SAME framework the explorer renders through, so
 * both trees in the panel share one row language.
 *
 * What this spec pins:
 * - with a v2 service that declares the `rowContextMenu` capability, each
 *   group's rows render through the provider's FileTree: the row root is the
 *   framework's div (not the built-in `button[data-dir]`), `aria-expanded`
 *   comes from the model, and the tab's own identity hooks (`data-dir` /
 *   `data-path`) ride the injected label;
 * - folding goes through the framework's fold-out (the subtree unmounts
 *   after the animation settles) and re-expands with rows;
 * - the row menu opens from the model's `onContextMenu` — the whole reason
 *   the capability is required — and the per-row stage control runs the same
 *   git call as the built-in row without previewing the file;
 * - a v2 service WITHOUT the capability (an older provider) falls back to
 *   the built-in rows, right-click included: a provider that would silently
 *   drop `onContextMenu` must not take the menu away.
 *
 * The service fixture is built from the upstream source component — vitest is
 * outside the client-bundle purity gate, so value-importing
 * `dsh-file-tree-ui/src/client/*.tsx` is legal here (tsdown never sees it).
 * Assertions stay semantic (roles / aria / data hooks / text).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, type GitStatusEntry, type GitStatusResult } from '../src/client/api.ts'
import { t } from '../src/client/locales.ts'
import { installFileTreeUiSeat } from '../src/client/file-tree-ui.ts'
import { invalidateGitStatus } from '../src/client/ui/index.ts'
import type { Context } from '../src/context-types.ts'
// The provider's REAL framework component (test-only value import — see the
// file header).
import { FileTree as ProviderFileTree } from 'dsh-file-tree-ui/src/client/FileTree.tsx'
import type { FileTreeProps, FileTreeRowModel, FileTreeUiServiceV2 } from 'dsh-file-tree-ui/client-contract'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo'
const SESSION = 'git-changes-tree'

/** One `git status` answer: two files under one directory, unstaged only. */
const unstagedEntries = (): GitStatusEntry[] => [
  { path: 'src/a.ts', xy: ' M' },
  { path: 'src/b.ts', xy: ' M' },
]

function statusFor(entries: GitStatusEntry[]): GitStatusResult {
  return { isRepo: true, branch: 'main', root: MAIN, entries }
}

/** One graph page (the lens renders the Graph section next to the tree). */
function graphFor(): Awaited<ReturnType<typeof api.gitGraph>> {
  const suffix = '00000001'
  return {
    isRepo: true,
    root: MAIN,
    entries: [{
      hash: `aaaaaa1`,
      hashFull: `aaaa${suffix}${suffix}${suffix}`,
      parents: [],
      subject: 'Initial commit',
      author: 'Test',
      date: '2026-08-20 00:00:00 +0800',
      refs: ['HEAD', 'main'],
      message: 'Initial commit\n',
    }],
    branches: [{ ref: 'refs/heads/main', name: 'main', hashFull: `aaaa${suffix}${suffix}${suffix}` }],
    hasMore: false,
    snapshot: `a${suffix}`,
  }
}

// ── Seat fixture (same shape as the file-tree service spec) ─────────────

interface Seat {
  set: (next: unknown) => void
  bump: () => void
}

function makeSeat(): Seat {
  let value: unknown = undefined
  const listeners = new Set<() => void>()
  const fakeCtx = {
    get: (key: string) => (key === 'fileTreeUi' ? value : undefined),
    on: (_event: string, listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as unknown as Context
  installFileTreeUiSeat(fakeCtx)
  return {
    set: (next) => { value = next },
    bump: () => { for (const listener of [...listeners]) listener() },
  }
}

/** The v2 service fixture: the real upstream framework, recording every
 *  `renderFileTree` props object so model-shape assertions stay possible. */
function makeService(record?: FileTreeProps[]): FileTreeUiServiceV2 {
  return {
    protocolVersion: 2,
    capabilities: ['rowContextMenu'],
    renderFileTree: props => {
      record?.push(props)
      return <ProviderFileTree {...props} />
    },
    renderRowMenu: () => <span />,
  }
}

let seat: Seat

beforeEach(() => {
  seat = makeSeat()
  invalidateGitStatus(SESSION)
})

afterEach(() => {
  installFileTreeUiSeat(null)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// ── Mount harness ───────────────────────────────────────────────────────

async function flushEffects(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve() })
}

interface Harness {
  container: HTMLDivElement
  root: Root
  onPreview: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountGit(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onPreview = vi.fn()
  act(() => {
    root.render(createElement(GitLens, {
      scope: { sessionId: SESSION, cwd: MAIN },
      store: createSidebarStore(),
      onOpenFile: () => {},
      onPreview,
      selectedRef: null,
      visible: true,
    }))
  })
  await flushEffects()
  return {
    container,
    root,
    onPreview,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

function mockGit(entries: GitStatusEntry[] = unstagedEntries()): void {
  vi.spyOn(api, 'gitStatus').mockResolvedValue(statusFor(entries))
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: MAIN, branch: 'main', current: true, changes: entries.length }])
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitGraph').mockResolvedValue(graphFor())
}

/** The framework row root carrying one injected identity hook. */
function rowOf(container: HTMLElement, hook: string): HTMLElement {
  const label = container.querySelector<HTMLElement>(`[data-group="unstaged"] ${hook}`)
  if (label === null) throw new Error(`row not found: ${hook}`)
  const row = label.closest<HTMLElement>('[role="button"]')
  if (row === null) throw new Error(`framework row root not found for ${hook}`)
  return row
}

/** Every row model of a recorded forest, root side first. */
function modelsOf(record: FileTreeProps[]): FileTreeRowModel[] {
  const collect = (nodes: readonly unknown[]): FileTreeRowModel[] => {
    const out: FileTreeRowModel[] = []
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null || Array.isArray(node) || !('label' in node)) continue
      const row = node as FileTreeRowModel
      out.push(row)
      if (row.children !== undefined) out.push(...collect(row.children))
    }
    return out
  }
  return record.flatMap(props => collect(props.rows))
}

// ── The framework path ──────────────────────────────────────────────────

describe('changes tree through the fileTreeUi v2 service', () => {
  it('renders each group through the framework: one root per group, model-driven rows', async () => {
    mockGit()
    const record: FileTreeProps[] = []
    seat.set(makeService(record))
    const view = await mountGit()
    try {
      // Only the unstaged group has rows: exactly one framework root, keyed
      // to that group (the group headers stay consumer-owned chrome). The
      // record accumulates one entry per render, so the KEYS are deduped and
      // the model assertions read the last render's forest.
      expect([...new Set(record.map(props => props.treeKey))]).toEqual(['git-changes:unstaged'])
      const latest = record[record.length - 1]!
      // The panel's own guide geometry and the tab's 28px rows ride the props.
      expect(latest.grid).toEqual({ basePx: 17, stepPx: 12 })

      // The directory row is the framework's div, not the built-in button.
      const dir = rowOf(view.container, '[data-dir="src"]')
      expect(dir.tagName).toBe('DIV')
      expect(dir.getAttribute('aria-expanded')).toBe('true')
      expect(dir.textContent).toContain('src')
      expect(view.container.querySelector('button[data-dir="src"]'), 'the built-in row must not render').toBeNull()

      // The file row keeps its identity hook, name, porcelain letter and the
      // stage control inside the framework's slots.
      const file = rowOf(view.container, '[data-path="src/a.ts"]')
      expect(file.textContent).toContain('a.ts')
      expect(file.textContent).toContain('M')
      expect(file.querySelector(`button[aria-label="${t('stage')}"]`)).not.toBeNull()

      // The models carry the right-click hook — the capability this path is
      // gated on (the framework's DOM passthrough drops unlisted props).
      const models = modelsOf([latest])
      expect(models.filter(model => model.onContextMenu !== undefined)).toHaveLength(2)
      expect(models.every(model => model.indentPx !== undefined)).toBe(true)
    } finally {
      view.unmount()
    }
  })

  it('folds a directory through the framework fold-out and re-expands with rows', async () => {
    mockGit()
    seat.set(makeService())
    const view = await mountGit()
    try {
      expect(view.container.querySelector('[data-path="src/a.ts"]')).not.toBeNull()

      // Collapse: the model's expanded flips, the framework plays the
      // fold-out, then unmounts the subtree (the timeout settles it in jsdom).
      await act(async () => { rowOf(view.container, '[data-dir="src"]').click() })
      expect(rowOf(view.container, '[data-dir="src"]').getAttribute('aria-expanded')).toBe('false')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
      expect(view.container.querySelector('[data-path="src/a.ts"]'), 'subtree must unmount after the fold-out').toBeNull()

      // Re-expand: the cached rows render again through the fold.
      await act(async () => { rowOf(view.container, '[data-dir="src"]').click() })
      await vi.waitFor(() => {
        expect(view.container.querySelector('[data-path="src/a.ts"]')).not.toBeNull()
      })
      expect(rowOf(view.container, '[data-dir="src"]').getAttribute('aria-expanded')).toBe('true')
    } finally {
      view.unmount()
    }
  })

  it('opens the row menu from the model onContextMenu and stages without previewing', async () => {
    mockGit()
    seat.set(makeService())
    const stage = vi.spyOn(api, 'gitStage').mockResolvedValue({ ok: true } as never)
    const view = await mountGit()
    try {
      const file = rowOf(view.container, '[data-path="src/a.ts"]')

      // Right-click: the framework passes the event through to the model's
      // handler, which opens this tab's own row menu.
      await act(async () => {
        file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
      })
      const items = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
        .map(button => button.textContent?.trim())
      expect(items).toContain(t('stage'))
      expect(items).toContain(t('openEditor'))

      // Escape closes it again (the portaled menu owns the key).
      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })

      // The row's stage control is a sibling of the hit area: it runs the
      // same git call as the built-in row and never previews the file.
      const action = file.querySelector<HTMLButtonElement>(`button[aria-label="${t('stage')}"]`)
      expect(action).not.toBeNull()
      await act(async () => { action!.click() })
      await flushEffects()
      expect(stage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION }), 'src/a.ts', expect.anything())
      expect(view.onPreview).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })

  it('previews the file on a row click and on Enter (the framework row is not a button element)', async () => {
    mockGit()
    seat.set(makeService())
    const view = await mountGit()
    try {
      const file = rowOf(view.container, '[data-path="src/a.ts"]')
      await act(async () => { file.click() })
      expect(view.onPreview).toHaveBeenCalledTimes(1)
      expect(view.onPreview).toHaveBeenCalledWith(expect.objectContaining({ kind: 'worktree', path: 'src/a.ts', staged: false }))

      await act(async () => {
        file.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(view.onPreview).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
    }
  })
})

// ── The capability gate / fallback ──────────────────────────────────────

describe('changes tree fallback', () => {
  it('keeps the built-in rows when the provider does not declare rowContextMenu', async () => {
    mockGit()
    // A v2 service from an older provider: no capability, so the model's
    // onContextMenu would be silently dropped — the menu must not disappear.
    seat.set({ protocolVersion: 2, renderFileTree: () => <span />, renderRowMenu: () => <span /> })
    const view = await mountGit()
    try {
      expect(view.container.querySelector('button[data-dir="src"]')).not.toBeNull()
      expect(view.container.querySelector('button[data-path="src/a.ts"]')).not.toBeNull()
      expect(view.container.querySelector('[role="button"][aria-expanded]')).toBeNull()

      // The built-in row still opens its menu on right-click.
      await act(async () => {
        view.container.querySelector<HTMLElement>('button[data-path="src/a.ts"]')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
      })
      const items = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
        .map(button => button.textContent?.trim())
      expect(items).toContain(t('stage'))
    } finally {
      view.unmount()
    }
  })

  it('keeps the built-in rows when no provider is loaded at all', async () => {
    mockGit()
    seat.set(undefined)
    const view = await mountGit()
    try {
      expect(view.container.querySelector('button[data-dir="src"]')).not.toBeNull()
      expect(view.container.querySelector('[role="button"][aria-expanded]')).toBeNull()
    } finally {
      view.unmount()
    }
  })
})
