/**
 * Workspace-windows store tests: bind/unbind/update semantics, the
 * per-workspace persistence blob (sanitize, stable stub ids), the
 * session→workspace resolution, and the SidebarStore reconcile wiring
 * (workspace windows appear/update/disappear in every session of their
 * workspace; GLOBAL windows park in the Global Workspace and attach to a
 * session on demand — `ws:` stubs never persist, attached `gb:` stubs do).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  allLeaves, createSidebarStore, firstLeaf, isBoundTabId, isGlobalTabId, moveTab, openTabInActivePane, splitPane,
  type SidebarStore, type SidebarTab,
} from '../src/client/state.ts'
import { createWorkspaceWindowsStore, type WorkspaceWindowsStore } from '../src/client/workspace-windows.ts'
import type { Context } from '../src/context-types.ts'

/** A fake client workspaces list feed (structural mirror of WorkspaceRuntime.list). */
function fakeCtx(): Context {
  return {
    workspaces: {
      openPath: async () => {},
      list: {
        getSnapshot: () => ({
          items: [
            { workspaceId: '11111111-aaaa-0000-0000-000000000001', path: '/ws-a', title: 'Workspace A', sessionIds: ['a', 'b'], createdAt: '', updatedAt: '' },
            { workspaceId: '22222222-bbbb-0000-0000-000000000002', path: '/ws-b', title: 'Workspace B', sessionIds: ['c'], createdAt: '', updatedAt: '' },
          ],
        }),
        subscribe: () => () => {},
      },
    },
  } as unknown as Context
}

/** A file tab to bind (content windows only — binding requires a path). */
const fileTab = (id: string, path: string, title = 'a.ts'): SidebarTab => ({ id, type: 'editor', title, path })

/** The right panel's first-leaf tabs of a session state (the DEFAULT
 *  landing area: openTabInActivePane targets the active pane, which is
 *  seeded to the right tree — so a plain bind pins into the right panel;
 *  switches to the session). */
function rightLeafTabs(store: SidebarStore, sessionId: string): SidebarTab[] {
  store.setSession(sessionId)
  const state = store.getSnapshot().state
  return state === undefined ? [] : allLeaves(state.splits)[0]!.tabs
}

/** The bottom box's first-leaf tabs of a session state (a bottom-area pin
 *  lands here; switches to the session). */
function bottomLeafTabs(store: SidebarStore, sessionId: string): SidebarTab[] {
  store.setSession(sessionId)
  const state = store.getSnapshot().state
  return state === undefined ? [] : allLeaves(state.bottomSplits)[0]!.tabs
}

/** Flush the debounced localStorage writes (both stores use a 200ms timer). */
const flushPersist = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 260))

/** Stub the client API's fetch with fake sidebar RPC responses and return
 *  the captured calls ({method, payload}) — used to assert the pty
 *  re-parenting the store issues around terminal bind/unbind. */
function stubSidebarApi(): Array<{ method: string; payload: Record<string, unknown> }> {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    calls.push({
      method: href.slice(href.lastIndexOf('/') + 1),
      payload: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return {
      ok: true,
      json: async () => ({ ok: true, value: { ok: true } }),
    } as unknown as Response
  }))
  return calls
}

/** A session-local terminal tab (path-less; binding never dedupes it). */
const terminalTab = (id: string): SidebarTab => ({ id, type: 'terminal', title: 'Terminal' })

/** Open a file tab in the session's first leaf via the state-level open. */
function openFileTab(store: SidebarStore, sessionId: string, path: string, title = 'a.ts'): SidebarTab {
  store.setSession(sessionId)
  const tab = fileTab(`editor:${path}`, path, title)
  store.reduce(s => openTabInActivePane(s, tab))
  return tab
}

/** Create the store pair wired like apply() does. */
function makePair() {
  const ctx = fakeCtx()
  const sidebar = createSidebarStore()
  const windows = createWorkspaceWindowsStore(ctx)
  windows.attachSidebarStore(sidebar)
  return { ctx, sidebar, windows }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('workspace windows store', () => {
  it('bind mints a stable stub id and syncs every session of the workspace', () => {
    const { sidebar, windows } = makePair()
    // Load session 'b' into the cache so the reconcile pass reaches it.
    sidebar.setSession('b')
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)

    const snapshot = windows.getSnapshot()
    expect(snapshot.workspaceId).toBe('11111111-aaaa-0000-0000-000000000001')
    expect(snapshot.windows).toHaveLength(1)
    const bound = snapshot.windows[0]!
    expect(bound.id).toMatch(/^ws:11111111:[12]$/)
    expect(bound.type).toBe('editor')
    expect(bound.path).toBe('/ws-a/src/a.ts')
    expect(bound.area).toBe('right') // the tab was in the right panel
    expect(isBoundTabId(bound.id)).toBe(true)

    // Every session of the workspace holds the stub in the RIGHT panel's
    // first leaf (the pin lands where the window was); the binding
    // session's local tab is gone (no local + bound duplicate).
    expect(rightLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id)).map(t => t.id)).toEqual([bound.id])
    expect(rightLeafTabs(sidebar, 'b').filter(t => isBoundTabId(t.id)).map(t => t.id)).toEqual([bound.id])
    // A session of ANOTHER workspace never sees it.
    expect(rightLeafTabs(sidebar, 'c').every(t => !isBoundTabId(t.id))).toBe(true)
    // The bottom box was not touched by a right-area pin.
    expect(bottomLeafTabs(sidebar, 'a').every(t => !isBoundTabId(t.id))).toBe(true)

    // A second bind mints the next id (counter monotonic per workspace).
    const tab2 = openFileTab(sidebar, 'a', '/ws-a/src/b.ts', 'b.ts')
    windows.bind(tab2)
    const second = windows.getSnapshot().windows[1]!
    expect(second.id).toBe(`ws:11111111:${Number(bound.id.split(':')[2]) + 1}`)
  })

  it('bind keeps the active slot when the bound tab was NOT the active one', () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    // Open a SECOND file so the first is no longer active.
    const other = openFileTab(sidebar, 'a', '/ws-a/src/other.ts', 'other.ts')
    windows.bind(tab) // a.ts is inactive now

    // The right panel's layout is untouched (only the bound tab left it).
    const leaf = firstLeaf(sidebar.getSnapshot().state!.splits)
    expect(leaf.active).toBe(other.id)
    expect(leaf.tabs.some(t => t.id === other.id)).toBe(true)
  })

  it('bind moves the active slot to the stub when the bound tab WAS active', () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)

    // The pin stays in the RIGHT panel (the tab's original area): its
    // first leaf's active moved to the stub, and the bottom box was not
    // forced open for a right-area pin.
    const state = sidebar.getSnapshot().state!
    expect(state.bottomOpen).toBe(false)
    expect(firstLeaf(state.splits).active).toBe(windows.getSnapshot().windows[0]!.id)
  })

  it('bind is a no-op when the session belongs to no workspace', () => {
    const { sidebar, windows } = makePair()
    sidebar.setSession('orphan')
    const tab = fileTab('tab:1', '/tmp/x.ts')
    windows.bind(tab)
    expect(windows.getSnapshot().workspaceId).toBeUndefined()
    expect(windows.getSnapshot().windows).toHaveLength(0)
  })

  it('bind of an already-bound window strips the stray duplicate and focuses the stub', () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)
    // Simulate a stray local duplicate (the open plumbing normally prevents it).
    const dup = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(dup)

    expect(windows.getSnapshot().windows).toHaveLength(1)
    const leaf = firstLeaf(sidebar.getSnapshot().state!.splits)
    // The stray local duplicate is gone (only the id-only stub remains),
    // and the stub lives in the RIGHT panel (the tab's original area).
    expect(leaf.tabs.filter(t => t.path === '/ws-a/src/a.ts')).toHaveLength(0)
    expect(leaf.tabs.filter(t => isBoundTabId(t.id))).toHaveLength(1)
    expect(leaf.active).toBe(windows.getSnapshot().windows[0]!.id)
  })

  it('unbind(keepInSession) materializes a local tab in the binding session only', () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)
    const stubId = windows.getSnapshot().windows[0]!.id

    windows.unbind(stubId, true)

    expect(windows.getSnapshot().windows).toHaveLength(0)
    const local = rightLeafTabs(sidebar, 'a').filter(t => t.path === '/ws-a/src/a.ts')
    expect(local).toHaveLength(1)
    expect(isBoundTabId(local[0]!.id)).toBe(false)
    expect(firstLeaf(sidebar.getSnapshot().state!.splits).active).toBe(local[0]!.id)
    // The other session lost the window entirely.
    expect(rightLeafTabs(sidebar, 'b').every(t => !isBoundTabId(t.id))).toBe(true)
  })

  it('unbind(false) closes the window everywhere', () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)
    const stubId = windows.getSnapshot().windows[0]!.id

    windows.unbind(stubId, false)

    expect(windows.getSnapshot().windows).toHaveLength(0)
    expect(rightLeafTabs(sidebar, 'a').every(t => !isBoundTabId(t.id))).toBe(true)
    expect(rightLeafTabs(sidebar, 'b').every(t => !isBoundTabId(t.id))).toBe(true)
  })

  it('update rewrites the definition for every session render', () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)
    const stubId = windows.getSnapshot().windows[0]!.id

    windows.update(stubId, { path: '/ws-a/src/renamed.ts', title: 'renamed.ts' })

    const bound = windows.getSnapshot().windows[0]!
    expect(bound.path).toBe('/ws-a/src/renamed.ts')
    expect(bound.title).toBe('renamed.ts')
    // The stubs in the session trees keep their id-only shape (the render
    // layer resolves live definitions from the store).
    expect(rightLeafTabs(sidebar, 'b')[0]!.path).toBeUndefined()
  })

  it('update of an unknown id is a strict no-op', () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)
    const before = windows.getSnapshot().windows
    windows.update('ws:11111111:99', { path: '/nope' })
    expect(windows.getSnapshot().windows).toBe(before)
  })

  it('session layouts never persist stubs (strip on write, re-merge on load)', async () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)
    await flushPersist()

    const persisted = JSON.parse(localStorage.getItem('dsh-sidebar:v1:a')!) as {
      splits: { tabs: Array<{ id: string }>; active: string | null }
    }
    expect(persisted.splits.tabs.every(t => !isBoundTabId(t.id))).toBe(true)
    expect(persisted.splits.active === null || !isBoundTabId(persisted.splits.active)).toBe(true)

    // Reload: a fresh pair re-merges the bound window from the store blob.
    const { sidebar: reloaded, windows: windows2 } = makePair()
    reloaded.setSession('a')
    expect(windows2.windowsOfSession('a').map(w => w.path)).toEqual(['/ws-a/src/a.ts'])
    const stubs = rightLeafTabs(reloaded, 'a').filter(t => isBoundTabId(t.id))
    expect(stubs.map(t => t.id)).toEqual([windows2.getSnapshot().windows[0]!.id])
  })

  it('windowsOfSession resolves per workspace and returns [] for ungrouped sessions', () => {
    const { sidebar, windows } = makePair()
    expect(windows.windowsOfSession('a')).toEqual([])
    expect(windows.windowsOfSession('c')).toEqual([])
    expect(windows.windowsOfSession('nope')).toEqual([])
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)
    expect(windows.windowsOfSession('b')).toHaveLength(1) // same workspace
    expect(windows.windowsOfSession('c')).toHaveLength(0) // other workspace
  })

  it('corrupt persisted blobs reset to an empty blob', async () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)
    await flushPersist()
    localStorage.setItem('dsh-sidebar:v1:ws-windows:11111111-aaaa-0000-0000-000000000001', '{"version":1,"nextId":1,"tabs":[{"id":42}]}')

    const { sidebar: reloaded, windows: reloadedWindows } = makePair()
    // The corrupt blob resets to empty; the old valid data is gone.
    expect(reloadedWindows.windowsOfSession('a')).toEqual([])
    // A session load still works (no stubs, no crash).
    expect(rightLeafTabs(reloaded, 'a').every(t => !isBoundTabId(t.id))).toBe(true)
    void sidebar
    void windows
  })

  it('a bind while another workspace is current never leaks across workspaces', () => {
    const { sidebar, windows } = makePair()
    const tabA = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tabA)
    sidebar.setSession('c')
    const tabC = openFileTab(sidebar, 'c', '/ws-b/src/c.ts', 'c.ts')
    windows.bind(tabC)

    expect(windows.windowsOfSession('a').map(w => w.path)).toEqual(['/ws-a/src/a.ts'])
    expect(windows.windowsOfSession('c').map(w => w.path)).toEqual(['/ws-b/src/c.ts'])
    // The 'c' session's tree holds only ITS workspace's stub.
    const cTabs = rightLeafTabs(sidebar, 'c')
    expect(cTabs.filter(t => isBoundTabId(t.id)).map(t => t.id))
      .toEqual([windows.windowsOfSession('c')[0]!.id])
  })

  it('binds a path-less window (terminal): local tab replaced, other sessions get the stub, same-type tabs untouched', async () => {
    const { sidebar, windows } = makePair()
    // Two local terminals side by side; bind ONLY the first. (The bind
    // always runs in the session that owns the tab — the context menu
    // lives there — so we bind while 'a' is active.)
    const t1 = terminalTab('terminal:1')
    const t2 = terminalTab('terminal:2')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    sidebar.reduce(s => openTabInActivePane(s, t2))
    sidebar.setSession('b') // load the sibling session into the cache
    sidebar.setSession('a') // back to the session that owns the terminals

    await windows.bind(t1)

    const bound = windows.getSnapshot().windows
    expect(bound).toHaveLength(1)
    expect(bound[0]!.type).toBe('terminal')
    expect(bound[0]!.path).toBeUndefined()
    expect(bound[0]!.area).toBe('right') // the terminal lived in the right panel
    const stubId = bound[0]!.id
    // The bound local tab left the RIGHT tree; the OTHER local terminal
    // survives untouched.
    const rightTabs = firstLeaf(sidebar.getSnapshot().state!.splits).tabs
    expect(rightTabs.some(t => t.id === 'terminal:1')).toBe(false)
    expect(rightTabs.some(t => t.id === 'terminal:2')).toBe(true)
    // The RIGHT panel now carries the stub (the pin stays where the window
    // was); the bottom box was not touched by a right-area pin.
    expect(rightLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id)).map(t => t.id)).toEqual([stubId])
    expect(bottomLeafTabs(sidebar, 'a').every(t => !isBoundTabId(t.id))).toBe(true)
    // The bound tab was NOT the active one (terminal:2 opened last), so
    // the right tree's active stays where it was — only a bound ACTIVE tab
    // hands its slot to the stub.
    expect(firstLeaf(sidebar.getSnapshot().state!.splits).active).toBe('terminal:2')
    expect(sidebar.getSnapshot().state!.bottomOpen).toBe(false)
    // The sibling session carries the same stub (its own live terminal).
    expect(rightLeafTabs(sidebar, 'b').filter(t => isBoundTabId(t.id)).map(t => t.id)).toEqual([stubId])
  })

  it('binding two path-less windows creates two shared windows (no dedupe)', async () => {
    const { sidebar, windows } = makePair()
    const t1 = terminalTab('terminal:1')
    const t2 = terminalTab('terminal:2')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    await windows.bind(t1)
    sidebar.reduce(s => openTabInActivePane(s, t2))
    await windows.bind(t2)

    const bound = windows.getSnapshot().windows
    expect(bound).toHaveLength(2)
    expect(bound[0]!.id).not.toBe(bound[1]!.id)
    // Both stubs are in the binding session's right-panel first leaf.
    const stubs = rightLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id))
    expect(stubs).toHaveLength(2)
  })

  it('a tab bound from the BOTTOM panel pins into the bottom box (the area follows the original)', async () => {
    const { sidebar, windows } = makePair()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    // Land the tab in the BOTTOM tree: point the active pane at the bottom
    // box's first leaf before opening.
    sidebar.reduce(s => ({ ...s, activePane: firstLeaf(s.bottomSplits).id }))
    sidebar.reduce(s => openTabInActivePane(s, t1))
    expect(firstLeaf(sidebar.getSnapshot().state!.bottomSplits).tabs.some(t => t.id === 'terminal:1')).toBe(true)

    await windows.bind(t1)

    const bound = windows.getSnapshot().windows[0]!
    expect(bound.area).toBe('bottom')
    // The stub lives in the BOTTOM box and the panel opened for it; the
    // right panel was not touched by a bottom-area pin.
    expect(bottomLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id)).map(t => t.id)).toEqual([bound.id])
    expect(rightLeafTabs(sidebar, 'a').every(t => !isBoundTabId(t.id))).toBe(true)
    expect(sidebar.getSnapshot().state!.bottomOpen).toBe(true)
    // The bound tab was the ACTIVE one → the bottom first leaf's active
    // moved to the stub.
    expect(firstLeaf(sidebar.getSnapshot().state!.bottomSplits).active).toBe(bound.id)
  })

  it('binding a diff window carries the diff ref; unbind restores it locally', () => {
    const { sidebar, windows } = makePair()
    const diff = {
      id: 'diff:1',
      type: 'diff',
      title: 'a.ts (staged)',
      diff: { kind: 'worktree', path: '/ws-a/src/a.ts', staged: true } as const,
    }
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, diff))
    windows.bind(diff)

    const bound = windows.getSnapshot().windows[0]!
    expect(bound.diff).toEqual({ kind: 'worktree', path: '/ws-a/src/a.ts', staged: true })

    // Unbind keeping the window here: the local tab restores the diff ref
    // in the same area the stub occupied (the right panel).
    windows.unbind(bound.id, true)
    const local = rightLeafTabs(sidebar, 'a').find(t => t.type === 'diff')
    expect(local?.diff).toEqual({ kind: 'worktree', path: '/ws-a/src/a.ts', staged: true })
  })

  it('binding a TERMINAL re-parents its pty to the stub key BEFORE the tree swap', async () => {
    const { sidebar, windows } = makePair()
    const calls = stubSidebarApi()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))

    await windows.bind(t1)

    const stubId = windows.getSnapshot().windows[0]!.id
    // The reparent call precedes the swap: from the local tab to the
    // stub's shared key, so the host moves the LIVE process there and the
    // stub's attach reuses it instead of spawning a fresh shell.
    expect(calls).toEqual([
      { method: 'pty.reparent', payload: { sessionId: 'a', from: 'terminal:1', to: stubId } },
    ])
    expect(windows.getSnapshot().windows).toHaveLength(1)
    expect(rightLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id))).toHaveLength(1)
  })

  it('binding a non-terminal window never touches the pty', async () => {
    const { sidebar, windows } = makePair()
    const calls = stubSidebarApi()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    await windows.bind(tab)
    expect(calls).toEqual([])
  })

  it('unbinding a TERMINAL (keep) re-parents the shared pty to the minted local id', async () => {
    const { sidebar, windows } = makePair()
    const calls = stubSidebarApi()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    await windows.bind(t1)
    const stubId = windows.getSnapshot().windows[0]!.id
    calls.length = 0

    await windows.unbind(stubId, true)

    const local = rightLeafTabs(sidebar, 'a').find(t => t.type === 'terminal')
    expect(local).toBeDefined()
    expect(isBoundTabId(local!.id)).toBe(false)
    // from = the stub (shared key), to = the NEW local id (session key) —
    // the host moves the process back into this session.
    expect(calls).toEqual([
      { method: 'pty.reparent', payload: { sessionId: 'a', from: stubId, to: local!.id } },
    ])
    expect(windows.getSnapshot().windows).toHaveLength(0)
  })

  it('closing a bound terminal (unbind keep=false) does NOT reparent — the pty dies with the window', async () => {
    const { sidebar, windows } = makePair()
    const calls = stubSidebarApi()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    await windows.bind(t1)
    const stubId = windows.getSnapshot().windows[0]!.id
    calls.length = 0

    await windows.unbind(stubId, false)

    expect(calls).toEqual([])
    expect(windows.getSnapshot().windows).toHaveLength(0)
  })

  it('a stub dragged to another leaf keeps its per-session placement (reconcile never re-homes or duplicates it)', () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)
    const stubId = windows.getSnapshot().windows[0]!.id
    // Split the right tree and drag the stub into the new leaf (the drag
    // path: moveTab).
    sidebar.reduce(s => splitPane(s, 'row'))
    const leaves = allLeaves(sidebar.getSnapshot().state!.splits)
    expect(leaves).toHaveLength(2)
    sidebar.reduce(s => moveTab(s, leaves[0]!.id, stubId, leaves[1]!.id))
    expect(allLeaves(sidebar.getSnapshot().state!.splits)[1]!.tabs.some(t => t.id === stubId)).toBe(true)
    expect(allLeaves(sidebar.getSnapshot().state!.splits)[0]!.tabs.some(t => t.id === stubId)).toBe(false)

    // A workspace-windows change re-reconciles every session: the moved
    // stub is NOT re-homed to the first leaf and NOT duplicated.
    windows.update(stubId, { title: 'renamed' })
    const after = allLeaves(sidebar.getSnapshot().state!.splits)
    expect(after[1]!.tabs.some(t => t.id === stubId)).toBe(true)
    expect(after[0]!.tabs.some(t => t.id === stubId)).toBe(false)
    expect(after.flatMap(l => l.tabs).filter(t => t.id === stubId)).toHaveLength(1)
  })

  it('a failed pty reparent degrades to the old behavior (bind still completes)', async () => {
    const { sidebar, windows } = makePair()
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down')
    }))
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))

    await windows.bind(t1)

    // The bind itself still lands (the reparent is best-effort).
    expect(windows.getSnapshot().windows).toHaveLength(1)
    expect(rightLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id))).toHaveLength(1)
  })
})

describe('global-shared windows (the Global Workspace)', () => {
  it('gb: stubs are recognized by the client stub predicates', () => {
    expect(isGlobalTabId('gb:3')).toBe(true)
    expect(isGlobalTabId('ws:11111111:1')).toBe(false)
    expect(isGlobalTabId('terminal:1')).toBe(false)
    expect(isBoundTabId('gb:3')).toBe(true)
  })

  it('bindGlobal mints a gb: window that PARKS in the Global Workspace — NO stub merges into ANY session', () => {
    const { sidebar, windows } = makePair()
    // Open a terminal as the ACTIVE tab on a fresh session 'a'.
    sidebar.setSession('a')
    const t1 = terminalTab('terminal:1')
    sidebar.reduce(s => openTabInActivePane(s, t1))

    return windows.bindGlobal(t1).then(() => {
      // The window's lifecycle now lives in the instance-level GLOBAL blob
      // (the Global Workspace's single source of truth).
      expect(windows.globalWindows().map(w => w.id)).toEqual([expect.stringMatching(/^gb:\d+$/)])
      const stubId = windows.globalWindows()[0]!.id
      // windowsOfSession carries WORKSPACE windows only — global windows
      // never merge into a session automatically.
      expect(windows.windowsOfSession('a').filter(w => isGlobalTabId(w.id))).toHaveLength(0)
      // The binding session lost its local terminal and NO stub took its
      // place (the window moved OUT; a dangling active is nulled — there is
      // no active handoff to a stub).
      expect(firstLeaf(sidebar.getSnapshot().state!.splits).tabs.some(t => t.id === 'terminal:1')).toBe(false)
      expect(firstLeaf(sidebar.getSnapshot().state!.splits).active).toBeNull()
      // Sessions of OTHER workspaces AND ungrouped sessions see NOTHING of
      // the window either — visibility is opt-in per session now.
      sidebar.setSession('b')
      sidebar.setSession('c')
      sidebar.setSession('orphan')
      for (const session of ['a', 'b', 'c', 'orphan']) {
        expect(rightLeafTabs(sidebar, session).filter(t => isGlobalTabId(t.id))).toHaveLength(0)
      }
    })
  })

  it('bindGlobal re-parents the terminal pty to the shared gb: key (and NOT to a workspace key)', async () => {
    const { sidebar, windows } = makePair()
    const calls = stubSidebarApi()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))

    await windows.bindGlobal(t1)

    const stubId = windows.globalWindows()[0]!.id
    expect(calls).toEqual([
      { method: 'pty.reparent', payload: { sessionId: 'a', from: 'terminal:1', to: stubId } },
    ])
    expect(stubId).toMatch(/^gb:\d+$/)
  })

  it('bindGlobal is a NO-OP for non-terminal tabs (global sharing is terminal-only)', async () => {
    const { sidebar, windows } = makePair()
    const calls = stubSidebarApi()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    await windows.bindGlobal(tab)
    expect(calls).toEqual([])
    expect(windows.globalWindows()).toHaveLength(0)
  })

  it('bindGlobal works in an ungrouped session (no workspace needed for global sharing)', async () => {
    const { sidebar, windows } = makePair()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('orphan')
    sidebar.reduce(s => openTabInActivePane(s, t1))

    await windows.bindGlobal(t1)

    const stubId = windows.globalWindows()[0]!.id
    expect(stubId).toBeDefined()
    // The window parks globally — no session (workspace or not) sees a stub.
    expect(windows.windowsOfSession('a').filter(w => isGlobalTabId(w.id))).toHaveLength(0)
    // And the workspace bind itself stays disabled/no-op for this session.
    expect(windows.getSnapshot().workspaceId).toBeUndefined()
  })

  it('attachGlobal brings the window into the ACTIVE session only (and focuses an existing attachment)', () => {
    const { sidebar, windows } = makePair()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    return windows.bindGlobal(t1).then(() => {
      const stubId = windows.globalWindows()[0]!.id
      // Attach from session 'a': the stub lands in 'a's first leaf, focused,
      // and the covering panel opens so the window is in sight.
      sidebar.setSession('a')
      windows.attachGlobal(stubId)
      expect(rightLeafTabs(sidebar, 'a').filter(t => t.id === stubId)).toHaveLength(1)
      expect(firstLeaf(sidebar.getSnapshot().state!.splits).active).toBe(stubId)
      expect(sidebar.getSnapshot().state!.panelOpen).toBe(true)
      // Attaching again focuses the existing stub — no duplicate.
      windows.attachGlobal(stubId)
      expect(rightLeafTabs(sidebar, 'a').filter(t => t.id === stubId)).toHaveLength(1)
      // Other sessions are untouched — attachment is per-session.
      sidebar.setSession('b')
      sidebar.setSession('c')
      expect(rightLeafTabs(sidebar, 'b').filter(t => isGlobalTabId(t.id))).toHaveLength(0)
      expect(rightLeafTabs(sidebar, 'c').filter(t => isGlobalTabId(t.id))).toHaveLength(0)
    })
  })

  it('re-attaching a stub dragged to another leaf focuses it in place (never duplicates)', () => {
    const { sidebar, windows } = makePair()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    return windows.bindGlobal(t1).then(() => {
      const stubId = windows.globalWindows()[0]!.id
      sidebar.setSession('a')
      windows.attachGlobal(stubId)
      // Drag the attached stub into a second leaf (stubs are draggable).
      sidebar.reduce(s => splitPane(s, 'row'))
      const leaves = allLeaves(sidebar.getSnapshot().state!.splits)
      sidebar.reduce(s => moveTab(s, leaves[0]!.id, stubId, leaves[1]!.id))
      expect(allLeaves(sidebar.getSnapshot().state!.splits)[1]!.tabs.some(t => t.id === stubId)).toBe(true)
      // A re-click attaches in place — one stub, focused in the moved leaf.
      windows.attachGlobal(stubId)
      const after = allLeaves(sidebar.getSnapshot().state!.splits)
      expect(after.flatMap(l => l.tabs).filter(t => t.id === stubId)).toHaveLength(1)
      expect(after[1]!.active).toBe(stubId)
    })
  })

  it('attachGlobal targets an explicit session through reduceFor (no UI switch)', () => {
    const { sidebar, windows } = makePair()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    return windows.bindGlobal(t1).then(() => {
      const stubId = windows.globalWindows()[0]!.id
      // Attach to session 'b' WHILE 'a' is the active session: the open
      // lands in 'b's layout without switching the UI.
      windows.attachGlobal(stubId, 'b')
      expect(sidebar.getSnapshot().sessionId).toBe('a')
      expect(rightLeafTabs(sidebar, 'a').filter(t => isGlobalTabId(t.id))).toHaveLength(0)
      expect(rightLeafTabs(sidebar, 'b').filter(t => t.id === stubId)).toHaveLength(1)
    })
  })

  it('a bottom-area global window attaches into the bottom box (the area follows the original)', () => {
    const { sidebar, windows } = makePair()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    // Land the terminal in the BOTTOM tree before binding.
    sidebar.reduce(s => ({ ...s, activePane: firstLeaf(s.bottomSplits).id }))
    sidebar.reduce(s => openTabInActivePane(s, t1))
    return windows.bindGlobal(t1).then(() => {
      const stubId = windows.globalWindows()[0]!.id
      expect(windows.globalWindows()[0]!.area).toBe('bottom')
      sidebar.setSession('a')
      windows.attachGlobal(stubId)
      expect(bottomLeafTabs(sidebar, 'a').filter(t => t.id === stubId)).toHaveLength(1)
      expect(sidebar.getSnapshot().state!.bottomOpen).toBe(true)
      expect(rightLeafTabs(sidebar, 'a').filter(t => isGlobalTabId(t.id))).toHaveLength(0)
    })
  })

  it('detachGlobal removes the stub from the ACTIVE session only (the window lives on)', () => {
    const { sidebar, windows } = makePair()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    return windows.bindGlobal(t1).then(() => {
      const stubId = windows.globalWindows()[0]!.id
      sidebar.setSession('a')
      windows.attachGlobal(stubId)
      sidebar.setSession('b')
      windows.attachGlobal(stubId)
      // Detach from 'a': the local attachment is removed; 'b's survives and
      // the window itself stays in the Global Workspace.
      sidebar.setSession('a')
      windows.detachGlobal(stubId)
      expect(rightLeafTabs(sidebar, 'a').filter(t => t.id === stubId)).toHaveLength(0)
      expect(rightLeafTabs(sidebar, 'b').filter(t => t.id === stubId)).toHaveLength(1)
      expect(windows.globalWindows().map(w => w.id)).toEqual([stubId])
    })
  })

  it('unbindGlobal(false) removes the window from the Global Workspace and strips attached stubs from EVERY session', async () => {
    const { sidebar, windows } = makePair()
    const calls = stubSidebarApi()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    await windows.bindGlobal(t1)
    const stubId = windows.globalWindows()[0]!.id
    sidebar.setSession('a')
    windows.attachGlobal(stubId)
    sidebar.setSession('b')
    windows.attachGlobal(stubId)
    sidebar.setSession('a')
    calls.length = 0

    await windows.unbindGlobal(stubId, false)

    expect(windows.globalWindows()).toHaveLength(0)
    for (const session of ['a', 'b']) {
      expect(rightLeafTabs(sidebar, session).filter(t => isGlobalTabId(t.id))).toHaveLength(0)
    }
    // The shared pty is released explicitly (the never-attached headless
    // case; attached stubs' unmount close frames cover the attached case).
    expect(calls).toEqual([
      { method: 'pty.close', payload: { sessionId: 'a', tab: stubId } },
    ])
  })

  it('unbindGlobal(keep) materializes the terminal as a local tab in the active session', async () => {
    const { sidebar, windows } = makePair()
    const calls = stubSidebarApi()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    await windows.bindGlobal(t1)
    const stubId = windows.globalWindows()[0]!.id
    sidebar.setSession('a')
    windows.attachGlobal(stubId)
    calls.length = 0

    await windows.unbindGlobal(stubId, true)

    // The window left the Global Workspace; the attached stub in the active
    // session (a) became a fresh local terminal, its pty re-parented back.
    expect(windows.globalWindows()).toHaveLength(0)
    const local = rightLeafTabs(sidebar, 'a').find(t => t.type === 'terminal')
    expect(local).toBeDefined()
    expect(isBoundTabId(local!.id)).toBe(false)
    expect(calls).toEqual([
      { method: 'pty.reparent', payload: { sessionId: 'a', from: stubId, to: local!.id } },
    ])
    // A sibling session that never attached sees nothing (no auto-merge).
    expect(rightLeafTabs(sidebar, 'b').filter(t => t.type === 'terminal')).toHaveLength(0)
  })

  it('the global blob persists; a session\u2019s ATTACHED stub persists and re-validates on reload', async () => {
    const { sidebar, windows } = makePair()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    await windows.bindGlobal(t1)
    const stubId = windows.globalWindows()[0]!.id
    sidebar.setSession('a')
    windows.attachGlobal(stubId)
    await flushPersist()

    const persisted = JSON.parse(localStorage.getItem('dsh-sidebar:v1:global-windows')!) as {
      tabs: Array<{ id: string }>
    }
    expect(persisted.tabs.map(t => t.id)).toEqual([stubId])
    // A session-ATTACHED gb: stub now PERSISTS in the session layout (it is
    // a deliberate per-session view — unlike ws: stubs, which never persist).
    expect(localStorage.getItem('dsh-sidebar:v1:a')).toContain(stubId)

    // Reload: the attached stub is re-validated against the global blob (the
    // window is still defined → it survives); a session that never attached
    // sees nothing (no auto-merge on load).
    const { sidebar: reloaded, windows: reloadedWindows } = makePair()
    expect(rightLeafTabs(reloaded, 'a').filter(t => t.id === stubId)).toHaveLength(1)
    expect(rightLeafTabs(reloaded, 'c').filter(t => isGlobalTabId(t.id))).toHaveLength(0)
    expect(reloadedWindows.windowsOfSession('a').filter(w => isGlobalTabId(w.id))).toHaveLength(0)
  })

  it('a persisted attached stub is stripped when its window was unbound meanwhile', async () => {
    const { sidebar, windows } = makePair()
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    await windows.bindGlobal(t1)
    const stubId = windows.globalWindows()[0]!.id
    sidebar.setSession('a')
    windows.attachGlobal(stubId)
    await flushPersist()
    expect(localStorage.getItem('dsh-sidebar:v1:a')).toContain(stubId)

    await windows.unbindGlobal(stubId, false)
    await flushPersist()

    // Reload: the unbound window's stale attachment does not resurface.
    const { sidebar: reloaded } = makePair()
    expect(rightLeafTabs(reloaded, 'a').filter(t => isGlobalTabId(t.id))).toHaveLength(0)
  })

  it('global and workspace stubs coexist without cross-interference', async () => {
    const { sidebar, windows } = makePair()
    // Bind a file to workspace A (sessions a/b).
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    await windows.bind(tab)
    const wsStub = windows.getSnapshot().windows[0]!.id
    // Then globally share a terminal and attach it in session 'a' only.
    const t1 = terminalTab('terminal:1')
    sidebar.setSession('a')
    sidebar.reduce(s => openTabInActivePane(s, t1))
    await windows.bindGlobal(t1)
    const gbStub = windows.globalWindows()[0]!.id
    sidebar.setSession('a')
    windows.attachGlobal(gbStub)

    // Session 'a' (workspace A) sees BOTH stubs; session 'b' (workspace A)
    // sees ONLY the workspace one (it never attached the global window);
    // session 'c' (workspace B) sees NEITHER.
    const aStubs = rightLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id)).map(t => t.id)
    expect(aStubs).toContain(wsStub)
    expect(aStubs).toContain(gbStub)
    expect(rightLeafTabs(sidebar, 'b').some(t => t.id === gbStub)).toBe(false)
    expect(rightLeafTabs(sidebar, 'b').some(t => t.id === wsStub)).toBe(true)
    expect(rightLeafTabs(sidebar, 'c').some(t => t.id === gbStub)).toBe(false)
    expect(rightLeafTabs(sidebar, 'c').some(t => t.id === wsStub)).toBe(false)
    expect(windows.windowsOfSession('c').some(w => w.id === wsStub)).toBe(false)
  })
})
