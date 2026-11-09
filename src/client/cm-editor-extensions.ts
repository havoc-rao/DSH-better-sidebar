/** Lazy-chunk adapter: supplies only this editor's CodeMirror runtime. */
import { Compartment, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import {
  editorExtensionEntries, subscribeEditorExtensions,
  type EditorExtensionContext, type EditorExtensionDescriptor, type EditorExtensionsV1, type EditorExtensionSnapshot,
} from './editor-extensions.ts'

const runtime = Object.freeze({ Compartment, StateEffect, StateField, Decoration, EditorView, ViewPlugin })
interface Installation { descriptor: EditorExtensionDescriptor; compartment: Compartment }

export function bindEditorExtensions(
  api: EditorExtensionsV1,
  view: EditorView,
  initial: EditorExtensionSnapshot,
  getGitSnapshot: EditorExtensionContext['getGitSnapshot'],
): { update(snapshot: EditorExtensionSnapshot): void; dispose(): void } {
  const document = Object.freeze({ ...initial.document })
  const freezeSnapshot = (value: EditorExtensionSnapshot): EditorExtensionSnapshot => Object.freeze({
    ...value, document, theme: Object.freeze({ ...value.theme }),
  })
  let snapshot = freezeSnapshot(initial)
  let active = true
  const installations = new Map<string, Installation>()
  const context: EditorExtensionContext = { runtime, getSnapshot: () => snapshot, getGitSnapshot }
  const sync = () => {
    if (!active) return
    const entries = editorExtensionEntries(api)
    for (const [id, item] of installations) {
      if (entries.includes(item.descriptor)) continue
      installations.delete(id)
      view.dispatch({ effects: item.compartment.reconfigure([]) })
    }
    for (const descriptor of entries) {
      if (installations.has(descriptor.id)) continue
      const item: Installation = { descriptor, compartment: new Compartment() }
      installations.set(descriptor.id, item)
      view.dispatch({ effects: StateEffect.appendConfig.of(item.compartment.of([])) })
      // Factory code (including synchronous throws) executes outside CM updates.
      void Promise.resolve().then(() => {
        if (!active || installations.get(descriptor.id) !== item) return []
        return descriptor.create(context)
      }).then((extension: Extension) => {
        if (!active || installations.get(descriptor.id) !== item) return
        view.dispatch({ effects: item.compartment.reconfigure(extension) })
      }).catch((error: unknown) => {
        // A consumer failure must never break file editing or become unhandled.
        console.warn(`Editor extension ${descriptor.id} failed`, error)
      })
    }
  }
  const unsubscribe = subscribeEditorExtensions(api, sync)
  sync()
  return {
    update(next) {
      if (!active) return
      if (next.document.generation !== snapshot.document.generation) {
        throw new Error('Bind a new editor extension owner when replacing the buffer')
      }
      snapshot = freezeSnapshot(next)
      view.dispatch({})
    },
    dispose() {
      if (!active) return
      active = false
      unsubscribe()
      // Caller disposes the binding before destroying its view.
      for (const item of installations.values()) view.dispatch({ effects: item.compartment.reconfigure([]) })
      installations.clear()
    },
  }
}
