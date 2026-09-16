/**
 * Open-tab reconciliation after file-tree mutations (rename/move): the exact
 * row path AND every descendant path must retarget (a moved directory
 * carries its whole subtree of open tabs), titles follow the new base name,
 * and an absent service downgrades to a no-op.
 */
import { describe, expect, it, vi } from 'vitest'
import { retargetPathTabs } from '../src/client/tree-mutations.ts'
import { makeDefaultState, openTabInBottomPane, type SidebarStore } from '../src/client/state.ts'

/** A store whose snapshot carries exactly the given tabs. */
function storeWith(tabs: Array<{ id: string; title: string; path: string }>): SidebarStore {
  let state = makeDefaultState()
  for (const tab of tabs) {
    state = openTabInBottomPane(state, { id: tab.id, type: 'editor', title: tab.title, path: tab.path })
  }
  return { getSnapshot: () => ({ state }) } as unknown as SidebarStore
}

describe('retargetPathTabs', () => {
  it('retargets the exact row and every descendant (directory moves), leaving others alone', () => {
    const updateTab = vi.fn()
    const ctx = { get: () => ({ updateTab }) } as never
    const store = storeWith([
      { id: 'dir-tab', title: 'dir', path: '/ws/dir' },
      { id: 'deep', title: 'deep.ts', path: '/ws/dir/deep.ts' },
      { id: 'nested', title: 'x.ts', path: '/ws/dir/nested/x.ts' },
      { id: 'unrelated', title: 'else.ts', path: '/ws/other/else.ts' },
    ])
    retargetPathTabs(ctx, store, '/ws/dir', '/ws/moved')
    expect(updateTab).toHaveBeenCalledWith('dir-tab', { path: '/ws/moved', title: 'moved' })
    expect(updateTab).toHaveBeenCalledWith('deep', { path: '/ws/moved/deep.ts', title: 'deep.ts' })
    expect(updateTab).toHaveBeenCalledWith('nested', { path: '/ws/moved/nested/x.ts', title: 'x.ts' })
    // A sibling path sharing the OLD prefix must NOT be rewritten.
    expect(updateTab).toHaveBeenCalledTimes(3)
  })

  it('a prefix lookalike (dir2 under dir1) never matches dir1', () => {
    const updateTab = vi.fn()
    const ctx = { get: () => ({ updateTab }) } as never
    const store = storeWith([
      { id: 'lookalike', title: 'a.ts', path: '/ws/dir2/a.ts' },
      { id: 'real', title: 'b.ts', path: '/ws/dir/b.ts' },
    ])
    retargetPathTabs(ctx, store, '/ws/dir', '/ws/moved')
    expect(updateTab).toHaveBeenCalledWith('real', { path: '/ws/moved/b.ts', title: 'b.ts' })
    expect(updateTab).toHaveBeenCalledTimes(1)
  })

  it('no-ops when the sidebar service is absent', () => {
    const updateTab = vi.fn()
    const ctx = { get: () => undefined } as never
    const store = storeWith([{ id: 'deep', title: 'x.ts', path: '/ws/dir/x.ts' }])
    retargetPathTabs(ctx, store, '/ws/dir', '/ws/moved')
    expect(updateTab).not.toHaveBeenCalled()
  })
})