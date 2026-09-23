/**
 * The gitGraph v1 client-service seat (provider: dsh-git-graph): shape
 * check, live `ctx.get('gitGraph')` reads, one-shot-warning per degraded
 * episode, bind/unbind lifecycle and the useSyncExternalStore snapshot.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  GIT_GRAPH_PROTOCOL_VERSION,
  GIT_GRAPH_SERVICE,
  bindGitGraph,
  getGitGraphService,
  resolveGitGraphServiceV1,
  unbindGitGraph,
  useGitGraph,
} from '../src/client/git-lens-graph.ts'
import type { Context } from '../src/context-types.ts'
import type { GitGraphServiceV1 } from 'dsh-git-graph/client-contract'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** The hook must run inside a React render: a probe component captures the
 *  seat snapshot after every (re-)render. */
let observed: GitGraphServiceV1 | undefined = undefined
function Probe(): null {
  observed = useGitGraph()
  return null
}
async function mountProbe(): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(Probe))
  })
  return { root, container }
}
const readObserved = (): GitGraphServiceV1 | undefined => observed

/** A minimal structural Context fake: `get` serves the CURRENT gitGraph
 *  service through a live getter (so tests can swap provide/unload values),
 *  and `on('internal/service')` collects listeners. */
function fakeCtx(read: () => unknown): {
  ctx: Context
  emitServiceChange(): void
  listeners: () => number
} {
  const listeners = new Set<() => void>()
  const ctx = {
    get: (key: string): unknown => (key === GIT_GRAPH_SERVICE ? read() : undefined),
    on: (_event: string, listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as unknown as Context
  return {
    ctx,
    emitServiceChange: () => { for (const listener of [...listeners]) listener() },
    listeners: () => listeners.size,
  }
}

function validService(): GitGraphServiceV1 {
  return {
    protocolVersion: 1,
    // The seat only checks the shape; a stub function is enough here.
    GraphTree: (() => null) as unknown as GitGraphServiceV1['GraphTree'],
  }
}

afterEach(() => {
  unbindGitGraph()
  vi.restoreAllMocks()
})

describe('git-lens-graph (gitGraph v1 soft join)', () => {
  it('keeps the documented literal service name and protocol version', () => {
    expect(GIT_GRAPH_SERVICE).toBe('gitGraph')
    expect(GIT_GRAPH_PROTOCOL_VERSION).toBe(1)
  })

  it('accepts a protocol-1 service with a function GraphTree', () => {
    const service = validService()
    expect(resolveGitGraphServiceV1(service)).toBe(service)
  })

  it('rejects missing / null / non-object / wrong-version / partial values', () => {
    expect(resolveGitGraphServiceV1(undefined)).toBeUndefined()
    expect(resolveGitGraphServiceV1(null)).toBeUndefined()
    expect(resolveGitGraphServiceV1('graph')).toBeUndefined()
    expect(resolveGitGraphServiceV1({ protocolVersion: 2, GraphTree: () => null })).toBeUndefined()
    expect(resolveGitGraphServiceV1({ protocolVersion: 1 })).toBeUndefined()
    expect(resolveGitGraphServiceV1({ GraphTree: () => null })).toBeUndefined()
    expect(resolveGitGraphServiceV1({
      protocolVersion: 1,
      GraphTree: 'not-a-function',
    })).toBeUndefined()
  })

  it('getGitGraphService reads the live ctx value on every call (no caching)', () => {
    let current: unknown = validService()
    const { ctx } = fakeCtx(() => current)
    expect(getGitGraphService(ctx)).toBe(current)
    current = undefined
    // The same ctx now resolves undefined — the read is never cached.
    expect(getGitGraphService(ctx)).toBeUndefined()
  })

  it('warns exactly once per degraded episode and re-arms on a valid read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let current: unknown = validService()
    const { ctx } = fakeCtx(() => current)
    expect(getGitGraphService(ctx)).toBe(current)
    // Degrade: two consecutive reads warn once.
    current = null
    expect(getGitGraphService(ctx)).toBeUndefined()
    expect(getGitGraphService(ctx)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('[dsh-git-graph]')
    // A valid read re-arms the warning for the next degraded episode.
    current = validService()
    expect(getGitGraphService(ctx)).not.toBeUndefined()
    current = undefined
    expect(getGitGraphService(ctx)).toBeUndefined()
    expect(getGitGraphService(ctx)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('unbound seat resolves undefined (fallback path) without warnings after unbind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    unbindGitGraph()
    const { root, container } = await mountProbe()
    try {
      expect(readObserved()).toBeUndefined()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('the seat snapshot follows provide/unload through the internal/service bus', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let current: unknown = validService()
    const { ctx, emitServiceChange } = fakeCtx(() => current)
    bindGitGraph(ctx)
    const { root, container } = await mountProbe()
    try {
      expect(readObserved()).toBe(current)
      // Provider unloads: the subscription re-renders consumers, the snapshot
      // flips to undefined.
      current = null
      await act(async () => { emitServiceChange() })
      expect(readObserved()).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      // Provider re-provides: snapshot flips back.
      current = validService()
      await act(async () => { emitServiceChange() })
      expect(readObserved()).toBe(current)
      // A wrong-version provider degrades to undefined (still one warning per
      // episode).
      current = { protocolVersion: 99, GraphTree: () => null }
      await act(async () => { emitServiceChange() })
      expect(readObserved()).toBeUndefined()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('unbind detaches the seat (disposed fiber can never serve a stale context)', async () => {
    // The service reference must be STABLE across reads (useSyncExternalStore
    // compares snapshots by identity).
    const service = validService()
    const { ctx } = fakeCtx(() => service)
    bindGitGraph(ctx)
    const { root, container } = await mountProbe()
    try {
      expect(readObserved()).toBe(service)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
    // A fiber that mounts AFTER dispose never sees a service — the stale
    // context can never keep serving.
    await act(async () => { unbindGitGraph() })
    const second = await mountProbe()
    try {
      expect(readObserved()).toBeUndefined()
    } finally {
      act(() => { second.root.unmount() })
      second.container.remove()
    }
  })
})