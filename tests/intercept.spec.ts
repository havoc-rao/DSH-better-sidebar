/**
 * openSidebarFile (the produced-files / chat-open funnel): a DIRECTORY target
 * must not open an editor tab — the host fs.read rejects it ("is a directory")
 * and the tab would only show an error. The path is probed via fs.tree (lists
 * a directory, fails on a file/absent path): on a directory the vscode
 * explorer drawer expands (a no-op in the docked layout); a file opens as
 * before through the editor descriptor (per-path dedupe).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { api } from '../src/client/api.ts'
import { openSidebarFile } from '../src/client/intercept.tsx'
import { allLeaves, createSidebarStore } from '../src/client/state.ts'
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

/** The open editor tabs of the right tree (per-path ids). */
function openEditorTabs(store: ReturnType<typeof createSidebarStore>): string[] {
  return allLeaves(store.getSnapshot().state!.splits)
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
    await vi.waitFor(() => expect(openEditorTabs(store)).toContain('/repo/a.ts'))
  })

  it('does NOT open an editor tab for a directory; expands the vscode explorer drawer', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({ path: '/repo/src', entries: [], truncated: false })
    const { store, ctx } = setup('vscode')
    openSidebarFile(ctx, store, 's', 'src')
    await vi.waitFor(() => expect(store.getSnapshot().state?.sideBarOpen).toBe(true))
    expect(openEditorTabs(store)).toEqual([])
  })

  it('treats a directory click as a no-op in the docked layout (no tab, drawer concept absent)', async () => {
    vi.spyOn(api, 'fsTree').mockResolvedValue({ path: '/repo/src', entries: [], truncated: false })
    const { store, ctx } = setup('docked')
    openSidebarFile(ctx, store, 's', 'src')
    // Let the probe settle, then assert no editor tab was opened.
    await vi.waitFor(() => expect(vi.mocked(api.fsTree)).toHaveBeenCalled())
    expect(openEditorTabs(store)).toEqual([])
  })
})
