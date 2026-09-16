/**
 * FileTree in-tree drag & drop (move/copy real files, VS Code semantics)
 * and the Cmd+Z / Cmd+Shift+Z undo/redo contract: the custom drag payload,
 * drop targeting (directory rows / file rows / the tree body = workspace
 * root), the Option/Alt copy modifier, invalid-target refusals, the tab
 * reconciliation callback on moves, the undo/redo inverse operations, the
 * focus gate that keeps native text undo intact, and the per-session
 * history that survives remounts.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { resetTreeUndoStacks } from '../src/client/undo.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

// vi.mock factories are hoisted above every declaration, so the shared
// mocks ride vi.hoisted (mockClear in afterEach keeps the implementations).
const { fsRename, fsMove, fsCopy, fsRemove } = vi.hoisted(() => ({
  fsRename: vi.fn(async () => ({ path: '/tmp/renamed.ts' })),
  // The resolved path must DERIVE from the arguments (destination dir +
  // source base name) — the undo path calls the same route in reverse and
  // the tree's settle logic reads the returned path.
  fsMove: vi.fn(async (_scope: unknown, from: string, dir: string) => ({ path: `${dir}/${from.split(/[\\/]/).pop()}` })),
  fsCopy: vi.fn(async (_scope: unknown, from: string, dir: string) => ({ path: `${dir}/${from.split(/[\\/]/).pop()}` })),
  fsRemove: vi.fn(async (_scope: unknown, path: string) => ({ path })),
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
      return { entries: [] }
    },
    fsRename,
    fsMove,
    fsCopy,
    fsRemove,
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

interface Harness {
  container: HTMLDivElement
  onPathRenamed: ReturnType<typeof vi.fn>
  onUploadRequest: ReturnType<typeof vi.fn>
  unmount: () => void
  body: HTMLElement
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onPathRenamed = vi.fn()
  const onUploadRequest = vi.fn()
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      store: createSidebarStore(),
      expanded: ['/tmp/sub'],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onOpenFileNewTab: () => {},
      onOpenFileSide: () => {},
      onReferenceFile: () => {},
      onPathRenamed,
      onUploadRequest,
      refreshTick: 0,
      busy: false,
    }))
  })
  const body = container.querySelector<HTMLElement>('[class*="explorerBody"]')
  if (body === null) throw new Error('tree body not found')
  return { container, onPathRenamed, onUploadRequest, body, unmount: () => { act(() => { root.unmount() }) } }
}

/** One tree row by its displayed name. */
function rowByName(container: HTMLDivElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row "${name}" not found`)
  return row
}

/** A fake DataTransfer carrying ONLY the in-tree drag MIME (upload drags use
 *  the 'Files' type and are exercised by file-tree-drop.spec.tsx). */
function treeDataTransfer(): DataTransfer {
  return {
    types: ['application/x-dsh-tree-drag'],
    dropEffect: 'none',
    effectAllowed: 'all',
    setData: vi.fn(),
    getData: vi.fn(),
  } as unknown as DataTransfer
}

/** A drag event with a fake dataTransfer on board (jsdom's DragEvent drops
 *  the dataTransfer init, so it is attached after construction). */
function dragEvent(type: string, data: DataTransfer, init: { altKey?: boolean } = {}): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', { value: data })
  if (init.altKey === true) Object.defineProperty(event, 'altKey', { value: true })
  return event
}

/** Start an in-tree drag on a row; returns the DataTransfer the handlers saw. */
function startDrag(container: HTMLDivElement, name: string): DataTransfer {
  const data = treeDataTransfer()
  act(() => { rowByName(container, name).dispatchEvent(dragEvent('dragstart', data)) })
  return data
}

/** Drop the in-flight drag at `coords`-style handler: dispatch dragover then
 *  drop on the given element. `altKey` = the copy modifier. */
function dragTo(element: HTMLElement, type: 'dragover' | 'drop', altKey = false): DataTransfer {
  const data = treeDataTransfer()
  act(() => { element.dispatchEvent(dragEvent(type, data, { altKey })) })
  return data
}

function pressKey(el: HTMLElement, init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }))
}

function openMenu(container: HTMLDivElement, name: string): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { rowByName(container, name).dispatchEvent(event) })
}

function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === label)
  if (item === undefined) throw new Error(`menuitem "${label}" not found`)
  act(() => { item.click() })
}

/** Set a controlled input's value the React way (native setter + input). */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('no native value setter')
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

afterEach(() => {
  resetTreeUndoStacks()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('in-tree drag & drop', () => {
  it('marks the row as the drag source with a custom MIME and copyMove effect', async () => {
    const harness = await mountTree()
    const data = startDrag(harness.container, 'a.ts')
    expect(data.setData).toHaveBeenCalledWith('application/x-dsh-tree-drag', '/tmp/a.ts')
    expect(data.effectAllowed).toBe('copyMove')
    expect(harness.container.querySelector('[class*="explorerRowDragging"]')?.textContent).toContain('a.ts')
  })

  it('moves a file into a directory row: fsMove + tab retarget + upload never fires', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    const sub = rowByName(harness.container, 'sub')
    dragTo(sub, 'dragover')
    dragTo(sub, 'drop')
    expect(fsMove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', '/tmp/sub')
    await vi.waitFor(() => {
      expect(harness.onPathRenamed).toHaveBeenCalledWith('/tmp/a.ts', '/tmp/sub/a.ts')
    })
    expect(harness.onUploadRequest).not.toHaveBeenCalled()
  })

  it('dropping onto a FILE row targets its parent directory', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    const deep = rowByName(harness.container, 'deep.ts')
    dragTo(deep, 'dragover')
    dragTo(deep, 'drop')
    expect(fsMove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', '/tmp/sub')
  })

  it('a same-parent move is a no-op (nothing leaves the wire)', async () => {
    const harness = await mountTree()
    // deep.ts dropped onto its own row: parent == its own directory.
    startDrag(harness.container, 'deep.ts')
    dragTo(rowByName(harness.container, 'deep.ts'), 'drop')
    // sub dropped onto deep.ts: parent == sub's own directory.
    startDrag(harness.container, 'sub')
    dragTo(rowByName(harness.container, 'deep.ts'), 'drop')
    expect(fsMove).not.toHaveBeenCalled()
    expect(fsCopy).not.toHaveBeenCalled()
  })

  it('dropping onto the tree body moves the row to the workspace root', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'deep.ts')
    dragTo(harness.body, 'dragover')
    dragTo(harness.body, 'drop')
    expect(fsMove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/sub/deep.ts', '/tmp')
    await vi.waitFor(() => {
      expect(harness.onPathRenamed).toHaveBeenCalledWith('/tmp/sub/deep.ts', '/tmp/deep.ts')
    })
  })

  it('Option/Alt + drop COPIES instead of moving (fsCopy, no tab retarget)', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    const sub = rowByName(harness.container, 'sub')
    // The dragover flips the dropEffect to copy (VS Code cursor hint)...
    const over = dragTo(sub, 'dragover', true)
    expect(over.dropEffect).toBe('copy')
    // ...and the drop (still with Option held) copies.
    dragTo(sub, 'drop', true)
    expect(fsCopy).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', '/tmp/sub')
    expect(fsMove).not.toHaveBeenCalled()
    expect(harness.onPathRenamed).not.toHaveBeenCalled()
  })

  it('refuses invalid targets without touching the wire: onto itself, into a descendant', async () => {
    const harness = await mountTree()
    // A directory dropped onto its own row.
    startDrag(harness.container, 'sub')
    dragTo(rowByName(harness.container, 'sub'), 'dragover')
    dragTo(rowByName(harness.container, 'sub'), 'drop')
    // The same dir dropped into its own descendant (sub/nested must exist as
    // a row — the fixture's sub level lists it).
    startDrag(harness.container, 'sub')
    dragTo(rowByName(harness.container, 'nested'), 'drop')
    expect(fsMove).not.toHaveBeenCalled()
    expect(fsCopy).not.toHaveBeenCalled()
    expect(harness.onUploadRequest).not.toHaveBeenCalled()
  })

  it('an invalid dragover shows no drop target highlight and a none effect', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'sub')
    const data = dragTo(rowByName(harness.container, 'sub'), 'dragover')
    expect(data.dropEffect).toBe('none')
    // Dropping onto a MOVABLE target does highlight (dropTarget state).
    startDrag(harness.container, 'a.ts')
    const sub = rowByName(harness.container, 'sub')
    act(() => { sub.dispatchEvent(dragEvent('dragover', treeDataTransfer())) })
    expect(harness.container.querySelector('[class*="explorerRowDropTarget"]')).not.toBeNull()
  })
})

describe('Cmd+Z undo / Cmd+Shift+Z redo', () => {
  it('undoes a move by moving back to the original directory (tab retarget reversed)', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    dragTo(rowByName(harness.container, 'sub'), 'drop')
    await vi.waitFor(() => { expect(harness.onPathRenamed).toHaveBeenCalled() })
    vi.clearAllMocks()
    pressKey(harness.body, { key: 'z', metaKey: true })
    expect(fsMove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/sub/a.ts', '/tmp')
    await vi.waitFor(() => {
      expect(harness.onPathRenamed).toHaveBeenCalledWith('/tmp/sub/a.ts', '/tmp/a.ts')
    })
  })

  it('undoes a rename via fsRename back to the original name', async () => {
    const harness = await mountTree()
    openMenu(harness.container, 'a.ts')
    clickMenuitem('Rename')
    const input = harness.container.querySelector<HTMLInputElement>('input')
    if (input === null) throw new Error('rename input not found')
    setNativeValue(input, 'b.ts')
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await vi.waitFor(() => {
      expect(fsRename).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', 'b.ts')
    })
    vi.clearAllMocks()
    pressKey(harness.body, { key: 'z', metaKey: true })
    expect(fsRename).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/renamed.ts', 'a.ts')
  })

  it('undoes a copy by deleting the copy (fsRemove)', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    dragTo(rowByName(harness.container, 'sub'), 'drop', true)
    await vi.waitFor(() => { expect(fsCopy).toHaveBeenCalled() })
    vi.clearAllMocks()
    pressKey(harness.body, { key: 'z', metaKey: true })
    expect(fsRemove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/sub/a.ts')
  })

  it('Cmd+Shift+Z and Ctrl+Y redo what was undone', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    dragTo(rowByName(harness.container, 'sub'), 'drop')
    await vi.waitFor(() => { expect(fsMove).toHaveBeenCalled() })
    pressKey(harness.body, { key: 'z', metaKey: true })
    await vi.waitFor(() => { expect(harness.onPathRenamed).toHaveBeenCalledWith('/tmp/sub/a.ts', '/tmp/a.ts') })
    vi.clearAllMocks()
    pressKey(harness.body, { key: 'z', metaKey: true, shiftKey: true })
    expect(fsMove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', '/tmp/sub')
    vi.clearAllMocks()
    pressKey(harness.body, { key: 'z', metaKey: true })
    await vi.waitFor(() => { expect(harness.onPathRenamed).toHaveBeenCalledWith('/tmp/sub/a.ts', '/tmp/a.ts') })
    vi.clearAllMocks()
    // Windows/Linux redo: plain Ctrl+Y (macOS Cmd+Y must stay untouched).
    pressKey(harness.body, { key: 'y', ctrlKey: true })
    expect(fsMove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/a.ts', '/tmp/sub')
  })

  it('macOS Cmd+Y is NOT hijacked as redo', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    dragTo(rowByName(harness.container, 'sub'), 'drop')
    await vi.waitFor(() => { expect(fsMove).toHaveBeenCalled() })
    pressKey(harness.body, { key: 'z', metaKey: true })
    await vi.waitFor(() => { expect(harness.onPathRenamed).toHaveBeenCalledWith('/tmp/sub/a.ts', '/tmp/a.ts') })
    vi.clearAllMocks()
    pressKey(harness.body, { key: 'y', metaKey: true })
    expect(fsMove).not.toHaveBeenCalled()
  })

  it('a new mutation after undo clears the redo stack', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    dragTo(rowByName(harness.container, 'sub'), 'drop')
    await vi.waitFor(() => { expect(fsMove).toHaveBeenCalled() })
    pressKey(harness.body, { key: 'z', metaKey: true })
    await vi.waitFor(() => { expect(harness.onPathRenamed).toHaveBeenCalledWith('/tmp/sub/a.ts', '/tmp/a.ts') })
    vi.clearAllMocks()
    // A fresh mutation: the copy.
    startDrag(harness.container, 'a.ts')
    dragTo(rowByName(harness.container, 'sub'), 'drop', true)
    await vi.waitFor(() => { expect(fsCopy).toHaveBeenCalled() })
    vi.clearAllMocks()
    pressKey(harness.body, { key: 'z', metaKey: true, shiftKey: true })
    expect(fsCopy).not.toHaveBeenCalled()
    expect(fsMove).not.toHaveBeenCalled()
  })

  it('never steals native text undo inside the rename input', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    dragTo(rowByName(harness.container, 'sub'), 'drop')
    await vi.waitFor(() => { expect(fsMove).toHaveBeenCalled() })
    vi.clearAllMocks()
    openMenu(harness.container, 'sub')
    clickMenuitem('Rename')
    const input = harness.container.querySelector<HTMLInputElement>('input')
    if (input === null) throw new Error('rename input not found')
    pressKey(input, { key: 'z', metaKey: true })
    expect(fsMove).not.toHaveBeenCalled()
    expect(fsRename).not.toHaveBeenCalled()
  })

  it('history survives a remount of the same session (module-level stacks)', async () => {
    let harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    dragTo(rowByName(harness.container, 'sub'), 'drop')
    await vi.waitFor(() => { expect(fsMove).toHaveBeenCalled() })
    harness.unmount()
    document.body.innerHTML = ''
    vi.clearAllMocks()
    harness = await mountTree()
    pressKey(harness.body, { key: 'z', metaKey: true })
    expect(fsMove).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, '/tmp/sub/a.ts', '/tmp')
  })

  it('failure refunds the history entry (still undoable, nothing lost)', async () => {
    const harness = await mountTree()
    startDrag(harness.container, 'a.ts')
    dragTo(rowByName(harness.container, 'sub'), 'drop')
    await vi.waitFor(() => { expect(fsMove).toHaveBeenCalled() })
    vi.clearAllMocks()
    // The inverse move fails on the wire.
    const failed = new Error('boom')
    vi.mocked(fsMove).mockRejectedValueOnce(failed)
    pressKey(harness.body, { key: 'z', metaKey: true })
    await vi.waitFor(() => {
      expect(harness.container.querySelector('[class*="explorerActionError"]')?.textContent).toContain('boom')
    })
    // The entry stays undoable: a second attempt succeeds and retargets.
    vi.mocked(fsMove).mockResolvedValueOnce({ path: '/tmp/a.ts' } as never)
    vi.clearAllMocks()
    pressKey(harness.body, { key: 'z', metaKey: true })
    await vi.waitFor(() => {
      expect(harness.onPathRenamed).toHaveBeenCalledWith('/tmp/sub/a.ts', '/tmp/a.ts')
    })
  })
})