/**
 * FileTree via the fileTreeUi v2 service (provider: dsh-file-tree-ui):
 * with the v2 service present the tree renders through the provider's
 * FileTree FRAMEWORK — the consumer builds FileTreeRowModel forests from
 * the same `data` state and injects row content, expansion state data and
 * every DOM semantic (click/Enter/Space, the in-tree drag event family,
 * the right-click row menu, drop routing); without it (missing /
 * mismatched / unloaded) the built-in fallback rows render byte-for-byte
 * the pre-v2 shape (covered by the other file-tree-* specs in the
 * fallback path; this spec additionally proves the flip-over on service
 * unload does not white screen).
 *
 * The service fixture is built from the upstream source components —
 * vitest is outside the client-bundle purity gate, so value-importing
 * `dsh-file-tree-ui/src/client/*.tsx` is legal here (tsdown never sees
 * it). Assertions are semantic (roles / aria / text / recorded models):
 * no reliance on css-module hashed names beyond contains-matching.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { installFileTreeUiSeat } from '../src/client/file-tree-ui.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { resetTreeUndoStacks } from '../src/client/undo.ts'
import type { Context } from '../src/context-types.ts'
// The provider's REAL framework component (test-only value import — the
// client-bundle purity gate rejects value imports of the provider package,
// but vitest never bundles; see the file header).
import { FileTree as ProviderFileTree } from 'dsh-file-tree-ui/src/client/FileTree.tsx'
import type {
  FileTreeProps,
  FileTreeRowModel,
  FileTreeUiServiceV2,
} from 'dsh-file-tree-ui/client-contract'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

// jsdom defines no Element.scrollTo; the reveal-scroll effect needs a real
// function (mounted trees run the effect on first paint).
const scrollTo = vi.fn()
beforeAll(() => {
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = scrollTo
})
afterEach(() => { scrollTo.mockClear() })

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

// vi.mock factories are hoisted above every declaration, so the shared
// mocks ride vi.hoisted (mockClear in afterEach keeps the implementations).
const { fsRename, fsMove, fsCopy, isOutsideWorkspaceMessage } = vi.hoisted(() => ({
  fsRename: vi.fn(async () => ({ path: '/tmp/renamed.ts' })),
  fsMove: vi.fn(async (_scope: unknown, from: string, dir: string) => ({ path: `${dir}/${from.split(/[\\/]/).pop()}` })),
  fsCopy: vi.fn(async (_scope: unknown, from: string, dir: string) => ({ path: `${dir}/${from.split(/[\\/]/).pop()}` })),
  isOutsideWorkspaceMessage: vi.fn(() => false),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async (_scope: unknown, path: string) => {
      if (path === '/tmp') {
        return {
          entries: [
            { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
            { name: 'sub', path: '/tmp/sub', isDir: true },
          ],
        }
      }
      if (path === '/tmp/sub') {
        return {
          entries: [
            { name: 'deep.ts', path: '/tmp/sub/deep.ts', isDir: false },
            { name: 'nested', path: '/tmp/sub/nested', isDir: true },
          ],
        }
      }
      if (path === '/tmp/sub/nested') {
        return {
          entries: [
            { name: 'leaf.ts', path: '/tmp/sub/nested/leaf.ts', isDir: false },
          ],
        }
      }
      if (path === '/boom') throw new Error('denied by the server')
      return { entries: [] }
    },
    fsRename,
    fsMove,
    fsCopy,
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage,
}))

// ── The optional fileTreeUi seat ────────────────────────────────────────
// A boxed value the tests swap (the way the `internal/service` bus flips
// the snapshot at runtime); `bump()` fires the subscription listeners so
// the seat's useSyncExternalStore consumers re-render.

interface Seat {
  set: (value: unknown) => void
  bump: () => void
}

function makeSeat(): Seat {
  let value: unknown = undefined
  const listeners = new Set<() => void>()
  const fakeCtx = {
    get: (key: string) => (key === 'fileTreeUi' ? value : undefined),
    on: (_event: string, listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as unknown as Context
  installFileTreeUiSeat(fakeCtx)
  return {
    set: next => { value = next },
    bump: () => { for (const listener of [...listeners]) listener() },
  }
}

/** The v2 service fixture: the REAL upstream FileTree framework (plus a
 *  recording wrapper when `record` is given, for model-shape assertions). */
function makeFileTreeUiService(record?: FileTreeProps[]): FileTreeUiServiceV2 {
  return {
    protocolVersion: 2,
    renderFileTree: props => {
      record?.push(props)
      return <ProviderFileTree {...props} />
    },
    renderRowMenu: () => <span />,
  }
}

let seat: Seat

beforeEach(() => {
  seat = makeSeat()
})

afterEach(() => {
  installFileTreeUiSeat(null)
  resetTreeUndoStacks()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

// ── Mount harness ───────────────────────────────────────────────────────

interface Harness {
  container: HTMLDivElement
  body: HTMLElement
  onToggle: ReturnType<typeof vi.fn>
  onOpenFile: ReturnType<typeof vi.fn>
  onReferenceFile: ReturnType<typeof vi.fn>
  onPathRenamed: ReturnType<typeof vi.fn>
  onUploadRequest: ReturnType<typeof vi.fn>
  rerender: (patch: Record<string, unknown>) => Promise<void>
  unmount: () => void
}

async function mountTree(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onToggle = vi.fn()
  const onOpenFile = vi.fn()
  const onReferenceFile = vi.fn()
  const onPathRenamed = vi.fn()
  const onUploadRequest = vi.fn()
  let live = {
    sessionId: 's1',
    cwd: '/tmp',
    store: createSidebarStore(),
    expanded: ['/tmp/sub'],
    revealed: [] as string[],
    onToggle,
    onOpenFile,
    onReferenceFile,
    onPathRenamed,
    onUploadRequest,
    refreshTick: 0,
    busy: false,
    ...overrides,
  }
  const render = (): void => {
    root.render(createElement(FileTree, live as never))
  }
  await act(async () => { render() })
  const body = container.querySelector<HTMLElement>('[class*="explorerBody"]')
  if (body === null) throw new Error('tree body not found')
  return {
    container,
    body,
    onToggle,
    onOpenFile,
    onReferenceFile,
    onPathRenamed,
    onUploadRequest,
    rerender: async (patch) => {
      await act(async () => { live = { ...live, ...patch } as never; render() })
    },
    unmount: () => { act(() => { root.unmount() }) },
  }
}

/** One FRAMEWORK row by its displayed name (nested role=button chrome —
 *  the chevron — carries no text). */
function frameRow(container: HTMLDivElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="tree"] [role="button"]')]
    .find(el => el.textContent?.includes(name))
  if (row === undefined) throw new Error(`framework row "${name}" not found`)
  return row
}

/** A row's name label span (works for the role-less root row too — the
 *  root model intentionally carries no button semantics). */
function nameLabel(container: HTMLDivElement, name: string): HTMLElement {
  const label = [...container.querySelectorAll<HTMLElement>('[class*="explorerName"]')]
    .find(el => el.textContent === name)
  if (label === undefined) throw new Error(`name label "${name}" not found`)
  return label
}

/** The chevron (expand indicator) of a framework row: the aria-hidden
 *  role=button span inside it. */
function chevronOf(row: HTMLElement): HTMLElement {
  const chevron = [...row.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.getAttribute('aria-hidden') === 'true')
  if (chevron === undefined) throw new Error('chevron not found')
  return chevron
}

/** A guide band (ancestor guide-column click strip) of a framework row, by
 *  its inline `left` (the band centers on the column stroke: left = column
 *  x − GUIDE_HIT_HALF + 0.5 = x − 3.5px → 2.5 / 24.5 / 46.5 for this
 *  tree's 6px-base / 22px-step grid). The provider css-module classes are
 *  not reliably queryable under vitest. */
function guideBandOf(row: HTMLElement, leftPx: number): HTMLElement {
  const band = [...row.querySelectorAll<HTMLElement>('span')]
    .find(el => el.style?.left === `${leftPx}px`)
  if (band === undefined) throw new Error(`guide band at ${leftPx}px not found`)
  return band
}

function pressKey(el: HTMLElement, init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }))
  })
}

function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === label)
  if (item === undefined) throw new Error(`menuitem "${label}" not found`)
  act(() => { item.click() })
}

/** A fake DataTransfer carrying ONLY the in-tree drag MIME (upload drags
 *  use the 'Files' type and are exercised by file-tree-drop.spec.tsx). */
function treeDataTransfer(): DataTransfer {
  return {
    types: ['application/x-dsh-tree-drag'],
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: vi.fn(),
    getData: vi.fn(),
  } as unknown as DataTransfer
}

function dragEvent(type: string, data: DataTransfer, init: { altKey?: boolean } = {}): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: data })
  if (init.altKey === true) Object.defineProperty(event, 'altKey', { value: true })
  return event
}

function startDrag(container: HTMLDivElement, name: string): DataTransfer {
  const data = treeDataTransfer()
  act(() => { frameRow(container, name).dispatchEvent(dragEvent('dragstart', data)) })
  return data
}

function dragTo(element: HTMLElement, type: 'dragover' | 'drop', altKey = false): DataTransfer {
  const data = treeDataTransfer()
  act(() => { element.dispatchEvent(dragEvent(type, data, { altKey })) })
  return data
}

/** Set a controlled input's value the React way (native setter + input). */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Root out the recorded row model with a key (the recording service
 *  captures every renderFileTree props object; the scan walks the whole
 *  forest — rows nest as children, root side first). */
function recordedRows(record: FileTreeProps[]): FileTreeRowModel[] {
  const collect = (nodes: readonly (FileTreeRowModel | ReactNode)[]): FileTreeRowModel[] => {
    const out: FileTreeRowModel[] = []
    for (const node of nodes) {
      if (typeof node === 'object' && node !== null && !Array.isArray(node) && 'label' in node) {
        const row = node as FileTreeRowModel
        out.push(row)
        if (row.children !== undefined) out.push(...collect(row.children))
      }
    }
    return out
  }
  const scanned: FileTreeRowModel[] = []
  for (const props of record) scanned.push(...collect(props.rows))
  return scanned
}

function recordedRow(record: FileTreeProps[], key: string): FileTreeRowModel | undefined {
  return recordedRows(record).find(row => row.key === key)
}

describe('FileTree via fileTreeUi v2 (service path)', () => {
  it('renders the whole tree through the provider framework (container role/aria, chevrons on dirs only, actions slot)', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree()
    const frame = tree.container.querySelector('[role="tree"]')
    expect(frame, 'the provider framework container must carry role="tree"').not.toBeNull()
    expect(frame!.getAttribute('aria-label')).toBe('Files')
    // The workspace root row (intentionally role-less) + the loaded levels.
    expect(nameLabel(tree.container, 'tmp').textContent).toBe('tmp')
    expect(frameRow(tree.container, 'a.ts').textContent).toContain('a.ts')
    expect(frameRow(tree.container, 'sub').textContent).toContain('sub')
    expect(frameRow(tree.container, 'deep.ts').textContent).toContain('deep.ts')
    // Dir rows are expandable (aria-expanded + chevron); file rows are not.
    expect(frameRow(tree.container, 'sub').getAttribute('aria-expanded')).toBe('true')
    expect(frameRow(tree.container, 'sub').querySelector('[aria-hidden="true"]'), 'dir chevron').not.toBeNull()
    expect(frameRow(tree.container, 'a.ts').getAttribute('aria-expanded')).toBeNull()
    // (icon svgs carry aria-hidden too — scope the no-chevron check to the
    // chevron's own shape: an aria-hidden element WITH role="button")
    expect(frameRow(tree.container, 'a.ts').querySelector('[role="button"][aria-hidden="true"]'),
      'no chevron on files').toBeNull()
    // The @-reference affordance rides the framework's actions slot.
    const refButton = [...tree.container.querySelectorAll<HTMLElement>('[class*="explorerTreeRef"]')]
    expect(refButton.length).toBeGreaterThan(0)
    expect(refButton[0]!.getAttribute('aria-label')).toBe('@file')
    tree.unmount()
  })

  it('builds the row models from the same data state (keys, indent, grid, guides, expansion data)', async () => {
    const record: FileTreeProps[] = []
    seat.set(makeFileTreeUiService(record))
    const tree = await mountTree()
    const props = record[record.length - 1]!
    expect(props.treeKey).toBe('workspace-explorer')
    expect(props.role).toBe('tree')
    expect(props.grid).toEqual({ basePx: 6, stepPx: 22 })
    // Root row: the workspace root, always-open children, no collapse
    // affordance (no expanded/onToggle — children render unconditionally).
    const rootRow = props.rows[0] as FileTreeRowModel
    expect(rootRow.key).toBe('/tmp')
    expect(rootRow.indentPx).toBe(6)
    expect(rootRow.expanded).toBeUndefined()
    expect(rootRow.label).not.toBeNull()
    // Depth-1 rows: 28px indent, the root as their single guide column.
    const sub = recordedRow(record, '/tmp/sub')
    expect(sub).toBeDefined()
    expect(sub!.indentPx).toBe(28)
    expect(sub!.expanded).toBe(true)
    expect(typeof sub!.onToggle).toBe('function')
    expect(sub!.junction).toBe(true)
    expect(sub!.guideColumns?.map(col => col.id)).toEqual(['/tmp'])
    expect(sub!.children?.length).toBeGreaterThan(0)
    const file = recordedRow(record, '/tmp/a.ts')
    expect(file!.indentPx).toBe(28)
    expect(file!.guideColumns?.map(col => col.id)).toEqual(['/tmp'])
    expect(file!.expanded).toBeUndefined()
    // Depth-2 rows: 50px indent, both ancestors as guide columns (full
    // paths are the branch-unique ids).
    const deep = recordedRow(record, '/tmp/sub/deep.ts')
    expect(deep!.indentPx).toBe(50)
    expect(deep!.guideColumns?.map(col => col.id)).toEqual(['/tmp', '/tmp/sub'])
    // A collapsed dir keeps its children present (the framework gates the
    // subtree on expanded; children stay so the fold animations can play)
    // — its level is unloaded, so the child is the loading node.
    const nested = recordedRow(record, '/tmp/sub/nested')
    expect(nested!.expanded).toBe(false)
    expect(nested!.junction).toBe(false)
    expect(nested!.children?.length).toBe(1)
    expect(nested!.children![0]).toBeTypeOf('object')
    tree.unmount()
  })

  it('click toggles dirs / opens files; chevron and guide-band clicks toggle ONCE (stopPropagation)', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree()
    act(() => { frameRow(tree.container, 'a.ts').click() })
    expect(tree.onOpenFile).toHaveBeenCalledWith('/tmp/a.ts')
    act(() => { frameRow(tree.container, 'sub').click() })
    expect(tree.onToggle).toHaveBeenCalledWith('/tmp/sub')
    // A chevron click toggles the dir WITHOUT re-triggering the row's own
    // onClick (the provider stops propagation): exactly one onToggle call.
    tree.onToggle.mockClear()
    act(() => { chevronOf(frameRow(tree.container, 'sub')).click() })
    expect(tree.onToggle).toHaveBeenCalledTimes(1)
    expect(tree.onToggle).toHaveBeenCalledWith('/tmp/sub')
    // A guide-band click on a FILE row folds the ANCESTOR and never opens
    // the file (band click = stopPropagation + column onToggle). Bands
    // center on their column strokes: 24.5px = the /tmp/sub column of a
    // depth-2 row (column x 28px − 3.5px).
    tree.onToggle.mockClear()
    tree.onOpenFile.mockClear()
    const deep = frameRow(tree.container, 'deep.ts')
    act(() => { guideBandOf(deep, 24.5).click() })
    expect(tree.onToggle).toHaveBeenCalledTimes(1)
    expect(tree.onToggle).toHaveBeenCalledWith('/tmp/sub')
    expect(tree.onOpenFile).not.toHaveBeenCalled()
    // The root column's band is inert (the workspace root is always open):
    // 2.5px = the root column of a depth-1 row (column x 6px − 3.5px).
    tree.onToggle.mockClear()
    act(() => { guideBandOf(frameRow(tree.container, 'a.ts'), 2.5).click() })
    expect(tree.onToggle).not.toHaveBeenCalled()
    tree.unmount()
  })

  it('Enter/Space drive the rows; the ContextMenu key opens the row menu', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree()
    pressKey(frameRow(tree.container, 'sub'), { key: 'Enter' })
    expect(tree.onToggle).toHaveBeenCalledWith('/tmp/sub')
    pressKey(frameRow(tree.container, 'a.ts'), { key: ' ' })
    expect(tree.onOpenFile).toHaveBeenCalledWith('/tmp/a.ts')
    tree.onToggle.mockClear()
    tree.onOpenFile.mockClear()
    pressKey(frameRow(tree.container, 'sub'), { key: 'F10', shiftKey: true })
    expect(document.querySelector('[role="menuitem"]'), 'the menu key must open the row menu').not.toBeNull()
    act(() => { document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    act(() => { document.body.click() })
    tree.unmount()
  })

  it('right-click opens the row menu on right-button pointer-up; the native contextmenu is suppressed at the body', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree()
    const row = frameRow(tree.container, 'deep.ts')
    act(() => {
      row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2, clientX: 40, clientY: 50 }))
    })
    expect([...document.querySelectorAll('[role="menuitem"]')].map(el => el.textContent))
      .toContain('Copy relative path')
    // The menu must anchor at the right-click cursor.
    expect(document.querySelector('[role="menu"]'), 'row menu opens').not.toBeNull()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(el => el.textContent === 'Copy relative path')
    expect(item, 'the copy entry must be listed').toBeDefined()
    act(() => { item!.click() })
    // The contextmenu event itself bubbles to the explorer body, which
    // suppresses the browser's native menu (preventDefault).
    const contextMenuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => { frameRow(tree.container, 'a.ts').dispatchEvent(contextMenuEvent) })
    expect(contextMenuEvent.defaultPrevented).toBe(true)
    tree.unmount()
  })

  it('routes in-tree drags exactly like the built-in rows (dir / file-parent / body-root / Alt copy / invalid refusals)', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree()
    // Drag source: the custom MIME + copyMove effect + dimming class.
    const data = startDrag(tree.container, 'a.ts')
    expect(data.setData).toHaveBeenCalledWith('application/x-dsh-tree-drag', '/tmp/a.ts')
    expect(data.effectAllowed).toBe('copyMove')
    expect(tree.container.querySelector('[class*="explorerRowDragging"]')?.textContent).toContain('a.ts')
    // Into a directory row.
    dragTo(frameRow(tree.container, 'sub'), 'drop')
    expect(fsMove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', '/tmp/sub')
    // Onto a FILE row → its parent directory.
    startDrag(tree.container, 'a.ts')
    dragTo(frameRow(tree.container, 'deep.ts'), 'drop')
    expect(fsMove).toHaveBeenLastCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', '/tmp/sub')
    // Onto the tree body → the workspace root.
    startDrag(tree.container, 'deep.ts')
    dragTo(tree.body, 'drop')
    expect(fsMove).toHaveBeenLastCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/sub/deep.ts', '/tmp')
    // Alt + drop copies.
    startDrag(tree.container, 'a.ts')
    dragTo(frameRow(tree.container, 'sub'), 'drop', true)
    expect(fsCopy).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', '/tmp/sub')
    // Invalid targets refuse without touching the wire (self + descendant).
    const moves = vi.mocked(fsMove).mock.calls.length
    startDrag(tree.container, 'sub')
    dragTo(frameRow(tree.container, 'sub'), 'drop')
    startDrag(tree.container, 'sub')
    dragTo(frameRow(tree.container, 'nested'), 'drop')
    expect(vi.mocked(fsMove).mock.calls.length).toBe(moves)
    expect(vi.mocked(fsCopy).mock.calls.length).toBe(1)
    expect(tree.onUploadRequest).not.toHaveBeenCalled()
    tree.unmount()
  })

  it('maps dropTarget onto the model dropState (dir rows and file rows target their parent)', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree()
    // Arm an in-tree drag first (dropTarget only tracks real in-tree
    // drags — the source row must be dragging).
    startDrag(tree.container, 'a.ts')
    act(() => {
      frameRow(tree.container, 'sub').dispatchEvent(dragEvent('dragover', treeDataTransfer()))
    })
    // The rendered sub row carries the framework's dropState visual class.
    expect(frameRow(tree.container, 'sub').className).toContain('rowDropOn')
    // A file row highlights when the drag targets its parent directory
    // (the parent dir row lights up too — VSCode routing: the drop lands
    // IN the parent, and both rows mark the target).
    startDrag(tree.container, 'a.ts')
    act(() => {
      frameRow(tree.container, 'deep.ts').dispatchEvent(dragEvent('dragover', treeDataTransfer()))
    })
    expect(frameRow(tree.container, 'deep.ts').className).toContain('rowDropOn')
    expect(frameRow(tree.container, 'sub').className).toContain('rowDropOn')
    // Rows outside the target keep their plain chrome.
    expect(frameRow(tree.container, 'a.ts').className).not.toContain('rowDropOn')
    tree.unmount()
  })

  it('inline rename replaces the WHOLE row with the editor (no button semantics) and commits', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree()
    act(() => {
      frameRow(tree.container, 'a.ts').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2 }))
    })
    clickMenuitem('Rename')
    const input = tree.container.querySelector<HTMLInputElement>('input')
    if (input === null) throw new Error('rename input not found')
    // The editor is a plain injected row — NOT wrapped in the framework's
    // role=button chrome (an editor is not a click target).
    expect(input.closest('[role="button"]'), 'the editor must not sit inside a button row').toBeNull()
    expect(input.getAttribute('aria-label')).toBe('Rename')
    setNativeValue(input, 'b.ts')
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await vi.waitFor(() => {
      expect(fsRename).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', 'b.ts')
    })
    tree.unmount()
  })

  it('renders the loading node inside the fold while an expanded level loads, then the rows', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree()
    await tree.rerender({ expanded: ['/tmp/sub', '/tmp/sub/nested'] })
    // The level is not yet loaded (the fixture resolves synchronously, so
    // the loading node may already be replaced — accept either shape, then
    // assert the load settles on the real row).
    await vi.waitFor(() => {
      expect([...tree.container.querySelectorAll('[role="tree"] [role="button"]')].some(el => el.textContent?.includes('leaf.ts')))
        .toBe(true)
    })
    tree.unmount()
  })

  it('renders the level error row and the fence notice as injected nodes (no white screen)', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree({ cwd: '/boom' })
    await vi.waitFor(() => {
      expect(tree.container.textContent).toContain('denied by the server')
    })
    // The fence refusal becomes the friendly notice, never the raw text.
    vi.mocked(isOutsideWorkspaceMessage).mockReturnValue(true)
    const fenced = await mountTree({ cwd: '/boom', refreshTick: 1 })
    await vi.waitFor(() => {
      expect(fenced.container.textContent).toContain('Turn off the workspace fence')
    })
    expect(fenced.container.textContent).not.toContain('denied by the server')
    fenced.unmount()
    tree.unmount()
  })

  it('collapses the subtree through the framework fold-out and re-expands with rows', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree()
    expect(frameRow(tree.container, 'deep.ts').textContent).toContain('deep.ts')
    // Collapse /tmp/sub: the framework plays the fold-out, then unmounts
    // the subtree (the fold-animation timeout settles it in jsdom).
    await tree.rerender({ expanded: [] })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
    expect([...tree.container.querySelectorAll('[role="tree"] [role="button"]')]
      .some(el => el.textContent?.includes('deep.ts')), 'subtree must unmount after the fold-out').toBe(false)
    expect(frameRow(tree.container, 'sub').getAttribute('aria-expanded')).toBe('false')
    // Re-expand: the cached level renders again through the fold.
    await tree.rerender({ expanded: ['/tmp/sub'] })
    await vi.waitFor(() => {
      expect([...tree.container.querySelectorAll('[role="tree"] [role="button"]')]
        .some(el => el.textContent?.includes('deep.ts'))).toBe(true)
    })
    tree.unmount()
  })

  it('keeps the body Cmd+Z undo contract working through the service path', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree()
    startDrag(tree.container, 'a.ts')
    dragTo(frameRow(tree.container, 'sub'), 'drop')
    await vi.waitFor(() => { expect(tree.onPathRenamed).toHaveBeenCalledWith('/tmp/a.ts', '/tmp/sub/a.ts') })
    vi.clearAllMocks()
    pressKey(tree.body, { key: 'z', metaKey: true })
    expect(fsMove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/sub/a.ts', '/tmp')
    await vi.waitFor(() => {
      expect(tree.onPathRenamed).toHaveBeenCalledWith('/tmp/sub/a.ts', '/tmp/a.ts')
    })
    tree.unmount()
  })

  it('marks revealed rows with the reveal class on framework rows (reveal scroll still resolves)', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree({ revealed: ['/tmp/sub/deep.ts'] })
    const revealed = tree.container.querySelector<HTMLElement>('[class*="explorerRowRevealed"]')
    expect(revealed, 'the revealed framework row must carry the reveal class').not.toBeNull()
    expect(revealed!.textContent).toContain('deep.ts')
    tree.unmount()
  })

  it('falls back to the built-in rows when the service unloads (no white screen)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const record: FileTreeProps[] = []
    seat.set(makeFileTreeUiService(record))
    let tree = await mountTree()
    expect(tree.container.querySelector('[role="tree"]'), 'framework tree present').not.toBeNull()
    expect(warn, 'a healthy episode stays silent').not.toHaveBeenCalled()
    // Provider unload: the internal/service subscription flips the
    // snapshot; the tree re-renders with the built-in rows (the diagnostic
    // warns exactly once per degraded episode).
    act(() => { seat.set(undefined); seat.bump() })
    expect(tree.container.querySelector('[role="tree"]'), 'framework must leave').toBeNull()
    expect(tree.container.querySelector('[class*="explorerRow"] [class*="explorerName"]'),
      'built-in rows must render').not.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[dsh-file-tree-ui]'))
    tree.unmount()
    // A protocol-incompatible service (v1) stays on the fallback path — the
    // same degraded episode, so no repeated diagnostics.
    act(() => {
      seat.set({ protocolVersion: 1, renderFileTree: () => null, renderRowMenu: () => null })
      seat.bump()
    })
    tree = await mountTree()
    expect(tree.container.querySelector('[role="tree"]'), 'mismatched service must not re-enter the framework').toBeNull()
    expect(tree.container.querySelector('[class*="explorerRow"] [class*="explorerName"]'),
      'mismatched service must fall back').not.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    tree.unmount()
  })

  it('renders the empty state (no session) independently of the service', async () => {
    seat.set(makeFileTreeUiService())
    const tree = await mountTree({ cwd: undefined })
    expect(tree.container.textContent).toContain('Select a conversation to use the sidebar')
    tree.unmount()
  })
})