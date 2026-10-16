/** Workspace-local UI terminals. Deliberately separate from session/tab legacy PTYs. */
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { IPty } from 'node-pty'
import { WebSocket } from 'ws'
import type { Context } from './context-types.ts'
import type { NodePtyModule } from './pty-deps.ts'
import { resolveShellExecutable, shellDisplayName, shellSpawnArgs } from './pty-manager.ts'
import { armPtyResizeGate, tryResizePty } from './agent-pty.ts'
import { requireString, SidebarError } from './wire.ts'
import { probeTerminalActivity, type TerminalActivityResult } from './terminal-activity.ts'
import { prepareZshIntegration, ZshMarkerParser, type ZshIntegration } from './zsh-integration.ts'

export interface WorkspaceTerminalInfo {
  terminalId: string
  title: string
  cwd: string
  createdBySessionId: string
  createdAt: number
  exited: boolean
  exitCode?: number | null
  activity?: 'idle' | 'busy' | 'unknown' | 'exited'
  activityReason?: string
  /** Unique safe executable basenames observed in the foreground process group. */
  runningCommands?: readonly string[]
  attachedViews?: number
  lastInputAt?: number
  lastOutputAt?: number
  lastDetachedAt?: number
  exitedAt?: number
  pinned?: boolean
}
export interface LocalTerminalWorkspace { key: string; cwd: string }
interface Handle {
  info: WorkspaceTerminalInfo
  workspaceKey: string
  pty: IPty
  output: Buffer
  cursor: number
  sockets: Set<WebSocket>
  disposers: Array<{ dispose(): void }>
  revision: number
  probeGeneration?: number
  idleSince?: number
  reservedBy?: string
  acquiredAt?: number
  integration?: ZshIntegration
  parser?: ZshMarkerParser
  promptAt?: number
  integrationReason?: string
}
export interface WorkspaceTerminalLifecycleOptions {
  now?: () => number
  probe?: (pid: number, promptProven?: boolean) => Promise<TerminalActivityResult>
}
const EXIT_RETENTION = 10 * 60_000
const IDLE_RETENTION = 30 * 60_000
const DETACH_GRACE = 2 * 60_000
const SERVER_NAMESPACE = `server-local:${randomUUID()}`
const OUTPUT_LIMIT = 1 << 20

/** Authoritative local session header only; never accepts browser cwd or process cwd.
 * Public workspaceRegistry.list() supplies stable ids when available. Its local
 * canonical paths are matched, not remote gateway/provider workspace ids.
 */
export async function resolveTerminalWorkspace(ctx: Context, sessionId: string): Promise<LocalTerminalWorkspace> {
  let header: { cwd?: string } | undefined = ctx.sessions.get(sessionId)?.header
  if (header === undefined || !header.cwd) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      const handle = await persistence.open(sessionId, 'read')
      try { header = handle.header } finally { await handle.close() }
    }
  }
  if (!header?.cwd || !isAbsolute(header.cwd)) {
    throw new SidebarError('bad-request', 'session has no authoritative local workspace cwd', 400)
  }
  let cwd: string
  try {
    cwd = await realpath(header.cwd)
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new SidebarError('bad-request', 'session workspace directory is unavailable', 400)
  }
  // Structural read avoids adding a runtime/peer dependency on dsh-workspace.
  const registry = ctx.get('workspaceRegistry') as unknown as {
    list(): Array<{ id: string; path: string; sessionIds?: readonly string[] }>
  } | undefined
  const entries = registry?.list() ?? []
  const workspace = entries.find(entry => entry.path === cwd && entry.sessionIds?.includes(sessionId))
    ?? entries.find(entry => entry.path === cwd)
  return { cwd, key: `${SERVER_NAMESPACE}:${workspace ? `host:${workspace.id}` : `root:${cwd}`}` }
}

export class WorkspaceTerminalManager {
  private readonly terminals = new Map<string, Handle>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly now: () => number
  private readonly probe: (pid: number, promptProven?: boolean) => Promise<TerminalActivityResult>
  private disposed = false
  private sweeping?: Promise<number>

  private async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(run)
    this.locks.set(key, next)
    try { return await next } finally { if (this.locks.get(key) === next) this.locks.delete(key) }
  }
  constructor(
    private readonly shell: string,
    private readonly nodePty: NodePtyModule,
    private readonly maxPerWorkspace = 3,
    private readonly maxGlobal = 64,
    private readonly outputLimit = OUTPUT_LIMIT,
    options: WorkspaceTerminalLifecycleOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.probe = options.probe ?? probeTerminalActivity
  }

  create(workspace: LocalTerminalWorkspace, sessionId: string, title?: string, shell = this.shell, args: string[] = [], shellIntegration = false): WorkspaceTerminalInfo {
    if (this.disposed) throw new SidebarError('pty-error', 'terminal-manager-disposed', 503)
    // Synchronous create remains compatible; expired exited records need no process probe.
    this.pruneExited()
    const live = [...this.terminals.values()].filter(handle => !handle.info.exited)
    if (live.filter(handle => handle.workspaceKey === workspace.key).length >= this.maxPerWorkspace) {
      throw new SidebarError('pty-error', 'terminal-workspace-live-limit: workspace live process limit reached; manage workspace terminals', 400)
    }
    if (live.length >= this.maxGlobal) {
      throw new SidebarError('pty-error', 'terminal-global-live-limit: global live process limit reached; manage workspace terminals', 400)
    }
    if ([...this.terminals.values()].filter(h => h.workspaceKey === workspace.key).length >= this.maxPerWorkspace * 4) {
      throw new SidebarError('pty-error', 'terminal-workspace-history-limit: workspace retained record limit reached; manage workspace terminals', 400)
    }
    if (this.terminals.size >= this.maxGlobal * 4) {
      throw new SidebarError('pty-error', 'terminal-global-history-limit: global retained record limit reached; manage workspace terminals', 400)
    }
    const executable = resolveShellExecutable(shell)
    let integration: ZshIntegration | undefined
    let integrationReason: string | undefined
    if (shellIntegration) {
      try {
        integration = prepareZshIntegration(executable, args)
        if (!integration) integrationReason = 'shell-integration-unsupported'
      } catch { integrationReason = 'shell-integration-setup-failed' }
    }
    let pty: IPty
    try {
      pty = this.nodePty.spawn(executable, integration ? ['-i'] : shellSpawnArgs(args), {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: workspace.cwd, env: integration?.env ?? { ...process.env },
      })
    } catch (error) { integration?.dispose(); throw error }
    armPtyResizeGate(pty)
    const info: WorkspaceTerminalInfo = {
      terminalId: `terminal:${randomUUID()}`, title: title ?? shellDisplayName(shell), cwd: workspace.cwd,
      createdBySessionId: sessionId, createdAt: this.now(), exited: false,
      activity: 'unknown', activityReason: integrationReason ?? (integration ? 'shell-integration-awaiting-prompt' : 'not-yet-probed'), attachedViews: 0, pinned: false,
    }
    const handle: Handle = { info, workspaceKey: workspace.key, pty, output: Buffer.alloc(0), cursor: 0, sockets: new Set(), disposers: [], revision: 0,
      integration, integrationReason, parser: integration ? new ZshMarkerParser(integration.token) : undefined }
    this.terminals.set(info.terminalId, handle)
    handle.disposers.push(pty.onData(data => {
      if (!handle.parser) { this.append(handle, data); return }
      // Even an incomplete marker prefix invalidates earlier proof immediately.
      handle.revision++
      handle.idleSince = undefined
      handle.promptAt = undefined
      delete info.runningCommands
      info.activity = 'unknown'
      info.activityReason = 'output-since-probe'
      handle.parser.feed(data, text => this.append(handle, text), kind => {
        handle.revision++
        handle.idleSince = undefined
        if (kind === 'unsupported') handle.integrationReason = 'shell-integration-unsupported-hooks'
        handle.promptAt = kind === 'prompt' && !handle.integrationReason ? this.now() : undefined
        delete info.runningCommands
        info.activity = 'unknown'
        info.activityReason = handle.integrationReason ?? (kind === 'prompt' ? 'shell-prompt-awaiting-process-check' : 'shell-command-started')
      })
    }))
    handle.disposers.push(pty.onExit(({ exitCode }) => {
      handle.revision++
      handle.idleSince = undefined
      info.exited = true
      info.exitedAt = this.now()
      delete info.runningCommands
      info.activity = 'exited'
      info.activityReason = 'process-exited'
      info.exitCode = exitCode
      integration?.dispose()
      this.append(handle, `\r\n[process exited with code ${exitCode}]\r\n`)
      for (const socket of handle.sockets) socket.close(1000, 'terminal-exited')
    }))
    return { ...info }
  }

  list(workspace: LocalTerminalWorkspace): WorkspaceTerminalInfo[] {
    return [...this.terminals.values()].filter(h => h.workspaceKey === workspace.key).map(h => ({ ...h.info }))
  }

  /** Default opening attaches an existing live shell, even when busy or shared.
   * This never sends input or restarts it; only an empty workspace creates one. */
  async ensure(workspace: LocalTerminalWorkspace, sessionId: string, shell = this.shell, args: string[] = [], shellIntegration = false): Promise<WorkspaceTerminalInfo> {
    return this.serial(workspace.key, async () => {
      if (this.disposed) throw new SidebarError('pty-error', 'terminal-manager-disposed', 503)
      const handles = () => [...this.terminals.values()].filter(h => h.workspaceKey === workspace.key && !h.info.exited)
      const live = handles()
      const existing = live.find(h => h.reservedBy === sessionId)
        ?? live.find(h => h.info.createdBySessionId === sessionId)
        ?? live[0]
      if (existing) {
        existing.reservedBy ??= sessionId
        existing.revision++; existing.idleSince = undefined; existing.acquiredAt = this.now()
        return { ...existing.info }
      }
      await this.sweep(workspace)
      const info = this.create(workspace, sessionId, undefined, shell, args, shellIntegration)
      this.terminals.get(info.terminalId)!.reservedBy = sessionId
      return info
    })
  }

  pin(workspace: LocalTerminalWorkspace, terminalId: string, pinned: boolean): WorkspaceTerminalInfo {
    const handle = this.expect(workspace, terminalId)
    handle.info.pinned = pinned
    handle.revision++
    return { ...handle.info }
  }

  private protected(handle: Handle): boolean {
    return !!handle.info.pinned || handle.sockets.size > 0
      || handle.acquiredAt !== undefined && this.now() - handle.acquiredAt < DETACH_GRACE
      || this.now() - (handle.info.lastDetachedAt ?? handle.info.createdAt) < DETACH_GRACE
  }

  private pruneExited(workspace?: LocalTerminalWorkspace): number {
    let removed = 0
    for (const handle of this.terminals.values()) {
      if (workspace && workspace.key !== handle.workspaceKey) continue
      if (handle.info.exited && !this.protected(handle)
        && this.now() - (handle.info.exitedAt ?? this.now()) >= EXIT_RETENTION) {
        this.terminate({ key: handle.workspaceKey, cwd: handle.info.cwd }, handle.info.terminalId); removed++
      }
    }
    return removed
  }

  private async refresh(handle: Handle): Promise<boolean> {
    if (this.disposed || handle.info.exited) return false
    const revision = handle.revision
    const generation = (handle.probeGeneration ?? 0) + 1
    handle.probeGeneration = generation
    const promptProven = !!handle.integration && handle.promptAt !== undefined && this.now() - handle.promptAt >= 2000
    let result: TerminalActivityResult
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      result = await Promise.race([this.probe(handle.pty.pid, promptProven), new Promise<TerminalActivityResult>(resolve => {
        timer = setTimeout(() => resolve({ activity: 'unknown', reason: 'process-probe-timeout' }), 2000)
      })])
    } catch { result = { activity: 'unknown', reason: 'process-probe-failed' } }
    finally { if (timer !== undefined) clearTimeout(timer) }
    if (this.disposed || this.terminals.get(handle.info.terminalId) !== handle || handle.revision !== revision
      || handle.probeGeneration !== generation || handle.info.exited) return false
    if (result.activity === 'idle' && handle.integration && !promptProven) {
      result = { activity: 'unknown', reason: 'shell-prompt-not-proven' }
    }
    if (result.activity === 'unknown' && handle.integrationReason) result.reason = handle.integrationReason
    else if (result.activity === 'unknown' && handle.integration && !promptProven
      && result.reason !== 'process-probe-failed' && result.reason !== 'process-probe-timeout') {
      result.reason = handle.promptAt === undefined ? 'shell-integration-prompt-missing' : 'shell-prompt-settling'
    }
    if (result.activity === 'busy' && result.runningCommands?.length) handle.info.runningCommands = [...result.runningCommands]
    else delete handle.info.runningCommands
    handle.info.activity = result.activity
    handle.info.activityReason = result.reason
    if (result.activity === 'idle') handle.idleSince ??= this.now()
    else handle.idleSince = undefined
    return true
  }

  /** Explicit cleanup uses the same conservative retention policy as periodic sweep. */
  async cleanup(workspace: LocalTerminalWorkspace): Promise<{ removed: number }> {
    return { removed: await this.sweep(workspace) }
  }

  async sweep(workspace?: LocalTerminalWorkspace): Promise<number> {
    while (this.sweeping) { await this.sweeping; if (!workspace) return 0 }
    if (this.disposed) return 0
    const run = this.sweepNow(workspace)
    this.sweeping = run
    try { return await run } finally { if (this.sweeping === run) this.sweeping = undefined }
  }

  private async sweepNow(workspace?: LocalTerminalWorkspace): Promise<number> {
    let removed = this.pruneExited(workspace)
    for (const handle of [...this.terminals.values()]) {
      if (this.disposed) break
      if (workspace && handle.workspaceKey !== workspace.key || handle.info.exited) continue
      // Probe even protected handles to expose activity, but never reclaim them.
      if (!await this.refresh(handle)) continue
      if (this.protected(handle) || handle.idleSince === undefined
        || this.now() - handle.idleSince < IDLE_RETENTION || handle.info.activity !== 'idle') continue
      const revision = handle.revision
      const refreshed = await this.refresh(handle) // fresh proof immediately before removal
      if (!refreshed || this.disposed || this.terminals.get(handle.info.terminalId) !== handle || handle.revision !== revision
        || this.protected(handle) || handle.info.exited || handle.info.activity !== 'idle'
        || handle.idleSince === undefined || this.now() - handle.idleSince < IDLE_RETENTION) continue
      this.terminate({ key: handle.workspaceKey, cwd: handle.info.cwd }, handle.info.terminalId); removed++
    }
    return removed
  }

  private expect(workspace: LocalTerminalWorkspace, terminalId: string): Handle {
    const handle = this.terminals.get(terminalId)
    if (!handle) throw new SidebarError('not-found', 'terminal-not-found', 404)
    if (handle.workspaceKey !== workspace.key) throw new SidebarError('forbidden', 'workspace-mismatch', 403)
    return handle
  }

  terminate(workspace: LocalTerminalWorkspace, terminalId: string): void {
    const handle = this.expect(workspace, terminalId)
    this.terminals.delete(terminalId) // stale attachments lose write access before kill callbacks
    for (const socket of handle.sockets) socket.close(1000, 'terminal-terminated')
    handle.sockets.clear()
    for (const disposable of handle.disposers) disposable.dispose()
    if (!handle.info.exited) { try { handle.pty.kill() } catch { /* already gone */ } }
    handle.integration?.dispose()
  }

  /** Non-consuming byte cursor for future Agent readers; bounded replay reports gaps. */
  readOutput(workspace: LocalTerminalWorkspace, terminalId: string, afterCursor = 0): {
    data: string; cursor: number; startCursor: number; truncated: boolean
  } {
    const handle = this.expect(workspace, terminalId)
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0 || afterCursor > handle.cursor) {
      throw new SidebarError('bad-request', 'invalid output cursor', 400)
    }
    const startCursor = handle.cursor - handle.output.length
    return { data: handle.output.subarray(Math.max(0, afterCursor - startCursor)).toString('utf8'),
      cursor: handle.cursor, startCursor, truncated: afterCursor < startCursor }
  }

  attach(workspace: LocalTerminalWorkspace, terminalId: string, ws: WebSocket): void {
    const handle = this.expect(workspace, terminalId)
    if (ws.readyState !== WebSocket.OPEN) return
    if (handle.output.length) ws.send(handle.output.toString('utf8'))
    if (handle.info.exited) { ws.close(1000, 'terminal-exited'); return }
    handle.sockets.add(ws)
    handle.revision++
    handle.info.attachedViews = handle.sockets.size
    const detach = (): void => {
      if (!handle.sockets.delete(ws)) return
      handle.revision++
      handle.info.attachedViews = handle.sockets.size
      if (!handle.sockets.size) handle.info.lastDetachedAt = this.now()
    }
    ws.on('close', detach)
    ws.on('error', detach)
    ws.on('message', data => {
      if (this.terminals.get(terminalId) !== handle || handle.info.exited || !handle.sockets.has(ws)) return
      const text = data.toString()
      let frame: { type?: unknown; cols?: unknown; rows?: unknown } | undefined
      try { frame = JSON.parse(text) as typeof frame } catch { /* raw input */ }
      // These are view lifecycle controls, NEVER process lifecycle controls.
      if (frame?.type === 'close' || frame?.type === 'park') { detach(); ws.close(1000, 'terminal-detached'); return }
      if (frame?.type === 'resize' && typeof frame.cols === 'number' && typeof frame.rows === 'number') {
        tryResizePty(handle.pty, frame.cols, frame.rows)
      } else {
        handle.revision++
        handle.idleSince = undefined
        handle.promptAt = undefined
        handle.info.lastInputAt = this.now()
        delete handle.info.runningCommands
        handle.info.activity = 'unknown'
        handle.info.activityReason = 'input-since-probe'
        handle.pty.write(text)
      }
    })
  }

  private append(handle: Handle, data: string): void {
    handle.revision++
    handle.idleSince = undefined
    handle.promptAt = undefined
    handle.info.lastOutputAt = this.now()
    if (!handle.info.exited) {
      delete handle.info.runningCommands
      handle.info.activity = 'unknown'
      handle.info.activityReason = 'output-since-probe'
    }
    const bytes = Buffer.from(data)
    handle.cursor += bytes.length
    handle.output = Buffer.concat([handle.output, bytes])
    if (handle.output.length > this.outputLimit) {
      let start = handle.output.length - this.outputLimit
      // Do not begin replay in the middle of a UTF-8 code point.
      while (start < handle.output.length && (handle.output[start]! & 0xc0) === 0x80) start++
      handle.output = Buffer.from(handle.output.subarray(start))
    }
    for (const socket of handle.sockets) {
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 4 * 1024 * 1024) socket.send(data)
    }
  }

  disposeAll(): void {
    this.disposed = true
    for (const [id, handle] of this.terminals) this.terminate({ key: handle.workspaceKey, cwd: handle.info.cwd }, id)
  }
}

export function buildWorkspaceTerminalApi(ctx: Context, manager: WorkspaceTerminalManager | null,
  overrides: () => { shell?: string; shellArgs?: string[]; shellIntegration?: boolean } = () => ({})) {
  const workspaceOf = async (payload: unknown) => {
    const sessionId = requireString(payload, 'sessionId')
    return { sessionId, workspace: await resolveTerminalWorkspace(ctx, sessionId) }
  }
  return {
    'workspace-terminal.create': async (payload: unknown) => {
      const { sessionId, workspace } = await workspaceOf(payload)
      if (!manager) throw new SidebarError('pty-error', 'pty-deps-missing', 503)
      const raw = (payload as { title?: unknown }).title
      if (raw !== undefined && (typeof raw !== 'string' || raw.length > 256)) {
        throw new SidebarError('bad-request', 'title must be a string of at most 256 characters', 400)
      }
      const config = overrides()
      await manager.sweep(workspace)
      return manager.create(workspace, sessionId, raw as string | undefined, config.shell, config.shellArgs, config.shellIntegration)
    },
    'workspace-terminal.ensure': async (payload: unknown) => {
      const { sessionId, workspace } = await workspaceOf(payload)
      if (!manager) throw new SidebarError('pty-error', 'pty-deps-missing', 503)
      const config = overrides()
      return manager.ensure(workspace, sessionId, config.shell, config.shellArgs, config.shellIntegration)
    },
    'workspace-terminal.pin': async (payload: unknown) => {
      const { workspace } = await workspaceOf(payload)
      const id = requireString(payload, 'terminalId')
      const pinned = (payload as { pinned?: unknown }).pinned
      if (typeof pinned !== 'boolean') throw new SidebarError('bad-request', 'pinned must be a boolean', 400)
      if (!manager) throw new SidebarError('not-found', 'terminal-not-found', 404)
      manager.pin(workspace, id, pinned)
      return { ok: true as const }
    },
    'workspace-terminal.cleanup': async (payload: unknown) => {
      const { workspace } = await workspaceOf(payload)
      return manager ? manager.cleanup(workspace) : { removed: 0 }
    },
    'workspace-terminal.list': async (payload: unknown) => {
      const { workspace } = await workspaceOf(payload)
      // Sweeping refreshes activity without changing the synchronous manager.list contract.
      await manager?.sweep(workspace)
      return { terminals: manager?.list(workspace) ?? [] }
    },
    'workspace-terminal.terminate': async (payload: unknown) => {
      const { workspace } = await workspaceOf(payload)
      const id = requireString(payload, 'terminalId')
      if (!manager) throw new SidebarError('not-found', 'terminal-not-found', 404)
      manager.terminate(workspace, id)
      return { ok: true as const }
    },
  }
}
