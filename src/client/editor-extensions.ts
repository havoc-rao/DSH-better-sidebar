/** Public editor extension registry. All CodeMirror imports are erased. */
import type * as State from '@codemirror/state'
import type * as View from '@codemirror/view'

export interface EditorExtensionSnapshot {
  readonly document: { readonly sessionId: string; readonly cwd: string; readonly path: string; readonly generation: string }
  readonly visible: boolean
  readonly readOnly: boolean
  readonly mode: 'regular' | 'streaming'
  readonly theme: { readonly id: string; readonly dark: boolean }
}
export interface EditorGitSnapshot {
  readonly lines: ReadonlyMap<number, 'add' | 'mod' | 'del'>
  readonly accuracy: 'head' | 'provisional' | 'unavailable'
}
export interface EditorExtensionRuntime {
  readonly EditorView: typeof View.EditorView
  readonly ViewPlugin: typeof View.ViewPlugin
  readonly Decoration: typeof View.Decoration
  readonly StateEffect: typeof State.StateEffect
  readonly StateField: typeof State.StateField
  readonly Compartment: typeof State.Compartment
}
export interface EditorExtensionContext {
  readonly runtime: EditorExtensionRuntime
  getSnapshot(): EditorExtensionSnapshot
  getGitSnapshot(state: State.EditorState): EditorGitSnapshot
}
export interface EditorExtensionDescriptor {
  readonly id: string
  create(context: EditorExtensionContext): State.Extension | Promise<State.Extension>
}
export interface EditorExtensionsV1 {
  readonly version: 1
  register(owner: AbortSignal, descriptor: EditorExtensionDescriptor): () => void
}
interface Registry {
  entries: Map<string, EditorExtensionDescriptor>
  listeners: Set<() => void>
}
// Registry identity is the public service object, shared across core/lazy bundles.
// Use a symbol property, not module-local WeakMap (the chunk is a separate bundle).
const registryKey = Symbol.for('dsh-better-sidebar.editorExtensions.v1')
type InternalRegistry = EditorExtensionsV1 & { [registryKey]: Registry }
export function subscribeEditorExtensions(api: EditorExtensionsV1, listener: () => void): () => void {
  const registry = (api as InternalRegistry)[registryKey]
  registry.listeners.add(listener)
  return () => { registry.listeners.delete(listener) }
}
export function editorExtensionEntries(api: EditorExtensionsV1): readonly EditorExtensionDescriptor[] {
  return [...(api as InternalRegistry)[registryKey].entries.values()]
}
export function createEditorExtensionsRegistry(): EditorExtensionsV1 & { dispose(): void } {
  const registry: Registry = { entries: new Map(), listeners: new Set() }
  const disposers = new Set<() => void>()
  let disposed = false
  const notify = () => { for (const listener of [...registry.listeners]) listener() }
  return {
    version: 1,
    [registryKey]: registry,
    register(owner, descriptor) {
      if (disposed || owner.aborted) return () => {}
      if (!descriptor.id.trim()) throw new Error('Editor extension id must not be empty')
      if (registry.entries.has(descriptor.id)) throw new Error(`Duplicate editor extension: ${descriptor.id}`)
      registry.entries.set(descriptor.id, descriptor)
      let active = true
      const dispose = () => {
        if (!active) return
        active = false
        owner.removeEventListener('abort', dispose)
        disposers.delete(dispose)
        registry.entries.delete(descriptor.id)
        notify()
      }
      disposers.add(dispose)
      owner.addEventListener('abort', dispose, { once: true })
      notify()
      return dispose
    },
    dispose() {
      disposed = true
      for (const dispose of [...disposers]) dispose()
      registry.listeners.clear()
    },
  } as InternalRegistry & { dispose(): void }
}
