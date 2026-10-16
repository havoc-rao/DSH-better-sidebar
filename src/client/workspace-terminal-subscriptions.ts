import { isSafeTerminalCommand } from '../terminal-command.ts'
import { isTerminalAccessDenied } from './terminal-errors.ts'
import type { SessionScope, WorkspaceTerminalInfo } from './api.ts'
import type { WorkspaceTerminalSummary } from './service.ts'
import type { TerminalProviderDescriptor, WorkspaceTerminalSource } from './terminal-source.ts'

/** Same projection for point reads and pushed catalogs; never expose paths/argv. */
export function summarizeWorkspaceTerminals(terminals: readonly WorkspaceTerminalInfo[]): WorkspaceTerminalSummary {
  const summary: WorkspaceTerminalSummary = { total: 0, busy: 0, idle: 0, unknown: 0, exited: 0 }
  const seen = new Set<string>()
  const commands = new Map<string, number>()
  for (const terminal of terminals) {
    if (seen.has(terminal.terminalId)) continue
    seen.add(terminal.terminalId)
    if (terminal.exited || terminal.activity === 'exited') { summary.exited++; continue }
    summary.total++
    if (terminal.activity === 'busy') {
      summary.busy++
      if (Array.isArray(terminal.runningCommands)) {
        for (const name of new Set(terminal.runningCommands.filter(isSafeTerminalCommand))) {
          commands.set(name, (commands.get(name) ?? 0) + 1)
        }
      }
    } else if (terminal.activity === 'idle') summary.idle++
    else summary.unknown++
  }
  if (commands.size) summary.runningCommands = [...commands].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, count]) => ({ name, count }))
  return summary
}

function safely(callback: () => void): void {
  try { callback() } catch (error) { console.error('[dsh-better-sidebar] workspace terminal listener error:', error) }
}
type Listener = { summary: (value: WorkspaceTerminalSummary) => void; error?: (error: unknown) => void }
type Entry = {
  sessionId: string; cwd?: string; ownerId?: string; provider?: TerminalProviderDescriptor
  listeners: Set<Listener>; generation: number; started: boolean; stopped: boolean
  off?: () => void; timer?: ReturnType<typeof setTimeout>; abort?: AbortController
  latest?: WorkspaceTerminalSummary; failure?: { error: unknown }
}

/** Service-owned, demand-driven catalog subscriptions. Session identity is an
 * authorization boundary even when two sessions share the same workspace cwd. */
export function createWorkspaceTerminalSubscriptions(options: {
  getProviders(): readonly TerminalProviderDescriptor[]
  local(sessionId: string, cwd?: string): WorkspaceTerminalSource
  sessionCwd?(sessionId: string): string | undefined
}) {
  const entries = new Map<string, Entry>()
  let disposed = false
  let reconciling = false
  let pending = false
  function live(entry: Entry, generation: number): boolean {
    return !disposed && entry.listeners.size > 0 && entry.generation === generation
  }
  function stop(entry: Entry): void {
    entry.generation++
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.abort?.abort()
    entry.abort = undefined
    const off = entry.off
    entry.off = undefined
    if (off) safely(off)
  }
  function fail(entry: Entry, generation: number, error: unknown): void {
    if (!live(entry, generation)) return
    entry.latest = undefined
    entry.failure = { error }
    if (isTerminalAccessDenied(error)) { entry.stopped = true; stop(entry) }
    const deliveryGeneration = entry.generation
    for (const listener of [...entry.listeners]) {
      if (!live(entry, deliveryGeneration)) break
      if (entry.listeners.has(listener)) safely(() => listener.error?.(error))
    }
  }
  function start(entry: Entry, provider: TerminalProviderDescriptor | undefined): void {
    stop(entry)
    entry.started = true
    entry.stopped = false
    entry.provider = provider
    if (provider) entry.ownerId = provider.id
    entry.latest = undefined
    entry.failure = undefined
    const generation = entry.generation
    try {
      if (!provider && entry.ownerId !== undefined) throw new Error(`Workspace terminal provider unavailable: ${entry.ownerId}`)
      const source = provider ? provider.createWorkspaceSource?.(entry.sessionId, entry.cwd) : options.local(entry.sessionId, entry.cwd)
      if (!source) throw new Error(`Workspace terminal management unavailable: ${provider?.id}`)
      if (!live(entry, generation)) return
      const snapshot = ({ terminals }: { terminals: WorkspaceTerminalInfo[] }): void => {
        if (!live(entry, generation)) return
        entry.latest = summarizeWorkspaceTerminals(terminals)
        entry.failure = undefined
        const summary = entry.latest
        for (const listener of [...entry.listeners]) {
          if (!live(entry, generation)) break
          if (entry.listeners.has(listener)) safely(() => listener.summary(summary))
        }
      }
      if (source.subscribe) {
        const off = source.subscribe(snapshot, error => fail(entry, generation, error))
        if (live(entry, generation)) entry.off = off
        else safely(off)
      } else {
        const poll = async (): Promise<void> => {
          if (!live(entry, generation)) return
          const abort = new AbortController()
          entry.abort = abort
          try { snapshot(await source.list(abort.signal)) }
          catch (error) { fail(entry, generation, error) }
          finally {
            if (live(entry, generation)) {
              entry.abort = undefined
              entry.timer = setTimeout(() => { void poll() }, 10_000)
            }
          }
        }
        void poll()
      }
    } catch (error) { fail(entry, generation, error) }
  }
  function reconcile(entry: Entry, registryChange: boolean): void {
    if (!entry.listeners.size || disposed) return
    try {
      const providers = options.getProviders()
      // Once owned, disappearance cannot accidentally authorize a local read.
      const candidates = entry.ownerId === undefined ? providers : providers.filter(p => p.id === entry.ownerId)
      const provider = candidates.find(p => p.match(entry.sessionId, entry.cwd, 'terminal:workspace-management'))
      if (!entry.started || entry.provider !== provider || registryChange && (entry.stopped || entry.failure)) start(entry, provider)
    } catch (error) {
      stop(entry)
      entry.started = false
      fail(entry, entry.generation, error)
    }
  }
  function registryChanged(): void {
    if (disposed) return
    pending = true
    if (reconciling) return
    reconciling = true
    try {
      while (pending) {
        pending = false
        for (const entry of [...entries.values()]) reconcile(entry, true)
      }
    } finally { reconciling = false }
  }
  return {
    registryChanged,
    subscribe(scope: SessionScope, onSummary: Listener['summary'], onError?: Listener['error']): () => void {
      if (disposed) return () => {}
      if (!scope.sessionId) { safely(() => onError?.(new Error('workspace terminal summary requires a session id'))); return () => {} }
      const cwd = scope.cwd ?? options.sessionCwd?.(scope.sessionId)
      // One registry-selected owner per session/cwd. ownerId pins the provider
      // component of this identity once selected; it can never coalesce with a
      // different backend, even while that owner is absent from the registry.
      const key = JSON.stringify([scope.sessionId, cwd ?? null])
      let entry = entries.get(key)
      if (!entry) {
        entry = { sessionId: scope.sessionId, cwd, listeners: new Set(), generation: 0, started: false, stopped: false }
        entries.set(key, entry)
      }
      const listener = { summary: onSummary, error: onError }
      entry.listeners.add(listener)
      if (entry.latest) safely(() => onSummary(entry!.latest!))
      else if (entry.failure) safely(() => onError?.(entry!.failure!.error))
      if (reconciling) pending = true
      else {
        reconciling = true
        try { reconcile(entry, false) }
        finally { reconciling = false }
        if (pending) registryChanged()
      }
      const owned = entry
      return () => {
        if (!owned.listeners.delete(listener)) return
        if (!owned.listeners.size) {
          if (entries.get(key) === owned) entries.delete(key)
          stop(owned)
        }
      }
    },
    dispose(): void {
      disposed = true
      for (const entry of entries.values()) { entry.listeners.clear(); stop(entry) }
      entries.clear()
    },
  }
}
