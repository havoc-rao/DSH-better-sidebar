/**
 * FileTree in-flight level rendering: the `{}` marker `loadLevels` stores while
 * a listing request is running must draw the LOADING row, not an empty level.
 * Regression guard for the "expand a fresh folder flashes loading → collapsed
 * → entries" flicker: the marker used to fall into `entries ?? []` and render
 * zero rows for the whole request, so the folder looked collapsed again until
 * the response landed (a fresh mount showed a blank body under the root row).
 *
 * Ported from PR #789, which gated the per-level `fsTree` route, onto the
 * batched `fsTrees` shape: levels still settle one-by-one through per-dir
 * gates, but mount and expand are now TWO batch calls (the second lists only
 * the newly expanded directory — the batching itself is guarded by
 * file-tree-batch-load.spec.tsx, this suite only owns the in-flight frame).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { installFileTreeUiSeat } from '../src/client/file-tree-ui.ts'
import type { Context } from '../src/context-types.ts'
import type { FileExplorerSource } from '../src/client/file-explorer.tsx'
import type { FileTreeUiServiceV2 } from 'dsh-file-tree-ui/client-contract'
import { FileTree as ProviderFileTree } from 'dsh-file-tree-ui/src/client/FileTree.tsx'
import { t } from '../src/client/locales.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

interface Listing {
  entries: Array<{ name: string; path: string; isDir: boolean }>
}

/** One gate per requested directory: the test decides when each settles. */
const gates = vi.hoisted(() => {
  const pending = new Map<string, { promise: Promise<Listing>; resolve: (listing: Listing) => void; reject: (error: Error) => void }>()
  const gate = (dir: string): Promise<Listing> => {
    const existing = pending.get(dir)
    if (existing !== undefined) return existing.promise
    let resolve!: (listing: Listing) => void
    let reject!: (error: Error) => void
    const promise = new Promise<Listing>((res, rej) => { resolve = res; reject = rej })
    pending.set(dir, { promise, resolve, reject })
    return promise
  }
  return { gate, pending }
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain.
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

/** The smallest WebSocket the directory watcher talks to (see its spec). */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = FakeSocket.CONNECTING
  readonly url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  send(): void {}
  close(): void { this.readyState = 3 }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
}

const DIR_ENTRY = (name: string): { name: string; path: string; isDir: boolean } =>
  ({ name, path: `/tmp/${name}`, isDir: true })

interface Harness {
  container: HTMLDivElement
  /** Re-render with a new expansion set (the expand happens in the caller). */
  rerender: (expanded: string[]) => void
  unmount: () => void
}

/** The remote-facing source adapter: its list call remains deferred until
 * the test releases that directory. No local filesystem fallback is allowed. */
const source = {
  fsTrees: vi.fn<FileExplorerSource['fsTrees']>((_scope, paths) =>
    Promise.all(paths.map(path => gates.gate(path).then(listing => ({
      path,
      entries: listing.entries.map(entry => ({ ...entry, hidden: false, isSymlink: false, broken: false })),
      truncated: false,
    })))).then(levels => ({ levels }))),
} satisfies FileExplorerSource

function mountTree(expanded: string[]): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  let liveExpanded = expanded
  const render = (dirs: string[]): void => {
    liveExpanded = dirs
    root.render(createElement(FileTree, {
      source,
      sessionId: 's1',
      cwd: '/tmp',
      expanded: dirs,
      revealed: [],
      onToggle: path => render(liveExpanded.includes(path)
        ? liveExpanded.filter(dir => dir !== path) : [...liveExpanded, path]),
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  }
  act(() => { render(expanded) })
  return {
    container,
    rerender: (dirs: string[]) => { act(() => { render(dirs) }) },
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** Every rendered row (entry rows and the plain loading/error rows). */
function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('div[class*="explorerRow"], div[role="button"]')]
}

/** The row whose name span matches (entry rows carry `.explorerName`). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = rows(container).find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** Plain rows render no name span; the loading one shows exactly `t('loading')`. */
const loadingRows = (container: HTMLElement): HTMLElement[] =>
  rows(container)
    .filter(row => row.querySelector('[class*="explorerName"]') === null)
    .filter(row => row.textContent === t('loading'))

/** Settle one directory's listing and flush the batch promise chain. */
async function release(dir: string, listing: Listing): Promise<void> {
  await act(async () => {
    gates.pending.get(dir)!.resolve(listing)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Fail one directory's listing (the whole batch rejects — the loadLevels
 * catch turns it into per-level error rows for levels with nothing cached). */
async function fail(dir: string, message: string): Promise<void> {
  await act(async () => {
    gates.pending.get(dir)!.reject(new Error(message))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

let harness: Harness
beforeEach(() => {
  FakeSocket.instances = []
  source.fsTrees.mockClear()
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  harness?.unmount()
  installFileTreeUiSeat(null)
  gates.pending.clear()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe.each(['fallback', 'shared v2'] as const)('FileTree in-flight level rendering (%s)', renderer => {
  beforeEach(() => {
    const service: FileTreeUiServiceV2 = {
      protocolVersion: 2,
      renderFileTree: props => <ProviderFileTree {...props} />,
      renderRowMenu: () => <span />,
    }
    installFileTreeUiSeat(renderer === 'shared v2' ? {
      get: (key: string) => key === 'fileTreeUi' ? service : undefined,
      on: () => () => {},
    } as unknown as Context : null)
  })
  it('keeps the loading row under a freshly expanded folder until its listing lands', async () => {
    harness = mountTree([])
    // Mount batch (root only) in flight: exactly one loading row under the
    // root row (the root row itself is drawn from cwd, not from the listing).
    // Before the fix the `{}` marker rendered an EMPTY body — zero rows.
    expect(loadingRows(harness.container)).toHaveLength(1)

    // Root lands; expanding src fires the SECOND batch, which lists only src
    // (the root level is cached). While that batch is in flight src keeps ONE
    // loading row nested under its own row. Before the fix this frame rendered
    // ZERO rows under src — the "folder collapsed again" flash.
    await release('/tmp', { entries: [DIR_ENTRY('src'), { name: 'a.ts', path: '/tmp/a.ts', isDir: false }] })
    harness.rerender(['/tmp/src'])
    const loading = loadingRows(harness.container)
    expect(loading).toHaveLength(1)
    expect(loading[0]!.getAttribute('aria-busy')).toBe('true')
    expect(loading[0]!.querySelector('[role="status"][data-kind="loading"]')).not.toBeNull()
    // Unrelated renders must not erase the pending marker or duplicate a call.
    harness.rerender(['/tmp/src'])
    expect(loadingRows(harness.container)).toHaveLength(1)
    expect(source.fsTrees).toHaveBeenCalledTimes(2)

    // The listing lands: rows swap in, no loading row remains.
    await release('/tmp/src', { entries: [{ name: 'inner.ts', path: '/tmp/src/inner.ts', isDir: false }] })
    expect(loadingRows(harness.container)).toHaveLength(0)
    expect(() => rowByName(harness.container, 'inner.ts')).not.toThrow()
  })

  it('allows collapse, reopening and other directory clicks while a listing is pending', async () => {
    harness = mountTree([])
    await release('/tmp', { entries: [DIR_ENTRY('slow'), DIR_ENTRY('other')] })
    const click = (name: string): void => {
      act(() => { rowByName(harness.container, name).click() })
    }
    click('slow')
    expect(loadingRows(harness.container)).toHaveLength(1)
    click('slow')
    // The real v2 provider retains children during its fold-out animation.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
    expect(loadingRows(harness.container)).toHaveLength(0)
    click('slow')
    expect(loadingRows(harness.container)).toHaveLength(1)
    click('other')
    expect(loadingRows(harness.container)).toHaveLength(2)
    await release('/tmp/other', { entries: [{ name: 'ready.ts', path: '/tmp/other/ready.ts', isDir: false }] })
    expect(loadingRows(harness.container)).toHaveLength(1)
    expect(() => rowByName(harness.container, 'ready.ts')).not.toThrow()
    await release('/tmp/slow', { entries: [] })
    expect(loadingRows(harness.container)).toHaveLength(0)
    expect(harness.container.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('renders a truly empty directory as zero rows, not a stuck loading row', async () => {
    harness = mountTree([])
    await release('/tmp', { entries: [DIR_ENTRY('empty')] })
    harness.rerender(['/tmp/empty'])
    // In flight: the empty folder still shows its loading row.
    expect(loadingRows(harness.container)).toHaveLength(1)
    // Landed as an empty listing: no loading row, and no child row below the
    // folder — it is the tree's last row.
    await release('/tmp/empty', { entries: [] })
    expect(loadingRows(harness.container)).toHaveLength(0)
    const all = rows(harness.container)
    expect(all[all.length - 1]).toBe(rowByName(harness.container, 'empty'))
  })

  it('shows the error row when the listing request fails', async () => {
    harness = mountTree([])
    await release('/tmp', { entries: [DIR_ENTRY('boom')] })
    harness.rerender(['/tmp/boom'])
    expect(loadingRows(harness.container)).toHaveLength(1)
    await fail('/tmp/boom', 'boom')
    expect(loadingRows(harness.container)).toHaveLength(0)
    expect(harness.container.querySelector('[aria-busy="true"]')).toBeNull()
    const errorRow = rows(harness.container)
      .filter(row => row.querySelector('[class*="explorerName"]') === null)
      .find(row => row.textContent === 'boom')
    expect(errorRow).toBeDefined()
  })
})
