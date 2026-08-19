/**
 * openSidebarFile (the produced-files / chat-open funnel): a DIRECTORY target
 * must not open an editor tab — the host fs.read rejects it ("is a directory")
 * and the tab would only show an error. The path is probed via fs.tree (lists
 * a directory, fails on a file/absent path): on a directory the vscode
 * explorer drawer expands (a no-op in the docked layout); a file opens as
 * before through the editor descriptor (per-path dedupe). A tree-originated
 * open may also pin its landing panel (`area`): the tab must land in the box
 * the tree lives in, never wherever the global activePane last pointed.
 */
// Mock browser globals FIRST (SidebarStore.reduce → schedulePersist uses
// window.setTimeout; the area pin reduces the store synchronously).
import './browser-globals.ts'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { api } from '../src/client/api.ts'
import { openSidebarFile } from '../src/client/intercept.tsx'
import { allLeaves, createSidebarStore, firstLeaf } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import type { Context } from '../src/context-types.ts'

function setup(layout: 'docked' | 'vscode' = 'docked'): {
  store: ReturnType<typeof createSidebarStore>
  ctx: Context
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // The editor descriptor is required for the openTab dedupe (per-path).
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (t) => t.path, component: () => null })
  store.setPrefs({ ...store.getPrefs(), sidebarLayout: layout })
  store.setSession('s')
  const sessionsSnapshot = { byId: { s: { cwd: '/repo' } }, current: 's' }
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
  } as unknown as Context
  return { store, ctx }
}

/** The open editor tabs of one tree (per-path ids). */
function openEditorTabsIn(store: ReturnType<typeof createSidebarStore>, tree: 'splits' | 'bottomSplits'): string[] {
  return allLeaves(store.getSnapshot().state![tree])
    .flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'editor' && tab.path !== undefined)
    .map(tab => tab.path!)
}

beforeEach(() => { vi.restoreAllMocks() })

describe('openSidebarFile', () => {
  it('opens a file when the target is not a directory (fs.tree rejects)', async () => {
    vi.spyOn(api, 'fsTree').mockRejectedValue(new Error('ENOTDIR'))
    const { store, ctx } = setup()
    openSidebarFile(ctx, store, 's', 'a.ts')
    await vi.waitFor(() => expect(openEditorTabsIn(store, 'splits')).toContain('/repo/a.ts'))
  })

  it('pins a tree-originated open to the right panel even when the bottom pane is active', async () => {
    vi.spyOn(api, 'fsTree').mockRejectedValue(new Error('ENOTDIR'))
    const { store, ctx } = setup()
    // The user last touched the bottom panel: the global activePane points
    // there. A right-tree click must still land in the right box.
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.bottomSplits).id }))
    openSidebarFile(ctx, store, 's', 'a.ts', 'right')
    await vi.waitFor(() => expect(openEditorTabsIn(store, 'splits')).toContain('/repo/a.ts'))
    expect(openEditorTabsIn(store, 'bottomSplits')).toEqual([])
    // The active pane followed into the right tree (the pointerdown-focus
    // equivalent the docked tree applies), so later opens stay in sight.
    expect(store.getSnapshot().state!.activePane).toBe(firstLeaf(store.getSnapshot().state!.splits).id)
  })

  it('pins a tree-originated open to the bottom panel even when a right pane is active', async () => {
    vi.spyOn(api, 'fsTree').mockRejectedValue(new Error('ENOTDIR'))
    const { store, ctx } = setup()
    openSidebarFile(ctx, store, 's', 'a.ts', 'bottom')
    await vi.waitFor(() => expect(openEditorTabsIn(store, 'bottomSplits')).toContain('/repo/a.ts'))
    expect(openEditorTabsIn(store, 'splits')).toEqual([])
    expect(store.getSnapshot().state!.activePane).toBe(firstLeaf(store.getSnapshot().state!.bottomSplits).id)
    // The hosting panel opens so the landing is in sight.
    expect(store.getSnapshot().state!.bottomOpen).toBe(true)
  })

  it('keeps the activePane landing when no area is given (chat-side opens)', async () => {
    vi.spyOn(api, 'fsTree').mockRejectedValue(new Error('ENOTDIR'))
    const { store, ctx } = setup()
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.bottomSplits).id }))
    openSidebarFile(ctx, store, 's', 'a.ts')
    await vi.waitFor(() => expect(openEditorTabsIn(store, 'bottomSplits')).toContain('/repo/a.ts'))
    expect(openEditorTabsIn(store, 'splits')).toEqual([])
  })

  it('does NOT open an editor tab for a directory; expands the vscode explorer drawer', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({ path: '/repo/src', entries: [], truncated: false })
    const { store, ctx } = setup('vscode')
    openSidebarFile(ctx, store, 's', 'src')
    await vi.waitFor(() => expect(store.getSnapshot().state?.sideBarOpen).toBe(true))
    expect(openEditorTabsIn(store, 'splits')).toEqual([])
  })

  it('treats a directory click as a no-op in the docked layout (no tab, drawer concept absent)', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({ path: '/repo/src', entries: [], truncated: false })
    const { store, ctx } = setup('docked')
    openSidebarFile(ctx, store, 's', 'src')
    // Let the probe settle, then assert no editor tab was opened.
    await vi.waitFor(() => expect(vi.mocked(api.fsTree)).toHaveBeenCalled())
    expect(openEditorTabsIn(store, 'splits')).toEqual([])
  })
})
