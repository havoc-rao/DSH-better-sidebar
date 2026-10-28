/**
 * Workspace-scoped tool membership, independent of sessions and the DOM.
 * Each kind has its own versioned record so concurrent files/git edits cannot
 * overwrite each other. The host does not support shared tab reordering.
 */
export type WorkspaceToolKind = 'files' | 'git'

type ToolState = Partial<Record<WorkspaceToolKind, boolean>>
type StoreOptions = {
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  namespace: string
  subscribeStorage?: (listener: () => void) => () => void
}

const KINDS: readonly WorkspaceToolKind[] = ['files', 'git']
const FALLBACK_LIMIT = 64

function decode(raw: string | null): boolean | undefined {
  if (raw === null) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    return record.version === 1 && typeof record.open === 'boolean' ? record.open : undefined
  } catch {
    return undefined
  }
}

export function createWorkspaceToolTabsStore({ storage, namespace, subscribeStorage }: StoreOptions): {
  read(workspaceKey: string): readonly WorkspaceToolKind[] | undefined
  set(workspaceKey: string, kind: WorkspaceToolKind, open: boolean): void
  seed(workspaceKey: string, kinds: readonly WorkspaceToolKind[]): void
  subscribe(listener: () => void): () => void
  dispose(): void
} {
  // Only failed writes (or storage-less writes) live here, never cached disk
  // reads. Cap by workspace, retaining both kinds together on eviction.
  const fallback = new Map<string, ToolState>()
  const listeners = new Set<() => void>()
  let disposed = false
  const keyOf = (workspaceKey: string, kind: WorkspaceToolKind) =>
    `better-sidebar:workspace-tool-tabs:v1:${JSON.stringify([namespace, workspaceKey, kind])}`

  function notify(): void {
    if (!disposed) for (const listener of [...listeners]) listener()
  }

  function readKind(workspaceKey: string, kind: WorkspaceToolKind): boolean | undefined {
    const local = fallback.get(workspaceKey)?.[kind]
    if (local !== undefined) return local
    try {
      return storage ? decode(storage.getItem(keyOf(workspaceKey, kind))) : undefined
    } catch {
      return undefined
    }
  }

  function remember(workspaceKey: string, kind: WorkspaceToolKind, open: boolean): void {
    const state = fallback.get(workspaceKey) ?? {}
    state[kind] = open
    fallback.delete(workspaceKey)
    fallback.set(workspaceKey, state)
    if (fallback.size > FALLBACK_LIMIT) fallback.delete(fallback.keys().next().value!)
  }

  function writeKind(workspaceKey: string, kind: WorkspaceToolKind, open: boolean): boolean {
    if (readKind(workspaceKey, kind) === open) return false
    try {
      if (!storage) throw new Error('Storage unavailable')
      storage.setItem(keyOf(workspaceKey, kind), JSON.stringify({ version: 1, open }))
      // Some storage wrappers deny reads independently of writes. Keep the
      // page-memory value in that case as well, rather than losing this edit.
      storage.getItem(keyOf(workspaceKey, kind))
      const local = fallback.get(workspaceKey)
      if (local) {
        delete local[kind]
        if (Object.keys(local).length === 0) fallback.delete(workspaceKey)
      }
    } catch {
      remember(workspaceKey, kind, open)
    }
    return true
  }

  function read(workspaceKey: string): readonly WorkspaceToolKind[] | undefined {
    const files = readKind(workspaceKey, 'files')
    const git = readKind(workspaceKey, 'git')
    if (files === undefined && git === undefined) return undefined
    return KINDS.filter(kind => kind === 'files' ? files === true : git === true)
  }

  const unsubscribeStorage = subscribeStorage?.(notify)
  return {
    read,
    set(workspaceKey, kind, open) {
      if (writeKind(workspaceKey, kind, open)) notify()
    },
    seed(workspaceKey, kinds) {
      // Any initialized membership is authoritative, including an explicit
      // close of just one kind. Never resurrect it from an older session.
      if (read(workspaceKey) !== undefined) return
      let changed = false
      for (const kind of KINDS) changed = writeKind(workspaceKey, kind, kinds.includes(kind)) || changed
      if (changed) notify()
    },
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      unsubscribeStorage?.()
    },
  }
}
