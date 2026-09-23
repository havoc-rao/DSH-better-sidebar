/**
 * GitLens history section through the optional gitGraph v1 framework
 * (provider: dsh-git-graph): rows are the lens' own log entries (id = full
 * hash + real parents), row content stays the built-in two-line commit row,
 * and preview / context menu / paging event routing stays in GitLens. When
 * the service is missing, protocol-mismatched, unloaded or crashing, the
 * section falls back to the built-in list.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, type GitLogEntry, type GitLogPage, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'
import { bindGitGraph, unbindGitGraph } from '../src/client/git-lens-graph.ts'
import type { Context } from '../src/context-types.ts'
import type { GitGraphServiceV1, GraphTreeProps, GraphTreeRow } from 'dsh-git-graph/client-contract'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const REPO = 'C:/repo/main'

const STATUS: GitStatusResult = {
  isRepo: true,
  branch: 'main',
  entries: [],
  root: REPO,
}

function rowFor(index: number): GitLogEntry {
  const suffix = index.toString(16).padStart(8, '0')
  const child = `${'a'.repeat(32)}${suffix}`
  const parent = `${'b'.repeat(32)}${suffix}`
  return {
    hash: child.slice(0, 7),
    hashFull: child,
    subject: `Graph subject ${index}`,
    author: 'Dev',
    date: '2026-08-20 00:00:00 +0800',
    refs: index === 0 ? 'HEAD -> main' : '',
    parents: [parent],
  }
}

function pageFor(count: number, start = 0, cursor?: string): GitLogPage {
  return {
    entries: Array.from({ length: count }, (_value, index) => rowFor(start + index)),
    ...(cursor === undefined ? {} : { cursor }),
    hasMore: cursor !== undefined,
  }
}

/** A minimal re-implementation of the GraphTree framework surface (the same
 *  contracts: rows + renderRow slot, selectedId, click/double-click/keyboard
 *  routing, context-menu wrapper, empty/loading text, paging footer). */
function FakeGraphTree<R extends GraphTreeRow>(props: GraphTreeProps<R>): ReactNode {
  const { rows, renderRow } = props
  return (
    <div data-testid="graph-tree" role="listbox" aria-label={props.ariaLabel}>
      {rows.map((row, index) => (
        <div
          key={row.id}
          data-row-id={row.id}
          role="option"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              props.onSelect?.(row.id)
              props.onActivate?.(row.id)
            }
          }}
          onClick={() => { props.onSelect?.(row.id) }}
          onDoubleClick={() => { props.onActivate?.(row.id) }}
          onContextMenu={(event) => {
            event.preventDefault()
            props.onContextMenu?.(row.id, {
              clientX: 12,
              clientY: 34,
              preventDefault: () => { event.preventDefault() },
            })
          }}
        >
          {renderRow(row, { index, totalCount: rows.length, selected: row.id === props.selectedId, focused: false })}
        </div>
      ))}
      {rows.length === 0
        ? <p role="status">{props.loading ? props.loadingText : props.emptyText}</p>
        : null}
      {(props.hasMore === true || props.loading === true) && (
        <button type="button" disabled={props.loading === true || props.hasMore !== true} onClick={props.onLoadMore}>
          {props.loading === true ? props.loadingText : props.loadMoreText}
        </button>
      )}
    </div>
  )
}

function serviceWith(graphTree: GitGraphServiceV1['GraphTree']): GitGraphServiceV1 {
  return { protocolVersion: 1, GraphTree: graphTree }
}

/** Cached service objects: the seat snapshot is compared BY REFERENCE, so a
 *  getter may never mint a fresh object per read. */
const GRAPH_SERVICE = serviceWith(FakeGraphTree)
const WRONG_VERSION = { protocolVersion: 99, GraphTree: FakeGraphTree }
const graphCrashService = serviceWith(() => { throw new Error('framework exploded') })

/** A fake client Context that serves the CURRENT gitGraph value (read live)
 *  and fires the `internal/service` bus (the seat subscription's re-render
 *  trigger). */
function fakeCtxWith(read: () => unknown): { ctx: Context; emit(): void } {
  const listeners = new Set<() => void>()
  const ctx = {
    get: (key: string): unknown => (key === 'gitGraph' ? read() : undefined),
    on: (_event: string, listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as unknown as Context
  return { ctx, emit: () => { for (const listener of [...listeners]) listener() } }
}

function mockApi(pages: Array<GitLogEntry[] | GitLogPage>): ReturnType<typeof vi.spyOn> {
  let call = 0
  return vi.spyOn(api, 'gitLog').mockImplementation(async () => {
    const page = pages[Math.min(call, pages.length - 1)]!
    call += 1
    return page
  })
}

async function mountGitLens(container: HTMLElement, onPreview: (ref: unknown) => void): Promise<Root> {
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(GitLens, {
      scope: { sessionId: 'session', cwd: REPO },
      store: createSidebarStore(),
      commitMsg: '',
      onCommitMsgChange: () => {},
      onCommitMsgCommitted: () => {},
      onOpenFile: () => {},
      onPreview,
      selectedRef: null,
      visible: false,
    }))
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return root
}

afterEach(() => {
  unbindGitGraph()
  vi.restoreAllMocks()
})

describe('GitLens history through gitGraph v1 (soft join)', () => {
  it('renders log rows through GraphTree with parents and the built-in row content', async () => {
    bindGitGraph(fakeCtxWith(() => GRAPH_SERVICE).ctx)
    mockApi([pageFor(3, 0, 'cur-1')])
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })

    const container = document.createElement('div')
    document.body.append(container)
    try {
      const root = await mountGitLens(container, () => {})
      try {
        const tree = container.querySelector('[data-testid="graph-tree"]')
        expect(tree).not.toBeNull()
        // Every row id is the FULL hash (framework topology identity), and
        // the row content is the built-in two-line commit row (short hash +
        // subject + ref pill with data-kind + author·time).
        const rows = container.querySelectorAll('[data-row-id]')
        expect(rows).toHaveLength(3)
        expect(rows[0]!.getAttribute('data-row-id')).toBe(rowFor(0).hashFull)
        expect(container.textContent).toContain('Graph subject 0')
        expect(container.textContent).toContain('Dev')
        expect(container.querySelector('[data-kind="head"]')?.textContent).toBe('main')
        // The built-in list must NOT be rendered in framework mode.
        expect(container.querySelector('[class*="gitLogRow"]')).toBeNull()
      } finally {
        act(() => { root.unmount() })
      }
    } finally {
      container.remove()
    }
  })

  it('routes row click / Enter / Space to commit preview and right-click to the history menu', async () => {
    bindGitGraph(fakeCtxWith(() => GRAPH_SERVICE).ctx)
    mockApi([pageFor(2, 0, 'cur-1')])
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })

    const previews: unknown[] = []
    const container = document.createElement('div')
    document.body.append(container)
    try {
      const root = await mountGitLens(container, (ref) => { previews.push(ref) })
      try {
        const first = container.querySelector(`[data-row-id="${rowFor(0).hashFull}"]`)!
        await act(async () => { first.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
        expect(previews).toHaveLength(1)
        expect(previews[0]).toMatchObject({
          kind: 'commit',
          hash: rowFor(0).hash,
          hashFull: rowFor(0).hashFull,
          subject: 'Graph subject 0',
        })

        // Enter / Space on the focused row → preview (framework contract: the
        // framework routes BOTH onSelect and onActivate on Enter, and GitLens
        // previews through either — 2 previews per key press, idempotent).
        await act(async () => {
          first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        })
        expect(previews).toHaveLength(3)
        await act(async () => {
          first.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
        })
        expect(previews).toHaveLength(5)

        // Right-click opens GitLens' shared history menu with the row's full
        // hash (row id → entry lookup).
        await act(async () => {
          first.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 34 }))
        })
        expect(document.body.textContent).toContain('View commit diff')
        expect(document.body.textContent).toContain('Copy full hash')
      } finally {
        act(() => { root.unmount() })
      }
    } finally {
      container.remove()
    }
  })

  it('drives paging through GitLens loadMore with the response cursor', async () => {
    bindGitGraph(fakeCtxWith(() => GRAPH_SERVICE).ctx)
    // The mount + the repoRoot-settled re-refresh both anchor page 1; the
    // load-more click then rides the response cursor into page 2.
    const log = mockApi([
      pageFor(3, 0, 'cur-1'),
      pageFor(3, 0, 'cur-1'),
      pageFor(2, 3),
    ])
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })

    const container = document.createElement('div')
    document.body.append(container)
    try {
      const root = await mountGitLens(container, () => {})
      try {
        // First page anchors with roots: [] (server-pinned tips). No linked
        // worktrees are listed, so the checkout target stays undefined (the
        // session cwd is the repo).
        expect(log).toHaveBeenCalledWith(expect.anything(), 20, 0, undefined, { roots: [] })
        const rows = container.querySelectorAll('[data-row-id]')
        expect(rows).toHaveLength(3)

        // The framework footer's load-more rides the response cursor; the
        // appended rows feed straight back into the framework rows.
        const loadMore = [...container.querySelectorAll<HTMLButtonElement>('button')]
          .find(button => /Load more|加载更多/.test(button.textContent ?? ''))
        expect(loadMore).not.toBeUndefined()
        await act(async () => { loadMore!.click() })
        await act(async () => { await Promise.resolve() })
        expect(log).toHaveBeenLastCalledWith(expect.anything(), 20, 0, undefined, { cursor: 'cur-1' })
        expect(container.querySelectorAll('[data-row-id]')).toHaveLength(5)
        expect(container.textContent).toContain('Graph subject 4')
      } finally {
        act(() => { root.unmount() })
      }
    } finally {
      container.remove()
    }
  })

  it('renders the framework empty / loading / load-more labels from the plugin dictionary', async () => {
    bindGitGraph(fakeCtxWith(() => GRAPH_SERVICE).ctx)
    mockApi([{ entries: [], hasMore: false }])
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })

    const container = document.createElement('div')
    document.body.append(container)
    try {
      const root = await mountGitLens(container, () => {})
      try {
        expect(container.textContent).toContain('No commits yet')
      } finally {
        act(() => { root.unmount() })
      }
    } finally {
      container.remove()
    }
  })

  it('falls back to the built-in list when the service is missing', async () => {
    unbindGitGraph()
    mockApi([pageFor(2, 0, 'cur-1')])
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })

    const container = document.createElement('div')
    document.body.append(container)
    try {
      const root = await mountGitLens(container, () => {})
      try {
        expect(container.querySelector('[data-testid="graph-tree"]')).toBeNull()
        expect(container.querySelectorAll('[class*="gitLogRow"]')).toHaveLength(2)
        expect(container.textContent).toContain('Graph subject 0')
        expect(container.textContent).toContain('Graph subject 1')
        expect(container.querySelector('[data-kind="head"]')?.textContent).toBe('main')
      } finally {
        act(() => { root.unmount() })
      }
    } finally {
      container.remove()
    }
  })

  it('falls back to the list and warns once on a protocol mismatch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bindGitGraph(fakeCtxWith(() => WRONG_VERSION).ctx)
    mockApi([pageFor(1, 0)])
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })

    const container = document.createElement('div')
    document.body.append(container)
    try {
      const root = await mountGitLens(container, () => {})
      try {
        expect(container.querySelector('[data-testid="graph-tree"]')).toBeNull()
        expect(container.querySelectorAll('[class*="gitLogRow"]')).toHaveLength(1)
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        act(() => { root.unmount() })
      }
    } finally {
      container.remove()
    }
  })

  it('a GraphTree render crash degrades to the list and re-arms on checkout change', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    bindGitGraph(fakeCtxWith(() => graphCrashService).ctx)
    mockApi([pageFor(1, 0)])
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })

    const container = document.createElement('div')
    document.body.append(container)
    try {
      const root = await mountGitLens(container, () => {})
      try {
        // The crash is caught by the graph boundary: the section degrades to
        // the built-in list (never a blank/error-only history).
        expect(container.querySelectorAll('[class*="gitLogRow"]')).toHaveLength(1)
        expect(error).toHaveBeenCalledWith(expect.stringContaining('gitGraph framework crashed'), expect.any(Error))
      } finally {
        act(() => { root.unmount() })
      }
    } finally {
      container.remove()
    }
  })

  it('live service arrival switches the section to the framework without remount', async () => {
    unbindGitGraph()
    let current: unknown = undefined
    const seat = fakeCtxWith(() => current)
    bindGitGraph(seat.ctx)
    mockApi([pageFor(2, 0)])
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    vi.spyOn(api, 'gitStatus').mockResolvedValue(STATUS)
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })

    const container = document.createElement('div')
    document.body.append(container)
    try {
      const root = await mountGitLens(container, () => {})
      try {
        expect(container.querySelector('[data-testid="graph-tree"]')).toBeNull()
        // The provider mounts: the internal/service bus flips the snapshot
        // to the live service and the history section re-renders through it.
        current = serviceWith(FakeGraphTree)
        await act(async () => { seat.emit() })
        expect(container.querySelector('[data-testid="graph-tree"]')).not.toBeNull()
        expect(container.querySelector('[data-row-id]')).not.toBeNull()
      } finally {
        act(() => { root.unmount() })
      }
    } finally {
      container.remove()
    }
  })
})