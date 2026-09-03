/**
 * GitView history-row local/remote marking: the local/remote story lives on
 * the history ROW — a left accent border + a faint box tint driven by
 * `GitGraphRow.kind` (git-graph.ts refKindOf) — NOT on the graph node/edges
 * (tinted lanes drown in multi-branch histories). The name-level ref chips
 * keep their per-kind colors on top of the row tint.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitView } from '../src/client/GitView.tsx'
import { api, type GitGraphEntry, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const REPO = 'C:/repo/main'

/** One graph row with the given FULL ref decorations (--decorate=full). */
function entry(refs: string): GitGraphEntry {
  return {
    hash: 'aaaaaa1',
    hashFull: `${'a'.repeat(39)}1`,
    subject: 'commit',
    author: 'Test',
    date: '2026-09-01 00:00:00 +0800',
    refs,
    parents: [],
  }
}

function mockApi(pages: Record<number, GitGraphEntry[]>): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: REPO, branch: 'main', current: true, changes: 0 }] as GitWorktree[])
  vi.spyOn(api, 'gitStatus').mockResolvedValue({ isRepo: true, branch: 'main', entries: [], root: REPO } as GitStatusResult)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitBranchStatus').mockResolvedValue({ upstream: undefined, ahead: 0, behind: 0, gone: false })
  vi.spyOn(api, 'gitLogGraph').mockImplementation(async (_scope, _count, skip) => pages[skip ?? 0] ?? [])
  vi.spyOn(api, 'gitBranchTips').mockResolvedValue({ tips: [] })
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  })
}

async function mountView(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(GitView, {
      scope: { sessionId: 'row-marking-session', cwd: REPO },
      onOpenFile: () => {},
      onOpenDiff: () => {},
      visible: false,
    }))
  })
  await flushEffects()
  return { container, root }
}

/** The history-row elements (the log row divs, by the scoped css class). */
function logRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[class*="gitLogRow"]')]
    .filter(el => el.className.includes('gitLogRow'))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('GitView history-row local/remote marking', () => {
  it('marks a local row (left border + tint class) and keeps the ref chips colored', async () => {
    mockApi({ 0: [entry('HEAD -> refs/heads/main, refs/remotes/origin/main')] })
    const { container, root } = await mountView()
    try {
      const rows = logRows(container)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows[0]!.className).toContain('gitLogRowLocal')
      expect(rows[0]!.className).not.toContain('gitLogRowRemote')
      // The name-level chips still carry their per-kind colors.
      const localChip = [...container.querySelectorAll<HTMLElement>('span[class*="gitLogRefLocal"]')]
        .find(span => span.textContent === 'main')
      const remoteChip = [...container.querySelectorAll<HTMLElement>('span[class*="gitLogRefRemote"]')]
        .find(span => span.textContent === 'origin/main')
      expect(localChip).not.toBeUndefined()
      expect(remoteChip).not.toBeUndefined()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('marks a fetch-only remote row with the remote class', async () => {
    mockApi({ 0: [entry('refs/remotes/origin/main')] })
    const { container, root } = await mountView()
    try {
      const rows = logRows(container)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows[0]!.className).toContain('gitLogRowRemote')
      expect(rows[0]!.className).not.toContain('gitLogRowLocal')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('leaves neutral rows (tag-only) unmarked', async () => {
    mockApi({ 0: [entry('tag: refs/tags/v1')] })
    const { container, root } = await mountView()
    try {
      const rows = logRows(container)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows[0]!.className).not.toContain('gitLogRowLocal')
      expect(rows[0]!.className).not.toContain('gitLogRowRemote')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})