// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { FileReferenceDrop } from '../src/client/FileReferenceDrop.tsx'
import { FILE_REFERENCE_MIME, TREE_DRAG_MIME, insertDroppedFileReference, parseFileReferenceDrag, writeFileReferenceDrag } from '../src/client/file-reference-drag.ts'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

const payload = { version: 1 as const, path: '/work/src/a.ts', isDir: false }
function actions(success = true) {
  return { captureInsertion: vi.fn(() => ({ start: 2, end: 4, draftRev: 7 })),
    insertReference: vi.fn((_reference: unknown, _span: unknown) => success), insertText: vi.fn((_text: string, _span: unknown) => success), focus: vi.fn() }
}

describe('file reference drag protocol', () => {
  it('writes independent reference and tree move payloads without raw text', () => {
    const transfer = { setData: vi.fn(), effectAllowed: '' as DataTransfer['effectAllowed'] }
    writeFileReferenceDrag(transfer, payload.path, false)
    expect(transfer.effectAllowed).toBe('copyMove')
    expect(transfer.setData.mock.calls).toEqual([[TREE_DRAG_MIME, payload.path], [FILE_REFERENCE_MIME, JSON.stringify(payload)]])
  })
  it('rejects invalid versions, relative paths, control characters, and malformed data', () => {
    for (const raw of ['', 'null', '{', JSON.stringify({ ...payload, version: 2 }),
      JSON.stringify({ ...payload, path: 'a.ts' }), JSON.stringify({ ...payload, path: '/a\n.ts' }),
      JSON.stringify({ ...payload, isDir: 'false' })]) expect(parseFileReferenceDrag(raw)).toBeUndefined()
    expect(parseFileReferenceDrag(JSON.stringify(payload))).toEqual(payload)
  })
  it('keeps unrepresentable names available for tree moves only', () => {
    const transfer = { setData: vi.fn(), effectAllowed: '' as DataTransfer['effectAllowed'] }
    writeFileReferenceDrag(transfer, '/work/a"b', false)
    expect(transfer.setData.mock.calls).toEqual([[TREE_DRAG_MIME, '/work/a"b']])
  })
  it('inserts a chip using the captured selection then focuses', () => {
    const input = actions()
    expect(insertDroppedFileReference(input, payload, '/work')).toBe(true)
    expect(input.insertReference).toHaveBeenCalledWith({ source: 'reference', ref: '@src/a.ts', label: 'a.ts', appearance: 'file', clipboardText: '@src/a.ts' }, { start: 2, end: 4, draftRev: 7 })
    expect(input.focus).toHaveBeenCalledOnce()
    expect(input.insertReference.mock.invocationCallOrder[0]).toBeLessThan(input.focus.mock.invocationCallOrder[0]!)
  })
  it('preserves external absolute paths and quotes paths containing spaces', () => {
    const input = actions()
    insertDroppedFileReference(input, { ...payload, path: '/other/a b.ts' }, '/work')
    expect(input.insertReference.mock.calls[0]?.[0]).toMatchObject({ ref: '@"/other/a b.ts"' })
  })
  it('inserts directories as text with a slash inside quotes, including the root', () => {
    const input = actions()
    insertDroppedFileReference(input, { ...payload, path: '/work/my folder', isDir: true }, '/work')
    expect(input.insertText).toHaveBeenCalledWith('@"my folder/"', expect.anything())
    insertDroppedFileReference(input, { ...payload, path: '/work', isDir: true }, '/work')
    expect(input.insertText).toHaveBeenLastCalledWith('@./', expect.anything())
    expect(input.insertReference).not.toHaveBeenCalled()
  })
  it('never focuses after failed insertion or overwrites drafts on older hosts', () => {
    const input = actions(false)
    expect(insertDroppedFileReference(input, payload, '/work')).toBe(false)
    expect(input.focus).not.toHaveBeenCalled()
    const old = { captureInsertion: input.captureInsertion, insertText: input.insertText }
    input.captureInsertion.mockClear()
    expect(insertDroppedFileReference(old, payload, '/work')).toBe(false)
    expect(input.captureInsertion).not.toHaveBeenCalled()
  })
})

const roots: Root[] = []
afterEach(() => {
  act(() => { roots.splice(0).forEach(root => root.unmount()) })
  document.body.innerHTML = ''
})
function mount(sessionId = 's1', phase = 'plain', input = actions()) {
  const occurrence = document.createElement('section')
  occurrence.setAttribute('data-conversation-session', sessionId)
  occurrence.innerHTML = '<div data-composer-card><textarea></textarea><div class="mount"></div></div><article></article>'
  document.body.append(occurrence)
  const root = createRoot(occurrence.querySelector('.mount')!)
  roots.push(root)
  act(() => root.render(createElement(FileReferenceDrop, {
    sessionId, inputActions: input,
    useInput: (select: (state: unknown) => unknown) => select({ phase }),
    ctx: { sessions: { list: { getSnapshot: () => ({ byId: { [sessionId]: { cwd: '/work' } } }) } } } as unknown as Context,
  } as unknown as Parameters<typeof FileReferenceDrop>[0])))
  return { occurrence, input, target: occurrence.querySelector('article')!, textarea: occurrence.querySelector('textarea')! }
}
function fire(target: Element, type: string, raw = JSON.stringify(payload), types = [FILE_REFERENCE_MIME]) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const transfer = { types, getData: () => raw, dropEffect: '' }
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  act(() => { target.dispatchEvent(event) })
  return { event, transfer }
}

describe('conversation file reference drop ownership', () => {
  it('claims transcript drops and routes to the targeted split session only', () => {
    const first = mount('s1')
    const second = mount('s2')
    const over = fire(second.target, 'dragover')
    expect(over.event.defaultPrevented).toBe(true)
    expect(over.transfer.dropEffect).toBe('copy')
    fire(second.target, 'drop')
    expect(second.input.insertReference).toHaveBeenCalledOnce()
    expect(second.input.focus).toHaveBeenCalledOnce()
    expect(first.input.insertReference).not.toHaveBeenCalled()
  })
  it('excludes trees, sidebar hosts, page chrome and OS file uploads', () => {
    const view = mount()
    for (const attr of ['data-dsh-file-tree', 'data-dsh-panel-host', 'data-dsh-native-tab-host']) {
      view.target.setAttribute(attr, '')
      expect(fire(view.target, 'drop').event.defaultPrevented).toBe(false)
      view.target.removeAttribute(attr)
    }
    expect(fire(document.body, 'drop').event.defaultPrevented).toBe(false)
    expect(fire(view.target, 'drop', '', [FILE_REFERENCE_MIME, 'Files']).event.defaultPrevented).toBe(false)
    expect(view.input.insertReference).not.toHaveBeenCalled()
  })
  it('claims but refuses malformed, locked and read-only drops', () => {
    const view = mount()
    expect(fire(view.target, 'drop', '{').event.defaultPrevented).toBe(true)
    view.textarea.readOnly = true
    expect(fire(view.target, 'dragover').transfer.dropEffect).toBe('none')
    fire(view.target, 'drop')
    const locked = mount('s2', 'frozen')
    fire(locked.target, 'drop')
    expect(view.input.insertReference).not.toHaveBeenCalled()
    expect(locked.input.insertReference).not.toHaveBeenCalled()
  })
  it('ignores hidden occurrences and refuses ambiguous duplicate composers', () => {
    const hidden = mount('hidden')
    hidden.occurrence.hidden = true
    expect(fire(hidden.target, 'drop').event.defaultPrevented).toBe(false)
    const view = mount()
    const second = document.createElement('div')
    view.occurrence.append(second)
    const root = createRoot(second)
    roots.push(root)
    act(() => root.render(createElement(FileReferenceDrop, {
      sessionId: 's1', inputActions: actions(), useInput: () => 'plain', ctx: {} as Context,
    } as unknown as Parameters<typeof FileReferenceDrop>[0])))
    expect(fire(view.target, 'drop').event.defaultPrevented).toBe(false)
  })
  it('shows a full-page body portal, switches owners, and clears after drop', () => {
    const first = mount('s1')
    const second = mount('s2')
    fire(first.target, 'dragenter')
    const overlay = document.querySelector('[data-dsh-file-reference-overlay]')!
    expect(overlay.parentElement).toBe(document.body)
    expect(overlay.getAttribute('data-dsh-file-reference-overlay')).toBe('ready')
    fire(second.target, 'dragover')
    expect(document.querySelectorAll('[data-dsh-file-reference-overlay]')).toHaveLength(1)
    fire(second.target, 'drop')
    expect(document.querySelector('[data-dsh-file-reference-overlay]')).toBeNull()
  })
  it('shows blocked feedback and clears on returning to the tree, dragend or blur', () => {
    const view = mount('s1', 'frozen')
    fire(view.target, 'dragover')
    expect(document.querySelector('[data-dsh-file-reference-overlay]')?.getAttribute('data-dsh-file-reference-overlay')).toBe('blocked')
    const tree = document.createElement('div')
    tree.setAttribute('data-dsh-file-tree', '')
    view.occurrence.append(tree)
    fire(tree, 'dragover')
    expect(document.querySelector('[data-dsh-file-reference-overlay]')).toBeNull()
    for (const event of ['dragend', 'blur']) {
      fire(view.target, 'dragover')
      act(() => { window.dispatchEvent(new Event(event)) })
      expect(document.querySelector('[data-dsh-file-reference-overlay]')).toBeNull()
    }
  })
  it('retains the overlay through child transitions but clears when leaving the viewport', () => {
    const view = mount()
    fire(view.target, 'dragover')
    const event = new Event('dragleave', { bubbles: true })
    Object.defineProperty(event, 'relatedTarget', { value: view.textarea })
    act(() => { view.target.dispatchEvent(event) })
    expect(document.querySelector('[data-dsh-file-reference-overlay]')).not.toBeNull()
    const exit = new Event('dragleave', { bubbles: true })
    Object.defineProperty(exit, 'clientX', { value: 0 })
    act(() => { view.target.dispatchEvent(exit) })
    expect(document.querySelector('[data-dsh-file-reference-overlay]')).toBeNull()
  })
  it('removes window listeners on unmount', () => {
    const view = mount()
    act(() => roots.splice(0).forEach(root => root.unmount()))
    expect(fire(view.target, 'drop').event.defaultPrevented).toBe(false)
  })
})
