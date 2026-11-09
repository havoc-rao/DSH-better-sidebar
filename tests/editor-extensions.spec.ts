/** Public extension ownership, async races, metadata and CM state retention. */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { search, openSearchPanel } from '@codemirror/search'
import { bindEditorExtensions } from '../src/client/cm-editor-extensions.ts'
import { createEditorExtensionsRegistry, type EditorExtensionSnapshot } from '../src/client/editor-extensions.ts'

const snapshot: EditorExtensionSnapshot = {
  document: { sessionId: 's', cwd: '/p', path: '/p/a.ts', generation: '1' },
  visible: true, readOnly: false, mode: 'regular', theme: { id: 'light', dark: false },
}
const noGit = { lines: new Map(), accuracy: 'unavailable' as const }
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('editorExtensions v1', () => {
  it('owns unique ids, handles already aborted owners and idempotent cleanup', () => {
    const api = createEditorExtensionsRegistry()
    const owner = new AbortController()
    const descriptor = { id: 'one', create: () => [] }
    const release = api.register(owner.signal, descriptor)
    expect(() => api.register(owner.signal, descriptor)).toThrow('Duplicate')
    release(); release()
    api.register(owner.signal, descriptor)
    owner.abort()
    expect(() => api.register(new AbortController().signal, descriptor)).not.toThrow()
    expect(() => api.register(owner.signal, descriptor)).not.toThrow()
    api.dispose()
  })

  it('passes exact runtime, updates metadata before empty transactions, and preserves editor state', async () => {
    const api = createEditorExtensionsRegistry()
    const owner = new AbortController()
    let seen = snapshot
    let destroyed = 0
    api.register(owner.signal, { id: 'test', create(context) {
      expect(Object.isFrozen(context.getSnapshot())).toBe(true)
      expect(Object.isFrozen(context.getSnapshot().document)).toBe(true)
      expect(Object.isFrozen(context.getSnapshot().theme)).toBe(true)
      expect(context.runtime.EditorView).toBe(EditorView)
      expect(context.getGitSnapshot(view.state)).toBe(noGit)
      return context.runtime.ViewPlugin.fromClass(class {
        update() { seen = context.getSnapshot() }
        destroy() { destroyed += 1 }
      })
    } })
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: 'abc', extensions: [history(), search()] }) })
    const binding = bindEditorExtensions(api, view, snapshot, () => noGit)
    try {
      await tick()
      view.dispatch({ changes: { from: 3, insert: 'd' }, selection: { anchor: 2 } })
      openSearchPanel(view)
      const selection = view.state.selection
      binding.update({ ...snapshot, visible: false })
      expect(seen.visible).toBe(false)
      expect(view.state.selection.eq(selection)).toBe(true)
      expect(view.dom.querySelector('.cm-search')).not.toBeNull()
      owner.abort()
      expect(destroyed).toBe(1)
      expect(view.state.doc.toString()).toBe('abcd')
      expect(undo(view)).toBe(true)
      expect(view.state.doc.toString()).toBe('abc')
    } finally { binding.dispose(); view.destroy(); api.dispose() }
  })

  it('rejects stale async results after abort, replacement id or view cleanup', async () => {
    const api = createEditorExtensionsRegistry()
    const owner = new AbortController()
    let resolve!: (extension: ReturnType<typeof EditorView.theme>) => void
    api.register(owner.signal, { id: 'slow', create: () => new Promise(done => { resolve = done }) })
    const view = new EditorView({ parent: document.body })
    const binding = bindEditorExtensions(api, view, snapshot, () => noGit)
    await tick()
    owner.abort()
    api.register(new AbortController().signal, { id: 'slow', create: () => [] })
    binding.dispose()
    view.destroy()
    resolve(EditorView.theme({ '&': { opacity: '0.2' } }))
    await tick()
    api.dispose()
  })

  it('does not invoke a factory cancelled before its first microtask', async () => {
    const api = createEditorExtensionsRegistry()
    const owner = new AbortController()
    const create = vi.fn(() => [])
    api.register(owner.signal, { id: 'cancelled', create })
    const view = new EditorView({ parent: document.body })
    const binding = bindEditorExtensions(api, view, snapshot, () => noGit)
    owner.abort()
    binding.dispose()
    view.destroy()
    await tick()
    expect(create).not.toHaveBeenCalled()
    api.dispose()
  })

  it('contains factory failures so the editor stays usable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = createEditorExtensionsRegistry()
    api.register(new AbortController().signal, { id: 'bad', create() { throw new Error('bad factory') } })
    const view = new EditorView({ parent: document.body })
    const binding = bindEditorExtensions(api, view, snapshot, () => noGit)
    try {
      await tick()
      expect(warn).toHaveBeenCalled()
      view.dispatch({ changes: { from: 0, insert: 'still editable' } })
      expect(view.state.doc.toString()).toBe('still editable')
    } finally { binding.dispose(); view.destroy(); api.dispose(); warn.mockRestore() }
  })
})
