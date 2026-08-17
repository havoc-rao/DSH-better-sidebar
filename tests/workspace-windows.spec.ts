/**
 * Workspace-windows store tests: bind/unbind/update semantics, the
 * per-workspace persistence blob (sanitize, stable stub ids), the
 * session→workspace resolution, and the SidebarStore reconcile wiring
 * (bound windows appear/update/disappear in every session of a workspace;
 * session layouts never persist stubs).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  allLeaves, createSidebarStore, firstLeaf, isBoundTabId, openTabInActivePane,
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

/** The bottom box's first-leaf tabs of a session state (bound-window stubs
 *  live in the BOTTOM tree; switches to the session). */
function firstLeafTabs(store: SidebarStore, sessionId: string): SidebarTab[] {
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
    expect(isBoundTabId(bound.id)).toBe(true)

    // Every session of the workspace holds the stub in the BOTTOM box's
    // first leaf; the binding session's local tab is gone (no local +
    // bound duplicate), and the bottom panel opened so the pin is in sight.
    expect(firstLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id)).map(t => t.id)).toEqual([bound.id])
    expect(firstLeafTabs(sidebar, 'b').filter(t => isBoundTabId(t.id)).map(t => t.id)).toEqual([bound.id])
    // A session of ANOTHER workspace never sees it.
    expect(firstLeafTabs(sidebar, 'c').every(t => !isBoundTabId(t.id))).toBe(true)

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

    // The bottom box opened and its first leaf's active moved to the stub.
    const state = sidebar.getSnapshot().state!
    expect(state.bottomOpen).toBe(true)
    expect(firstLeaf(state.bottomSplits).active).toBe(windows.getSnapshot().windows[0]!.id)
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
    const leaf = firstLeaf(sidebar.getSnapshot().state!.bottomSplits)
    // The stray local duplicate is gone (only the id-only stub remains).
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
    const local = firstLeafTabs(sidebar, 'a').filter(t => t.path === '/ws-a/src/a.ts')
    expect(local).toHaveLength(1)
    expect(isBoundTabId(local[0]!.id)).toBe(false)
    expect(firstLeaf(sidebar.getSnapshot().state!.bottomSplits).active).toBe(local[0]!.id)
    // The other session lost the window entirely.
    expect(firstLeafTabs(sidebar, 'b').every(t => !isBoundTabId(t.id))).toBe(true)
  })

  it('unbind(false) closes the window everywhere', () => {
    const { sidebar, windows } = makePair()
    const tab = openFileTab(sidebar, 'a', '/ws-a/src/a.ts')
    windows.bind(tab)
    const stubId = windows.getSnapshot().windows[0]!.id

    windows.unbind(stubId, false)

    expect(windows.getSnapshot().windows).toHaveLength(0)
    expect(firstLeafTabs(sidebar, 'a').every(t => !isBoundTabId(t.id))).toBe(true)
    expect(firstLeafTabs(sidebar, 'b').every(t => !isBoundTabId(t.id))).toBe(true)
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
    expect(firstLeafTabs(sidebar, 'b')[0]!.path).toBeUndefined()
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
    const stubs = firstLeafTabs(reloaded, 'a').filter(t => isBoundTabId(t.id))
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
    expect(firstLeafTabs(reloaded, 'a').every(t => !isBoundTabId(t.id))).toBe(true)
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
    const cTabs = firstLeafTabs(sidebar, 'c')
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
    const stubId = bound[0]!.id
    // The bound local tab left the RIGHT tree; the OTHER local terminal
    // survives untouched.
    const rightTabs = firstLeaf(sidebar.getSnapshot().state!.splits).tabs
    expect(rightTabs.some(t => t.id === 'terminal:1')).toBe(false)
    expect(rightTabs.some(t => t.id === 'terminal:2')).toBe(true)
    // The BOTTOM box now carries the stub (the pin lives in the bottom).
    expect(firstLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id)).map(t => t.id)).toEqual([stubId])
    // The bound tab was NOT the active one (terminal:2 opened last), so
    // the right tree's active stays where it was — only a bound ACTIVE tab
    // hands its slot to the stub.
    expect(firstLeaf(sidebar.getSnapshot().state!.splits).active).toBe('terminal:2')
    // The bottom box opened (the pin is in sight) but nothing was active
    // there — the stub did NOT steal the active slot.
    expect(sidebar.getSnapshot().state!.bottomOpen).toBe(true)
    expect(firstLeaf(sidebar.getSnapshot().state!.bottomSplits).active).toBeNull()
    // The sibling session carries the same stub (its own live terminal).
    expect(firstLeafTabs(sidebar, 'b').filter(t => isBoundTabId(t.id)).map(t => t.id)).toEqual([stubId])
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
    // Both stubs are in the binding session's first leaf.
    const stubs = firstLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id))
    expect(stubs).toHaveLength(2)
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

    // Unbind keeping the window here: the local tab restores the diff ref.
    windows.unbind(bound.id, true)
    const local = firstLeafTabs(sidebar, 'a').find(t => t.type === 'diff')
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
    expect(firstLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id))).toHaveLength(1)
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

    const local = firstLeafTabs(sidebar, 'a').find(t => t.type === 'terminal')
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
    expect(firstLeafTabs(sidebar, 'a').filter(t => isBoundTabId(t.id))).toHaveLength(1)
  })
})
