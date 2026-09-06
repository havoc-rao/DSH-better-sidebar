/**
 * The file-tree dual-module SPLITTER (v0.19.1+): the draggable divider that
 * re-proportions the injected upper section against the local tree (the
 * dsh-remote 4:1 requirement). Covers:
 *  - the pure ratio model: default 4:1, pixel-floor clamping in both
 *    directions, degenerate containers, persistence read/write validation;
 *  - the TreePanel mount: splitter DOM between the modules (section →
 *    separator → tree), default flex-basis 80%, persisted-ratio seeding,
 *    aria surface; live drag per the repo's pointer-capture convention
 *    (jsdom lacks setPointerCapture, so events are dispatched on the
 *    handle) with frame-batched updates, clamping at both ends, an unmoved
 *    click committing nothing, pointercancel ending the drag;
 *  - double-click reset to the default 4:1;
 *  - the sectionless regression: no splitter, no dual stack, no storage
 *    access, the pre-slot DOM intact; a live-unregistered section takes
 *    the splitter away with it.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import {
  clampFileTreeSplitRatio, FILE_TREE_SPLIT_DEFAULT_RATIO, FILE_TREE_SPLIT_RATIO_KEY,
  persistFileTreeSplitRatio, readFileTreeSplitRatio, type FileTreeSplitStorage,
} from '../src/client/file-tree-splitter.ts'
import type { Context } from '../src/context-types.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// Host route spies: the LOCAL tree keeps working under the section (fsTree)
// while the splitter tests exercise the layout around it.
const fsTreeMock = vi.hoisted(() => vi.fn())
const gitStatusMock = vi.hoisted(() => vi.fn())
const fsSearchMock = vi.hoisted(() => vi.fn())
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: fsTreeMock,
    gitStatus: gitStatusMock,
    fsSearch: fsSearchMock,
    uploadFile: vi.fn(),
  },
  downloadUrl: () => '/sidebar/file',
}))

beforeEach(() => {
  window.localStorage.clear()
  fsTreeMock.mockReset()
  fsTreeMock.mockResolvedValue({
    entries: [
      { name: 'sub', path: '/r/sub', isDir: true },
      { name: 'local.txt', path: '/r/local.txt', isDir: false },
    ],
  })
  gitStatusMock.mockReset()
  gitStatusMock.mockResolvedValue({ isRepo: true, branch: 'main', entries: [] })
  fsSearchMock.mockReset()
  fsSearchMock.mockResolvedValue({ matches: ['x.txt'], truncated: false })
})

interface Harness {
  container: HTMLDivElement
  disposeSection?: () => void
  unmount: () => void
}

async function mountPanel(options: { withSection?: boolean } = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  let disposeSection: (() => void) | undefined
  if (options.withSection === true) {
    disposeSection = service.registerFileTreeSection({
      id: 'remote',
      match: () => true,
      render: () => <div data-section-label="remote">REMOTE CONTENT</div>,
    })
  }
  const ctx = { betterSidebar: service } as unknown as Context
  await act(async () => {
    root.render(createElement(TreePanel, {
      sessionId: 's1',
      cwd: '/r',
      expanded: [],
      revealed: [],
      ctx,
      onToggle: () => {},
      onOpenFile: () => {},
      onOpenFileNewTab: () => {},
      onOpenFileSide: () => {},
      onReferenceFile: () => {},
      visible: true,
    } as never))
  })
  await act(async () => { await Promise.resolve() })
  return {
    container,
    disposeSection,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

/** The dual stack with a measured box (jsdom rects are all zeros). */
function stubDualBox(container: HTMLDivElement, top: number, height: number): HTMLElement {
  const dual = container.querySelector<HTMLElement>('[class*="explorerDual"]')
  if (dual === null) throw new Error('explorerDual not rendered')
  vi.spyOn(dual, 'getBoundingClientRect').mockReturnValue({
    top, height, bottom: top + height, left: 0, right: 0, width: 300, x: 0, y: top,
    toJSON: () => ({}),
  } as DOMRect)
  return dual
}

function sectionEl(container: HTMLDivElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[class*="explorerSection"]')
  if (el === null) throw new Error('explorerSection not rendered')
  return el
}

const handleIn = (container: HTMLDivElement): HTMLElement => {
  const el = container.querySelector<HTMLElement>('[role="separator"]')
  if (el === null) throw new Error('splitter not rendered')
  return el
}

/** The repo's pointer-capture test convention (editor-host.spec): plain
 *  MouseEvents carrying pointer* type names; setPointerCapture is absent in
 *  jsdom and skipped by the handler. */
function pointer(target: HTMLElement, type: string, clientY: number): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY }))
  })
}

/** Flush the drag batcher's pending per-frame application. */
async function flushFrames(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}

describe('file-tree splitter model (v0.19.1+)', () => {
  it('the default is the remote 4:1 split: upper 80%, lower 20%', () => {
    expect(FILE_TREE_SPLIT_DEFAULT_RATIO).toBe(0.8)
    // A tall-enough container keeps the default unclamped.
    expect(clampFileTreeSplitRatio(0.8, 700)).toBe(0.8)
  })

  it('clamping honors BOTH pixel floors (upper ≥160px, lower ≥120px + strip)', () => {
    // 500px container: upper floor 160/500 = 0.32; lower floor leaves
    // (500 − 5 − 120)/500 = 0.75.
    expect(clampFileTreeSplitRatio(0.05, 500)).toBe(0.32)
    expect(clampFileTreeSplitRatio(0.99, 500)).toBe(0.75)
    expect(clampFileTreeSplitRatio(0.4, 500)).toBe(0.4)
    // The 4:1 default re-clamps only when the lower floor would collapse:
    // at 600px the tree's 120px + 5px strip leaves (600−125)/600.
    expect(clampFileTreeSplitRatio(0.8, 600)).toBeCloseTo(475 / 600, 6)
  })

  it('a container too short for both floors degrades to an even split', () => {
    // 200px cannot fit 160 + 5 + 120: pick 0.5 (least-broken layout).
    expect(clampFileTreeSplitRatio(0.2, 200)).toBe(0.5)
    expect(clampFileTreeSplitRatio(0.9, 200)).toBe(0.5)
  })

  it('non-finite ratios resolve to the default', () => {
    expect(clampFileTreeSplitRatio(Number.NaN, 500)).toBe(0.8)
    expect(clampFileTreeSplitRatio(Number.POSITIVE_INFINITY, 500)).toBe(0.8)
  })

  it('persistence: read default when empty, round-trip, and validate garbage', () => {
    const fake = (): FileTreeSplitStorage => {
      const map = new Map<string, string>()
      return {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => { map.set(key, value) },
      }
    }
    expect(readFileTreeSplitRatio(fake())).toBe(0.8)
    const storage = fake()
    persistFileTreeSplitRatio(0.45, storage)
    expect(readFileTreeSplitRatio(storage)).toBe(0.45)
    expect(storage.getItem(FILE_TREE_SPLIT_RATIO_KEY)).toBe('0.45')
    // Stored garbage falls back to the default; out-of-range clamps to 0–1.
    const bad = (raw: string): FileTreeSplitStorage => ({
      getItem: () => raw,
      setItem: () => {},
    })
    expect(readFileTreeSplitRatio(bad('abc'))).toBe(0.8)
    expect(readFileTreeSplitRatio(bad('NaN'))).toBe(0.8)
    expect(readFileTreeSplitRatio(bad('1.5'))).toBe(1)
    expect(readFileTreeSplitRatio(bad('-1'))).toBe(0)
    expect(readFileTreeSplitRatio(bad('0.75'))).toBe(0.75)
    // Throwing storage (private mode) degrades to the default, never throws.
    const throwing = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    expect(readFileTreeSplitRatio(throwing)).toBe(0.8)
    expect(() => persistFileTreeSplitRatio(0.6, throwing)).not.toThrow()
  })
})

describe('TreePanel splitter', () => {
  let harness: Harness
  afterEach(() => {
    harness?.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('no section matches: no splitter, no dual stack, no storage access, the pre-slot DOM intact', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    harness = await mountPanel({})
    expect(harness.container.querySelector('[class*="explorerDual"]')).toBeNull()
    expect(harness.container.querySelector('[role="separator"]')).toBeNull()
    expect(harness.container.querySelector('[class*="explorerSplitter"]')).toBeNull()
    // The local tree body is still a DIRECT panel child (pre-slot DOM)…
    const panel = harness.container.firstElementChild!
    expect(panel.querySelector(':scope > [class*="explorerBody"]')).not.toBeNull()
    // …the local tree itself works, and neither the read nor the write
    // path touched storage (the ratio state mounts only with a section).
    expect(harness.container.textContent).toContain('local.txt')
    expect(harness.container.querySelector('[class*="explorerBody"]')?.textContent).toContain('sub')
    expect(setItem).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(FILE_TREE_SPLIT_RATIO_KEY)).toBeNull()
  })

  it('a matched section renders the splitter BETWEEN the modules, with the default 4:1 basis and the separator aria surface', async () => {
    harness = await mountPanel({ withSection: true })
    const dual = stubDualBox(harness.container, 100, 500)
    const section = sectionEl(harness.container)
    const handle = handleIn(harness.container)
    const body = harness.container.querySelector('[class*="explorerBody"]')!
    // Order: section → splitter → local tree.
    expect(dual.children[0]).toBe(section)
    expect(dual.children[1]).toBe(handle)
    expect(dual.children[2]).toBe(body)
    expect(harness.container.textContent).toContain('REMOTE CONTENT')
    expect(harness.container.textContent).toContain('local.txt')
    // The section's height is the splitter's ratio: default 4:1.
    expect(section.style.flex).toBe('0 1 80%')
    expect(section.style.flexBasis).toBe('80%')
    // Aria surface (the EditorHost separator convention + a live value).
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal')
    expect(handle.getAttribute('aria-valuenow')).toBe('80')
    expect(handle.getAttribute('aria-label')).toBeTruthy()
  })

  it('a persisted ratio seeds the split on mount (cross-session stability)', async () => {
    window.localStorage.setItem(FILE_TREE_SPLIT_RATIO_KEY, '0.5')
    harness = await mountPanel({ withSection: true })
    expect(sectionEl(harness.container).style.flexBasis).toBe('50%')
  })

  it('dragging the handle re-proportions both modules live and persists on release', async () => {
    harness = await mountPanel({ withSection: true })
    const dual = stubDualBox(harness.container, 100, 500)
    const handle = handleIn(harness.container)
    const section = sectionEl(harness.container)
    // Pointer at container-relative 300px → up 400 → granularity: down at
    // clientY 400, then move to 350: upper = 250 → ratio 0.5.
    pointer(handle, 'pointerdown', 400)
    pointer(handle, 'pointermove', 350)
    await flushFrames()
    expect(section.style.flexBasis).toBe('50%')
    expect(handle.getAttribute('aria-valuenow')).toBe('50')
    // Release commits + persists exactly the release position.
    pointer(handle, 'pointerup', 350)
    expect(window.localStorage.getItem(FILE_TREE_SPLIT_RATIO_KEY)).toBe('0.5')
    // The drag state cleared: a later stray move changes nothing.
    pointer(handle, 'pointermove', 200)
    await flushFrames()
    expect(section.style.flexBasis).toBe('50%')
  })

  it('dragging past either end clamps: neither module can be dragged out of view', async () => {
    harness = await mountPanel({ withSection: true })
    stubDualBox(harness.container, 100, 500)
    const handle = handleIn(harness.container)
    const section = sectionEl(harness.container)
    // Down at the top end, drag far UP: the upper floor (160/500 = 0.32) wins.
    pointer(handle, 'pointerdown', 180)
    pointer(handle, 'pointermove', 50)
    await flushFrames()
    expect(section.style.flexBasis).toBe('32%')
    // …and far DOWN: the lower floor (500 − 5 − 120 = 375px → 0.75) wins.
    pointer(handle, 'pointermove', 600)
    await flushFrames()
    expect(section.style.flexBasis).toBe('75%')
    // Releasing at the clamped end persists the clamped ratio.
    pointer(handle, 'pointerup', 600)
    expect(window.localStorage.getItem(FILE_TREE_SPLIT_RATIO_KEY)).toBe('0.75')
  })

  it('an unmoved click is a strict no-op: no ratio change, nothing persisted', async () => {
    harness = await mountPanel({ withSection: true })
    stubDualBox(harness.container, 100, 500)
    const handle = handleIn(harness.container)
    const section = sectionEl(harness.container)
    pointer(handle, 'pointerdown', 400)
    pointer(handle, 'pointerup', 400)
    await flushFrames()
    expect(section.style.flexBasis).toBe('80%')
    expect(handle.getAttribute('aria-valuenow')).toBe('80')
    expect(window.localStorage.getItem(FILE_TREE_SPLIT_RATIO_KEY)).toBeNull()
  })

  it('double-click resets the split to the default 4:1 and persists it', async () => {
    window.localStorage.setItem(FILE_TREE_SPLIT_RATIO_KEY, '0.5')
    harness = await mountPanel({ withSection: true })
    stubDualBox(harness.container, 100, 500)
    const handle = handleIn(harness.container)
    const section = sectionEl(harness.container)
    expect(section.style.flexBasis).toBe('50%')
    act(() => {
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    expect(section.style.flexBasis).toBe('80%')
    expect(window.localStorage.getItem(FILE_TREE_SPLIT_RATIO_KEY)).toBe('0.8')
  })

  it('pointercancel aborts the drag: later moves are ignored, nothing persisted', async () => {
    harness = await mountPanel({ withSection: true })
    stubDualBox(harness.container, 100, 500)
    const handle = handleIn(harness.container)
    const section = sectionEl(harness.container)
    pointer(handle, 'pointerdown', 400)
    pointer(handle, 'pointercancel', 400)
    pointer(handle, 'pointermove', 350)
    await flushFrames()
    expect(section.style.flexBasis).toBe('80%')
    expect(window.localStorage.getItem(FILE_TREE_SPLIT_RATIO_KEY)).toBeNull()
  })

  it('a live-unregistered section takes the splitter away; the local tree stays as before', async () => {
    harness = await mountPanel({ withSection: true })
    expect(handleIn(harness.container)).toBeDefined()
    act(() => { harness.disposeSection!() })
    await act(async () => { await Promise.resolve() })
    expect(harness.container.querySelector('[class*="explorerDual"]')).toBeNull()
    expect(harness.container.querySelector('[role="separator"]')).toBeNull()
    const panel = harness.container.firstElementChild!
    expect(panel.querySelector(':scope > [class*="explorerBody"]')).not.toBeNull()
    expect(harness.container.textContent).toContain('local.txt')
  })
})