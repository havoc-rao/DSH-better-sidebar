/** Optional external-workspace acceptance: run with DSH_EDITOR_VISUALS_ENTRY pointing at its built lib/index.js. */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createEditorExtensionsRegistry } from '../src/client/editor-extensions.ts'
import { bindEditorExtensions } from '../src/client/cm-editor-extensions.ts'
import { applyGitLineKinds, editorGitSnapshot, gitGutterExtensions } from '../src/client/editor-git-gutter.ts'

const entry = process.env.DSH_EDITOR_VISUALS_ENTRY

describe.skipIf(entry === undefined)('built independent editor visuals consumer', () => {
  it('loads the external built factory with the host runtime and cleanly removes its DOM/backgrounds', async () => {
    const { registerEditorVisuals } = await import(/* @vite-ignore */ entry!)
    const api = createEditorExtensionsRegistry()
    const owner = new AbortController()
    const release = registerEditorVisuals({ editorExtensions: api }, owner.signal)
    const view = new EditorView({ parent: document.body, state: EditorState.create({
      doc: 'one\ntwo\nthree', extensions: gitGutterExtensions({ scope: { sessionId: 's', cwd: '/p' }, path: '/p/a.ts' }),
    }) })
    const binding = bindEditorExtensions(api, view, {
      document: { sessionId: 's', cwd: '/p', path: '/p/a.ts', generation: 'external-1' },
      visible: true, readOnly: false, mode: 'regular', theme: { id: 'dark', dark: true },
    }, editorGitSnapshot)
    try {
      // Wait on an observable asynchronous lazy factory result, not a fixed delay.
      await vi.waitFor(() => expect(view.dom.querySelector('.cm-dsh-minimap')).not.toBeNull())
      applyGitLineKinds(view, new Map([[2, 'mod']]))
      expect(view.state.doc.toString()).toBe('one\ntwo\nthree')
      expect(editorGitSnapshot(view.state).accuracy).toBe('head')
      owner.abort(); release()
      expect(view.dom.querySelector('.cm-dsh-minimap')).toBeNull()
    } finally { binding.dispose(); view.destroy(); api.dispose() }
  })
})
