/**
 * Auto-activation regressions for issue #162: background activity (a new
 * subagent, a new background job) activates the Tasks page in DSH's NATIVE
 * right Sidebar — the column the two auto-open switches and the README promise
 * ("wide viewports also expand the sidebar, while narrow full-screen drawers
 * are not forced open"). The plugin's own bottom workbench is NOT that
 * surface: it serves only its own flows (its + menu, the first-expansion
 * auto-terminal), so a background activation must leave it exactly as it was.
 *
 * The narrow half of that promise is a PARK: the host draws the native column
 * fullscreen below 768px and expands it on every open, so the activation places
 * the tab and puts the column back to collapsed (src/client/sidebar/
 * use-host-feeds.ts `activateTasksPage`). The topology jump-back is an explicit
 * user gesture and always takes the host's expansion.
 *
 * "The current conversation" is the native surface's MOUNTED seat
 * (`ctx.sidebarRight.mounted`): the session-list snapshot never carried a
 * current-session field, so the park gate used to read a phantom one and was
 * permanently false. Background jobs are likewise no longer mirrored into that
 * snapshot — the trigger polls the plugin's `jobs.list` route, so a job is
 * delivered by mutating the stubbed registry and advancing the poll.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, useRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import { allLeaves, createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import {
  createBetterSidebarService,
  type BetterSidebarService,
  type SidebarSurface,
  type TabComponentProps,
} from '../src/client/service.ts'
import type { Context, SidebarJobView, SidebarSessionList } from '../src/context-types.ts'

class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(_url: string) {}
}

function makeSessionFeed(initial: SidebarSessionList) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: SidebarSessionList): void {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

type SessionFeed = ReturnType<typeof makeSessionFeed>

/** One recorded native-surface open. */
interface NativeOpen {
  sessionId: string
  kind: string
  params: unknown
  revealIfOpened: boolean
}

/** The native right Sidebar, replaced by a recording stand-in: the shell's
 *  opens must reach THIS surface, not the plugin's own layout. */
interface NativeSurfaceSpy {
  surface: SidebarSurface
  opens: NativeOpen[]
}

function makeNativeSurfaceSpy(): NativeSurfaceSpy {
  const opens: NativeOpen[] = []
  return {
    opens,
    surface: {
      openTab: input => { opens.push({ ...input }) },
      openResource: () => {},
      fileAddress: (sessionId, cwd, path) => `addr://${sessionId}${cwd ?? ''}${path}`,
      close: () => undefined,
      update: () => false,
      activate: () => false,
      has: () => false,
    },
  }
}

/** A subscribable seat observable (mirror of `ISidebarRight.mounted`). */
function makeMountedStore(initial: string | undefined) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: string | undefined): void {
      if (next === snapshot) return
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

type MountedStore = ReturnType<typeof makeMountedStore>

/** `ctx.sidebarRight`, replaced by a stand-in column: `isExpanded` reports the
 *  current state, `toggleExpanded` flips it and counts the calls, and `mounted`
 *  is the seat observation the shell binds its per-session state to. */
interface NativeColumnSpy {
  face: { isExpanded: () => boolean; toggleExpanded: () => void; mounted: MountedStore }
  toggles: number
  mounted: MountedStore
}

function makeNativeColumnSpy(expanded: boolean, mounted: string | undefined): NativeColumnSpy {
  const spy = {
    toggles: 0,
    expanded,
    mounted: makeMountedStore(mounted),
    face: {} as { isExpanded: () => boolean; toggleExpanded: () => void; mounted: MountedStore },
  }
  spy.face = {
    isExpanded: () => spy.expanded,
    toggleExpanded: () => {
      spy.toggles += 1
      spy.expanded = !spy.expanded
    },
    mounted: spy.mounted,
  }
  return spy
}

/** Stands in for the Tasks page: its node click is the jump gesture that arms
 *  the shell's jump-back (fired once, like a real click). */
function JumpHarness({ onSubagentJump }: TabComponentProps): ReactNode {
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    onSubagentJump?.('child')
  }, [onSubagentJump])
  return null
}

interface MountedSidebar {
  store: SidebarStore
  service: BetterSidebarService
  feed: SessionFeed
  surface: NativeSurfaceSpy
  column: NativeColumnSpy
  sessionId: string
  /** The stubbed `jobs.list` registry, keyed by OWNER session (mutable). */
  jobs: Record<string, SidebarJobView[]>
  unmount: () => void
}

let sessionSeq = 0
const mounted: MountedSidebar[] = []
/** Owner sessions the stubbed `jobs.list` route was read for. */
const jobListReads: string[] = []

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

function mountSidebar(
  width: number,
  bottomOpen = false,
  options: { columnExpanded?: boolean } = {},
): MountedSidebar {
  setViewport(width)
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const sessionId = `auto-activation-${++sessionSeq}`
  const initial: SidebarSessionList = {
    byId: {
      [sessionId]: { id: sessionId, cwd: '/tmp', displayTitle: 'Root' },
    },
  }
  const feed = makeSessionFeed(initial)
  const jobs: Record<string, SidebarJobView[]> = {}
  // The jobs feed is polled through the plugin's own route (0.1.7 removed the
  // snapshot's jobs mirror): the registry below is what a test mutates.
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()
    if (method !== 'jobs.list') throw new Error(`unexpected fetch ${String(url)}`)
    const body = JSON.parse(String(init?.body)) as { sessionId?: string }
    const owner = body.sessionId ?? ''
    jobListReads.push(owner)
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { jobs: jobs[owner] ?? [] } }),
    } as unknown as Response
  })
  const store = createSidebarStore()
  store.setPrefs({ ...store.getPrefs(), autoOpenSubagent: true, autoOpenJobs: true })
  store.setSession(sessionId)
  store.reduce(state => ({ ...state, bottomOpen }))
  const service = createBetterSidebarService(store)
  const surface = makeNativeSurfaceSpy()
  service.setSurface(surface.surface)
  service.registerTab({ id: 'subagent', title: 'Subagent', component: JumpHarness })
  const column = makeNativeColumnSpy(options.columnExpanded ?? false, sessionId)
  const localeSnapshot = { active: 'en' }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: feed },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar'
      ? service
      : name === 'sidebarRight' ? column.face : undefined,
  } as unknown as Context
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx, store })) })
  const result = {
    store,
    service,
    feed,
    surface,
    column,
    sessionId,
    jobs,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
  mounted.push(result)
  return result
}

type ActivitySource = 'subagent' | 'job'

/** Deliver one piece of background activity through the host's own feeds. */
async function publishActivity(sidebar: MountedSidebar, source: ActivitySource): Promise<void> {
  if (source === 'job') {
    await publishJob(sidebar)
    return
  }
  publishSubagent(sidebar)
  flushSubagentDebounce()
}

function publishSubagent(sidebar: MountedSidebar): void {
  const before = sidebar.feed.getSnapshot()
  act(() => {
    sidebar.feed.set({
      ...before,
      byId: {
        ...before.byId,
        child: {
          id: 'child',
          displayTitle: 'Worker',
          origin: 'subagent',
          parentId: sidebar.sessionId,
          running: true,
        },
      },
    })
  })
}

function flushSubagentDebounce(): void {
  act(() => { vi.advanceTimersByTime(500) })
}

/**
 * Deliver one new job through the polled jobs route: let the mount-time
 * baseline read land, register the job, then advance one poll interval.
 */
async function publishJob(sidebar: MountedSidebar): Promise<void> {
  await flushFeeds()
  sidebar.jobs[sessionIdOf(sidebar)] = [{
    id: 'bash-1',
    kind: 'bash',
    label: 'sleep 30',
    status: 'running',
    startedAt: 1_000,
  }]
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
}

/** The conversation the sidebar is bound to (its own store's session). */
function sessionIdOf(sidebar: MountedSidebar): string {
  return sidebar.store.getSnapshot().sessionId ?? sidebar.sessionId
}

/** Let pending microtasks settle (the polled reads resolve outside timers). */
async function flushFeeds(): Promise<void> {
  for (let tick = 0; tick < 4; tick++) {
    await act(async () => { await Promise.resolve() })
  }
}

/** Switch the conversation to the child session the Tasks page jumped to. */
function switchToChild(sidebar: MountedSidebar): void {
  const before = sidebar.feed.getSnapshot()
  act(() => {
    sidebar.feed.set({
      ...before,
      byId: {
        ...before.byId,
        child: {
          id: 'child',
          displayTitle: 'Worker',
          origin: 'subagent',
          parentId: sidebar.sessionId,
          running: true,
        },
      },
    })
    // The mounted seat is what moves the conversations: the shell binds its
    // per-session state to it (the session list has no current-session field).
    sidebar.column.mounted.set('child')
  })
}

/** The Tasks page landed in the native right Sidebar (the default open). */
function expectNativeTasksOpen(sidebar: MountedSidebar, sessionId: string): void {
  expect(sidebar.surface.opens).toEqual([{
    sessionId,
    kind: 'subagent',
    params: expect.objectContaining({ title: expect.any(String) }),
    revealIfOpened: true,
  }])
}

/** The plugin's own bottom workbench kept its own state and gained no tab. */
function expectWorkbenchUntouched(sidebar: MountedSidebar, open = false): void {
  const state = sidebar.store.getSnapshot().state!
  expect(state.bottomOpen).toBe(open)
  expect(allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'subagent')).toHaveLength(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
  setViewport(1024)
})

describe('Sidebar background-activity auto-activation (#162)', () => {
  it.each([
    { source: 'subagent', width: 390 },
    { source: 'job', width: 390 },
    { source: 'subagent', width: 1024 },
    { source: 'job', width: 1024 },
  ] as const)('$source activation at $width px activates the Tasks page in the native Sidebar', async ({ source, width }) => {
    const sidebar = mountSidebar(width)
    await publishActivity(sidebar, source)
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expectWorkbenchUntouched(sidebar)
    // Parking is the narrow-viewport half of the same promise.
    expect(sidebar.column.toggles).toBe(width < 768 ? 1 : 0)
  })

  it.each(['subagent', 'job'] as const)('%s activation leaves a narrow fullscreen column to the park', async (source) => {
    const sidebar = mountSidebar(390)
    await publishActivity(sidebar, source)
    expect(sidebar.column.toggles).toBe(1)
  })

  it('a narrow column the user already expanded is not closed under them', async () => {
    const sidebar = mountSidebar(390, false, { columnExpanded: true })
    await publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expect(sidebar.column.toggles).toBe(0)
  })

  it('a page that loads with jobs already running never triggers; the next NEW job does', async () => {
    const sidebar = mountSidebar(1024)
    // The conversation is already running work when the sidebar mounts: the
    // first successful read only ARMS the baseline, it is never "new work".
    sidebar.jobs[sidebar.sessionId] = [{
      id: 'bash-0',
      kind: 'bash',
      label: 'already running',
      status: 'running',
      startedAt: 500,
    }]
    await flushFeeds()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(sidebar.surface.opens).toEqual([])
    // A second, genuinely new job id is what surfaces the Tasks page.
    sidebar.jobs[sidebar.sessionId] = [
      ...sidebar.jobs[sidebar.sessionId] ?? [],
      { id: 'bash-1', kind: 'bash', label: 'sleep 30', status: 'running', startedAt: 1_000 },
    ]
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
  })

  it('a session switch re-arms the job baseline instead of firing on the new session\'s jobs', async () => {
    const sidebar = mountSidebar(1024)
    sidebar.jobs['child'] = [{ id: 'bash-9', kind: 'bash', label: 'child work', status: 'running', startedAt: 10 }]
    switchToChild(sidebar)
    await flushFeeds()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    // The child's pre-existing job belongs to the NEW baseline, not to "new
    // work in the session I am looking at" (the baseline resets on session).
    expect(sidebar.surface.opens).toEqual([])
  })

  it('reads the viewport when the debounced activation fires, not when it arms', () => {
    const sidebar = mountSidebar(1024)
    publishSubagent(sidebar)
    setViewport(390)
    flushSubagentDebounce()
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expect(sidebar.column.toggles).toBe(1)
  })

  it('leaves an already-open bottom workbench open and untouched', async () => {
    const sidebar = mountSidebar(1024, true)
    await publishActivity(sidebar, 'subagent')
    expectNativeTasksOpen(sidebar, sidebar.sessionId)
    expectWorkbenchUntouched(sidebar, true)
  })

  it('the topology jump-back opens the Tasks page for the child session and never parks it', () => {
    const sidebar = mountSidebar(390)
    // The Tasks page the user opened in the workbench (its own + menu) is what
    // arms the jump: its node click records the child session.
    act(() => {
      sidebar.service.openTab(
        { type: 'subagent', title: 'Tasks', target: 'bottom' },
        { sessionId: sidebar.sessionId },
      )
    })
    expect(sidebar.store.getSnapshot().state!.bottomOpen).toBe(true)
    switchToChild(sidebar)
    expectNativeTasksOpen(sidebar, 'child')
    expect(sidebar.column.toggles).toBe(0)
  })
})
