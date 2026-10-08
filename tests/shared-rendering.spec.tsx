// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { EditorView } from '@codemirror/view'
import { undo, redo, undoDepth } from '@codemirror/commands'
import { foldCode, foldedRanges } from '@codemirror/language'
import { searchPanelOpen } from '@codemirror/search'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { sharedRendering } from '../src/client/rendering.tsx'
import { MarkdownPreview } from '../src/client/MarkdownPreview.tsx'
import { ControlledCodeEditor } from '../src/client/ControlledCodeEditor.tsx'
import { registerChunkForTests, resetChunks } from '../src/client/chunk-loader.ts'
import { setupReactAct } from './test-utils.ts'
setupReactAct()
afterEach(() => { resetChunks(); document.body.innerHTML = '' })
const labels = { copyLabel: 'Copy', copiedLabel: 'Copied', codeLabel: 'Code', wrapLabel: 'Wrap', unwrapLabel: 'Unwrap' }

describe('public shared rendering', () => {
  it('lazy-loads once and uses the shared cleaned markdown document', async () => {
    const loader = vi.fn(async () => ({ MarkdownPreview }))
    registerChunkForTests('editor', loader)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(sharedRendering.renderMarkdown({
      text: '---\nsecret: hidden\n---\n# A\n\n## B\n\n### C\n\n<div><script>bad()</script><img src="./a.png" /></div>',
      scope: { sessionId: 's', cwd: '/ws' }, path: '/ws/doc.md', codeLabels: labels,
    })) })
    expect(loader).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('secret: hidden')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/sidebar/file?sessionId=s')
    expect(container.querySelectorAll('h1,h2,h3')).toHaveLength(3)
    await act(async () => { root.unmount() })
  })
  it('returns the exact tools from the editor chunk, never clones extensions', async () => {
    const tools = { languageForPath: vi.fn(), cmSurfaceTheme: [], CmThemeCompartment: class {}, isDarkScheme: vi.fn(), subscribeColorScheme: vi.fn() }
    registerChunkForTests('editor', async () => tools)
    const result = await sharedRendering.loadCodeRendering()
    expect(result.languageForPath).toBe(tools.languageForPath)
    expect(result.cmSurfaceTheme).toBe(tools.cmSurfaceTheme)
  })
  it('preserves history, selection and both scroll axes across remounts with fresh callbacks', async () => {
    const cache = new Map<string, unknown>()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const oldChange = vi.fn()
    const newChange = vi.fn()
    const oldSave = vi.fn()
    const newSave = vi.fn()
    const props = { documentKey: 'cached', path: '/a.ts', content: 'let a = 1', onChange: oldChange, onSave: oldSave, stateCache: cache }
    await act(async () => { root.render(createElement(ControlledCodeEditor, props)) })
    const first = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    await act(async () => { first.dispatch({ changes: { from: 9, insert: '0' }, selection: { anchor: 4, head: 5 } }) })
    first.scrollDOM.scrollTop = 321
    first.scrollDOM.scrollLeft = 17
    await act(async () => { root.render(null) })
    expect(cache.has('cached')).toBe(true)
    const newProps = { ...props, content: 'let a = 10', onChange: newChange, onSave: newSave }
    await act(async () => { root.render(createElement(ControlledCodeEditor, newProps)) })
    const second = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    expect(second).not.toBe(first)
    expect(second.state.selection.main.from).toBe(4)
    expect(second.state.selection.main.to).toBe(5)
    expect(second.scrollDOM.scrollTop).toBe(321)
    expect(second.scrollDOM.scrollLeft).toBe(17)
    expect(undoDepth(second.state)).toBe(1)
    expect(newChange).not.toHaveBeenCalled()
    oldChange.mockClear()
    await act(async () => { undo(second) })
    expect(newChange).toHaveBeenLastCalledWith('let a = 1')
    expect(oldChange).not.toHaveBeenCalled()
    await act(async () => { redo(second) })
    expect(second.state.doc.toString()).toBe('let a = 10')
    await act(async () => { second.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true })) })
    expect(newSave).toHaveBeenCalledTimes(1)
    expect(oldSave).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
  })
  it('restores folding and exposes search and Tab indentation keymaps', async () => {
    const cache = new Map<string, unknown>()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const props = { documentKey: 'features', path: '/a.js', content: 'function a() {\n  return 1\n}\n', onChange: vi.fn(), stateCache: cache }
    await act(async () => { root.render(createElement(ControlledCodeEditor, props)) })
    const cm = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    await act(async () => { expect(foldCode(cm)).toBe(true) })
    expect(foldedRanges(cm.state).size).toBe(1)
    expect(container.querySelector('.cm-foldGutter')).not.toBeNull()
    await act(async () => { root.render(null); })
    await act(async () => { root.render(createElement(ControlledCodeEditor, props)) })
    const restored = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    expect(foldedRanges(restored.state).size).toBe(1)
    await act(async () => { restored.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true })) })
    expect(searchPanelOpen(restored.state)).toBe(true)
    await act(async () => { restored.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true })) })
    expect(props.onChange).toHaveBeenCalled()
    await act(async () => { root.unmount() })
  })
  it('ignores cache entries for another path and synchronizes restored content silently', async () => {
    const cache = new Map<string, unknown>()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const props = { documentKey: 'same', path: '/a.txt', content: 'old', onChange: vi.fn(), stateCache: cache }
    await act(async () => { root.render(createElement(ControlledCodeEditor, props)) })
    await act(async () => { root.render(null) })
    await act(async () => { root.render(createElement(ControlledCodeEditor, { ...props, content: 'external' })) })
    expect(container.querySelector('.cm-content')?.textContent).toBe('external')
    expect(props.onChange).not.toHaveBeenCalled()
    await act(async () => { root.render(createElement(ControlledCodeEditor, { ...props, path: '/b.txt', content: 'other' })) })
    const cm = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    expect(cm.state.doc.toString()).toBe('other')
    expect(undoDepth(cm.state)).toBe(0)
    await act(async () => { root.unmount() })
  })
  it('updates controlled content without feedback or destroying the view', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onChange = vi.fn()
    const onSave = vi.fn()
    const props = { documentKey: 'one', path: '/a.txt', content: 'first', onChange, onSave }
    await act(async () => { root.render(createElement(ControlledCodeEditor, props)) })
    const editor = container.querySelector('.cm-editor')
    await act(async () => { root.render(createElement(ControlledCodeEditor, { ...props, content: 'second' })) })
    expect(container.querySelector('.cm-editor')).toBe(editor)
    expect(container.querySelector('.cm-content')?.textContent).toBe('second')
    expect(onChange).not.toHaveBeenCalled()
    const cm = EditorView.findFromDOM(editor as HTMLElement)!
    await act(async () => { cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: 'typed' } }) })
    expect(onChange).toHaveBeenLastCalledWith('typed')
    await act(async () => {
      cm.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }))
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    await act(async () => { root.render(createElement(ControlledCodeEditor, { ...props, documentKey: 'two' })) })
    expect(container.querySelector('.cm-editor')).not.toBe(editor)
    await act(async () => { root.unmount() })
  })
})
