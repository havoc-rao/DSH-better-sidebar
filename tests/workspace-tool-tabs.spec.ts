/**
 * Workspace files/Git membership follows the full native inventory, not mounted
 * bodies. Reconciliation must suppress its own changes, preserve real content
 * selection/collapse, respect explicit closes, and wait for adoption/membership.
 * The persistence store is real; only public host observable faces are mocked.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceToolTabsStore } from '../src/client/workspace-tool-tabs-store.ts'
import {
  retainGitToolCloseGuard, syncWorkspaceToolTabs,
  type WorkspaceMembership, type WorkspaceTabsController,
} from '../src/client/workspace-tool-tabs.ts'

class Source<T> {
  readonly listeners = new Set<() => void>()
  constructor(private value: T) {}
  getSnapshot = (): T => this.value
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(value: T): void { this.value = value; this.pulse() }
  pulse(): void { for (const listener of [...this.listeners]) listener() }
}
type Row = { sessionId: string; tabId: string; kind: string; contentId: string }
const row = (sessionId: string, kind: string, tabId = `${sessionId}-${kind}`): Row =>
  ({ sessionId, kind, tabId, contentId: `dsh-resource://page/${kind}` })
const membership = (): WorkspaceMembership => ({
  phase: 'ready', state: 'idle', items: [
    { workspaceId: 'w1', path: '/one', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', path: '/two', sessionIds: ['s3'] },
  ],
})
const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
const flush = async (): Promise<void> => {
  // Initial schedule and any subscription follow-up both settle deterministically.
  for (let n = 0; n < 5; n++) await Promise.resolve()
}
function fixture(initial: Row[] = [], initialSession = 's1') {
  const mounted = new Source<string | undefined>(initialSession)
  const openTabs = new Source<readonly Row[]>(initial)
  const workspaces = new Source(membership())
  const enabled = new Source({ files: true, git: true })
  const store = createWorkspaceToolTabsStore({ namespace: 'sync-test' })
  const adopted = new Set(['s1', 's2', 's3'])
  const selected = new Map<string, string>()
  const expanded = new Map<string, boolean>([['s1', true], ['s2', true], ['s3', true]])
  for (const item of initial) if (!selected.has(item.sessionId)) selected.set(item.sessionId, item.tabId)
  const controller: WorkspaceTabsController = {
    mounted, openTabs,
    tabsIn: sid => adopted.has(sid) ? openTabs.getSnapshot().filter(item => item.sessionId === sid)
      .map(item => ({ id: item.tabId, kind: item.kind })) : [],
    commandTarget: vi.fn(() => adopted.has(mounted.getSnapshot() ?? '') ? {} : undefined),
    openTab: vi.fn(kind => {
      const sid = mounted.getSnapshot()!
      if (!adopted.has(sid)) throw new Error('sidebarRight: no session surface is mounted')
      const item = row(sid, kind)
      selected.set(sid, item.tabId)
      expanded.set(sid, true)
      openTabs.set([...openTabs.getSnapshot(), item])
    }),
    close: vi.fn(tabId => {
      const sid = mounted.getSnapshot()!
      openTabs.set(openTabs.getSnapshot().filter(item => item.sessionId !== sid || item.tabId !== tabId))
    }),
    active: () => {
      const item = openTabs.getSnapshot().find(item => item.sessionId === mounted.getSnapshot()
        && item.tabId === selected.get(item.sessionId))
      return item && { id: item.tabId, kind: item.kind }
    },
    focus: vi.fn(tabId => { selected.set(mounted.getSnapshot()!, tabId) }),
    isExpanded: () => expanded.get(mounted.getSnapshot()!) ?? false,
    toggleExpanded: vi.fn(() => {
      const sid = mounted.getSnapshot()!
      expanded.set(sid, !expanded.get(sid))
      // Model the host's synchronous pane focus during expansion compensation.
      document.querySelector<HTMLElement>('[data-test-pane]')?.focus()
    }),
  }
  const start = () => {
    const dispose = syncWorkspaceToolTabs({ controller, workspaces, store,
      enabled: kind => enabled.getSnapshot()[kind], subscribeEnabled: enabled.subscribe })
    disposers.push(dispose, () => store.dispose())
    return dispose
  }
  const kinds = (sid: string) => openTabs.getSnapshot().filter(item => item.sessionId === sid).map(item => item.kind)
  return { controller, mounted, openTabs, workspaces, enabled, store, adopted, selected, expanded, start, kinds }
}

describe('syncWorkspaceToolTabs', () => {
  it('inherits both tools from saved/unvisited tabs in the same workspace exactly once', async () => {
    const f = fixture([row('s2', 'files'), row('s2', 'git'), row('s1', 'editor')])
    f.start(); await flush()
    expect(f.kinds('s1')).toEqual(['editor', 'files', 'git'])
    expect(f.store.read('w1')).toEqual(['files', 'git'])
    f.openTabs.pulse(); f.workspaces.pulse(); await flush()
    expect(f.controller.openTab).toHaveBeenCalledTimes(2)
  })

  it('keeps different workspace memberships isolated and never copies editor resources', async () => {
    const f = fixture([row('s2', 'files'), row('s2', 'editor'), row('s3', 'git')])
    f.start(); await flush()
    expect(f.kinds('s1')).toEqual(['files'])
    f.mounted.set('s3'); await flush()
    expect(f.kinds('s3')).toEqual(['git'])
    expect(f.store.read('w2')).toEqual(['git'])
    expect(f.controller.openTab).toHaveBeenCalledExactlyOnceWith('files')
  })

  it('records a local close and removes the inherited tool on the next session switch', async () => {
    const f = fixture([row('s1', 'files'), row('s2', 'files')])
    f.start(); await flush()
    f.openTabs.set(f.openTabs.getSnapshot().filter(item => item.sessionId !== 's1'))
    await flush()
    expect(f.store.read('w1')).toEqual([])
    f.mounted.set('s2'); await flush()
    expect(f.kinds('s2')).toEqual([])
    expect(f.controller.close).toHaveBeenCalledWith('s2-files')
  })

  it('suppresses reconciliation feedback so a remote desired close never resurrects', async () => {
    const f = fixture([row('s1', 'git')])
    f.start(); await flush()
    f.store.set('w1', 'git', false); await flush()
    f.openTabs.pulse(); f.workspaces.pulse(); await flush()
    expect(f.kinds('s1')).toEqual([])
    expect(f.store.read('w1')).toEqual([])
    expect(f.controller.openTab).not.toHaveBeenCalled()
    expect(f.controller.close).toHaveBeenCalledTimes(1)
  })

  it('never probes TabDomain readiness inside the synchronous inventory publish', async () => {
    const f = fixture([row('s1', 'files')])
    f.start(); await flush()
    const probe = vi.mocked(f.controller.commandTarget)
    probe.mockImplementation(() => { throw new Error('tab has no committed occurrence') })
    expect(() => f.openTabs.set([...f.openTabs.getSnapshot(), row('s1', 'git')])).not.toThrow()
    probe.mockImplementation(() => ({}))
    await flush()
    expect(f.store.read('w1')).toEqual(['files', 'git'])
  })

  it('keeps an existing editor selected when inherited tools open', async () => {
    const f = fixture([row('s1', 'editor'), row('s2', 'files'), row('s2', 'git')])
    f.start(); await flush()
    expect(f.controller.active()).toEqual({ id: 's1-editor', kind: 'editor' })
    expect(f.controller.focus).toHaveBeenCalledWith('s1-editor')
  })

  it('reveals inherited tools in a newly entered default-collapsed empty session', async () => {
    const f = fixture([row('s1', 'files'), row('s1', 'git')])
    f.expanded.set('s2', false)
    f.start(); await flush()
    f.mounted.set('s2'); await flush()
    expect(f.kinds('s2')).toEqual(['files', 'git'])
    expect(f.controller.isExpanded()).toBe(true)
    expect(f.controller.toggleExpanded).not.toHaveBeenCalled()
    // User collapse is respected when subsequent remote opens arrive.
    f.expanded.set('s2', false)
    f.store.set('w1', 'git', false); await flush()
    f.store.set('w1', 'git', true); await flush()
    expect(f.controller.isExpanded()).toBe(false)
  })

  it('reveals inherited tools when first opening a guide-only session', async () => {
    const f = fixture([row('s1', 'guide'), row('s2', 'files')])
    f.expanded.set('s1', false)
    f.start(); await flush()
    expect(f.controller.isExpanded()).toBe(true)
    expect(f.kinds('s1')).toEqual(['guide', 'files'])
  })

  it('preserves collapse and outside input focus after host synchronous focus effects', async () => {
    const input = document.createElement('input')
    const pane = document.createElement('div')
    pane.tabIndex = -1; pane.dataset.testPane = ''
    document.body.append(input, pane); input.focus()
    const f = fixture([row('s1', 'editor'), row('s2', 'files')])
    f.expanded.set('s1', false)
    f.start(); await flush()
    expect(f.controller.isExpanded()).toBe(false)
    expect(f.controller.toggleExpanded).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(input)
    expect(f.controller.active()?.kind).toBe('editor')
  })

  it('does nothing for unknown, pending, or failed workspace membership', async () => {
    const f = fixture([row('s2', 'files')], 'unaccounted')
    f.start(); await flush()
    expect(f.controller.openTab).not.toHaveBeenCalled()
    f.mounted.set('s1')
    f.workspaces.set({ ...membership(), phase: 'pending' }); await flush()
    expect(f.store.read('w1')).toBeUndefined()
    f.workspaces.set({ ...membership(), state: 'error' }); await flush()
    expect(f.controller.openTab).not.toHaveBeenCalled()
    f.workspaces.set(membership()); await flush()
    expect(f.kinds('s1')).toEqual(['files'])
  })

  it('waits for commandTarget adoption readiness and retries on a later observable pulse', async () => {
    // Avoid an actual RAF retry loop: explicitly model the next public pulse.
    vi.stubGlobal('requestAnimationFrame', undefined)
    const f = fixture([row('s1', 'editor'), row('s2', 'files')])
    f.adopted.delete('s1')
    f.start(); await flush()
    expect(f.controller.openTab).not.toHaveBeenCalled()
    expect(f.store.read('w1')).toBeUndefined()
    f.adopted.add('s1'); f.workspaces.pulse(); await flush()
    expect(f.controller.openTab).toHaveBeenCalledExactlyOnceWith('files')
  })

  it('waits for adoption before seeding or opening tools into a fresh empty seat', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    const f = fixture([row('s2', 'files')])
    f.adopted.delete('s1')
    f.start(); await flush()
    expect(f.controller.openTab).not.toHaveBeenCalled()
    expect(f.kinds('s1')).toEqual([])
    expect(f.store.read('w1')).toBeUndefined()
    f.adopted.add('s1'); f.workspaces.pulse(); await flush()
    expect(f.kinds('s1')).toEqual(['files'])
    expect(f.store.read('w1')).toEqual(['files'])
    expect(f.controller.openTab).toHaveBeenCalledTimes(1)
  })

  it('captures a local close before an immediate same-task session switch', async () => {
    const f = fixture([row('s1', 'files'), row('s2', 'files')])
    f.start(); await flush()
    // Inventory notification and mounted change share one queued microtask.
    f.openTabs.set(f.openTabs.getSnapshot().filter(item => item.sessionId !== 's1'))
    expect(f.store.read('w1'), 'close intent is recorded synchronously').toEqual([])
    f.mounted.set('s2')
    await flush()
    expect(f.store.read('w1')).toEqual([])
    expect(f.kinds('s2')).toEqual([])
    expect(f.controller.openTab).not.toHaveBeenCalled()
  })

  it('keeps an explicit false when late adoption replaces empty inventory with stale files', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    const f = fixture([row('s1', 'editor')])
    f.store.set('w1', 'files', false)
    f.start(); await flush()
    f.adopted.delete('s2'); f.mounted.set('s2'); await flush()
    expect(f.controller.commandTarget(null)).toBeUndefined()
    expect(f.kinds('s2')).toEqual([])
    // Saved records can appear before or during adoption without being a user open.
    f.openTabs.set([...f.openTabs.getSnapshot(), row('s2', 'files')])
    await flush()
    expect(f.store.read('w1')).toEqual([])
    expect(f.controller.close).not.toHaveBeenCalled()
    f.adopted.add('s2'); f.workspaces.pulse(); await flush()
    expect(f.store.read('w1')).toEqual([])
    expect(f.kinds('s2')).toEqual([])
    expect(f.controller.close).toHaveBeenCalledWith('s2-files')
    expect(f.controller.openTab).not.toHaveBeenCalled()
  })

  it('bounds readiness retries to sixty animation frames and cancels a pending frame on dispose', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextId = 0
    const raf = vi.fn((callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId })
    const cancel = vi.fn((id: number) => { frames.delete(id) })
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const f = fixture([row('s2', 'files')])
    f.adopted.delete('s1')
    const dispose = f.start(); await flush()
    for (let n = 0; n < 60; n++) {
      expect(frames.size).toBe(1)
      const [id, callback] = [...frames][0]!
      frames.delete(id); callback(n * 16)
      await flush()
    }
    expect(raf).toHaveBeenCalledTimes(60)
    expect(frames.size).toBe(0)
    f.workspaces.pulse(); await flush()
    expect(raf).toHaveBeenCalledTimes(60)
    expect(f.store.read('w1')).toBeUndefined()
    expect(f.controller.openTab).not.toHaveBeenCalled()
    // A new mounted session gets its own bounded adoption attempt.
    f.adopted.delete('s2'); f.mounted.set('s2'); await flush()
    expect(frames.size).toBe(1)
    const [pendingId, pendingCallback] = [...frames][0]!
    dispose()
    expect(cancel).toHaveBeenCalledWith(pendingId)
    expect(frames.size).toBe(0)
    // Even a browser callback already delivered before cancellation is harmless.
    pendingCallback(1_000); await flush()
    expect(raf).toHaveBeenCalledTimes(61)
    expect(f.controller.openTab).not.toHaveBeenCalled()
  })

  it('does not resurrect explicit tombstones when switching to a stale saved session', async () => {
    const f = fixture([row('s1', 'files'), row('s2', 'files'), row('s2', 'git')])
    f.store.set('w1', 'files', false)
    f.store.set('w1', 'git', false)
    f.start(); await flush()
    f.mounted.set('s2'); await flush()
    expect(f.kinds('s1')).toEqual([])
    expect(f.kinds('s2')).toEqual([])
    expect(f.store.read('w1')).toEqual([])
    expect(f.controller.openTab).not.toHaveBeenCalled()
  })

  it('defers disabled tools without erasing desired membership and applies on enable', async () => {
    const f = fixture([row('s2', 'files'), row('s2', 'git')])
    f.enabled.set({ files: false, git: true })
    f.start(); await flush()
    expect(f.kinds('s1')).toEqual(['git'])
    expect(f.store.read('w1')).toEqual(['files', 'git'])
    f.enabled.set({ files: true, git: true }); await flush()
    expect(f.kinds('s1')).toEqual(['git', 'files'])
  })

  it('defers remote Git close while a busy/confirmation lease exists and closes on release', async () => {
    const f = fixture([row('s1', 'git')])
    const release = retainGitToolCloseGuard('s1', true)
    disposers.push(release)
    f.start(); await flush()
    f.store.set('w1', 'git', false); await flush()
    expect(f.kinds('s1')).toEqual(['git'])
    expect(f.controller.close).not.toHaveBeenCalled()
    release(); await flush()
    expect(f.kinds('s1')).toEqual([])
    expect(f.store.read('w1')).toEqual([])
  })

  it('unsubscribes on dispose and prevents queued or later reconciliation work', async () => {
    const f = fixture([row('s2', 'files')])
    const dispose = f.start()
    expect(f.openTabs.listeners.size).toBe(1)
    expect(f.mounted.listeners.size).toBe(1)
    expect(f.workspaces.listeners.size).toBe(1)
    expect(f.enabled.listeners.size).toBe(1)
    dispose(); await flush()
    for (const source of [f.openTabs, f.mounted, f.workspaces, f.enabled]) expect(source.listeners.size).toBe(0)
    f.store.set('w1', 'files', true)
    f.openTabs.pulse(); f.mounted.pulse(); f.workspaces.pulse(); f.enabled.pulse()
    const release = retainGitToolCloseGuard('s1', true); release()
    await flush()
    expect(f.controller.openTab).not.toHaveBeenCalled()
    expect(f.controller.close).not.toHaveBeenCalled()
  })
})
