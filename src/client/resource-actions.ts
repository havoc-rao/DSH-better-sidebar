import type { ReactNode } from 'react'
import type { SessionScope } from './api.ts'
import type { SidebarDiffRef } from './state.ts'

export interface FileDocumentState {
  dirty: boolean | 'unknown'
  readOnly: boolean
}

interface FileResourceContext extends FileDocumentState {
  kind: 'file'
  scope: SessionScope
  absolutePath: string
  isDirectory: false
}

export type ResourceActionContext =
  | (FileResourceContext & { surface: 'file-tree-context' })
  | (FileResourceContext & { surface: 'file-viewer-toolbar' })
  | { kind: 'git-diff'; surface: 'git-preview-toolbar'; scope: SessionScope; ref: SidebarDiffRef }

export interface ResourceActionDescriptor {
  id: string
  surfaces: readonly ResourceActionContext['surface'][]
  label: string | (() => string)
  icon?: ReactNode | ((size: number) => ReactNode)
  /** Ascending, stable; defaults to 100. */
  order?: number
  available?(context: ResourceActionContext): boolean
  run(context: ResourceActionContext, signal: AbortSignal): void | Promise<void>
}

export interface FileActivationContext extends FileDocumentState {
  intent: 'activate'
  scope: SessionScope
  absolutePath: string
}

export interface FileOpenTargetDescriptor {
  id: string
  /** Lower priorities run first; ties retain registration order. */
  priority: number
  accept(context: FileActivationContext): boolean
  open(context: FileActivationContext, signal: AbortSignal):
    'handled' | 'declined' | Promise<'handled' | 'declined'>
}

interface Registration<T> { descriptor: T; tasks: Set<AbortController> }

function aborted(): DOMException {
  return new DOMException('Resource interaction was cancelled', 'AbortError')
}

/** Reject promptly on cancellation even if a consumer ignores its signal.
 * The consumer's late resolution/rejection is observed but cannot resume navigation.
 */
function invoke<T>(controller: AbortController, callback: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { signal } = controller
    if (signal.aborted) { reject(aborted()); return }
    const onAbort = () => reject(aborted())
    signal.addEventListener('abort', onAbort, { once: true })
    let result: T | Promise<T>
    try { result = callback() } catch (error) {
      signal.removeEventListener('abort', onAbort)
      reject(signal.aborted ? aborted() : error)
      return
    }
    Promise.resolve(result).then(value => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(aborted())
      else resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.aborted ? aborted() : error)
    })
  })
}

/** Browser-only registry. Exceptions intentionally propagate to the host UI;
 * in particular an accepted target failure must never turn into fallback navigation.
 * readContext must query the current surface/document state, not a menu-time snapshot.
 */
export function createResourceActionRegistry(notify: () => void) {
  const actions = new Map<string, Registration<ResourceActionDescriptor>>()
  const targets = new Map<string, Registration<FileOpenTargetDescriptor>>()
  const tasks = new Set<AbortController>()
  const documents = new Map<string, Map<string, FileDocumentState>>()
  let disposed = false

  function ensureLive() { if (disposed) throw aborted() }
  function check(controller: AbortController) {
    if (disposed || controller.signal.aborted) throw aborted()
  }
  function register<T extends { id: string }>(map: Map<string, Registration<T>>, descriptor: T) {
    ensureLive()
    if (map.has(descriptor.id)) throw new Error(`Resource descriptor already registered: ${descriptor.id}`)
    const entry: Registration<T> = { descriptor, tasks: new Set() }
    map.set(descriptor.id, entry)
    notify()
    return () => {
      if (map.get(descriptor.id) !== entry) return
      map.delete(descriptor.id)
      for (const task of entry.tasks) task.abort()
      entry.tasks.clear()
      notify()
    }
  }
  // An absolute path identifies a document within a session. cwd/repoRoot are
  // routing hints, not a second identity for the same session/path document.
  function documentKey(scope: SessionScope, path: string) {
    return JSON.stringify([scope.sessionId, path])
  }
  function setFileDocumentState(ownerId: string, scope: SessionScope, path: string, state: FileDocumentState | undefined) {
    ensureLive()
    const key = documentKey(scope, path)
    let owners = documents.get(key)
    if (state === undefined) {
      if (!owners?.delete(ownerId)) return
      if (owners.size === 0) documents.delete(key)
    } else {
      if (!owners) { owners = new Map(); documents.set(key, owners) }
      owners.set(ownerId, { ...state })
    }
    notify()
  }
  function getFileDocumentState(scope: SessionScope, path: string): FileDocumentState {
    let dirty: FileDocumentState['dirty'] = false
    let readOnly = false
    for (const state of documents.get(documentKey(scope, path))?.values() ?? []) {
      if (state.dirty === true) dirty = true
      else if (state.dirty === 'unknown' && dirty !== true) dirty = 'unknown'
      readOnly ||= state.readOnly
    }
    return { dirty, readOnly }
  }
  function reportFileDocument(ownerId: string, scope: SessionScope, path: string, state: FileDocumentState) {
    setFileDocumentState(ownerId, scope, path, state)
    const key = documentKey(scope, path)
    const report = documents.get(key)?.get(ownerId)
    return () => {
      if (disposed || documents.get(key)?.get(ownerId) !== report) return
      setFileDocumentState(ownerId, scope, path, undefined)
    }
  }

  return {
    registerResourceAction: (descriptor: ResourceActionDescriptor) => register(actions, descriptor),
    getResourceActions(context: ResourceActionContext): ResourceActionDescriptor[] {
      if (disposed) return []
      return [...actions.values()].map(entry => entry.descriptor)
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        .filter(action => action.surfaces.includes(context.surface) && (!action.available || action.available(context)))
    },
    async runResourceAction(id: string, readContext: () => ResourceActionContext): Promise<void> {
      ensureLive()
      const entry = actions.get(id)
      if (!entry) throw new Error(`Resource action unavailable: ${id}`)
      const controller = new AbortController()
      tasks.add(controller); entry.tasks.add(controller)
      try {
        const context = readContext()
        check(controller)
        const action = entry.descriptor
        if (!action.surfaces.includes(context.surface) || (action.available && !action.available(context))) {
          check(controller)
          throw new Error(`Resource action unavailable: ${id}`)
        }
        check(controller)
        await invoke(controller, () => action.run(context, controller.signal))
      } finally { tasks.delete(controller); entry.tasks.delete(controller) }
    },
    registerFileOpenTarget: (descriptor: FileOpenTargetDescriptor) => register(targets, descriptor),
    async dispatchFileActivation(readContext: () => FileActivationContext): Promise<boolean> {
      ensureLive()
      const controller = new AbortController()
      tasks.add(controller)
      try {
        const ordered = [...targets.values()].sort((a, b) => a.descriptor.priority - b.descriptor.priority)
        for (const entry of ordered) {
          check(controller)
          if (targets.get(entry.descriptor.id) !== entry) continue
          entry.tasks.add(controller)
          try {
            const context = readContext()
            check(controller)
            const accepted = entry.descriptor.accept(context)
            check(controller)
            if (!accepted) continue
            const result = await invoke(controller, () => entry.descriptor.open(context, controller.signal))
            check(controller)
            if (result === 'handled') return true
            if (result !== 'declined') throw new Error(`Invalid file open result: ${entry.descriptor.id}`)
          } finally { entry.tasks.delete(controller) }
        }
        check(controller)
        return false
      } finally { tasks.delete(controller) }
    },
    setFileDocumentState,
    getFileDocumentState,
    reportFileDocument,
    dispose() {
      if (disposed) return
      disposed = true
      for (const task of tasks) task.abort()
      tasks.clear(); actions.clear(); targets.clear(); documents.clear()
      notify()
    },
  }
}

export type ResourceActionRegistry = ReturnType<typeof createResourceActionRegistry>
