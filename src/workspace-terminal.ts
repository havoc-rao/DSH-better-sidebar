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

export interface WorkspaceTerminalInfo {
  terminalId: string
  title: string
  cwd: string
  createdBySessionId: string
  createdAt: number
  exited: boolean
  exitCode?: number | null
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
}
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
  constructor(
    private readonly shell: string,
    private readonly nodePty: NodePtyModule,
    private readonly maxPerWorkspace = 3,
    private readonly maxGlobal = 64,
    private readonly outputLimit = OUTPUT_LIMIT,
  ) {}

  create(workspace: LocalTerminalWorkspace, sessionId: string, title?: string, shell = this.shell, args: string[] = []): WorkspaceTerminalInfo {
    const live = [...this.terminals.values()].filter(handle => !handle.info.exited)
    // Also cap retained records: exited transcripts must not become an unbounded memory registry.
    if (live.filter(handle => handle.workspaceKey === workspace.key).length >= this.maxPerWorkspace
      || live.length >= this.maxGlobal || this.terminals.size >= this.maxGlobal * 4
      || [...this.terminals.values()].filter(h => h.workspaceKey === workspace.key).length >= this.maxPerWorkspace * 4) {
      throw new SidebarError('pty-error', 'workspace or global terminal limit reached', 400)
    }
    const executable = resolveShellExecutable(shell)
    const pty = this.nodePty.spawn(executable, shellSpawnArgs(args), {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: workspace.cwd, env: { ...process.env },
    })
    armPtyResizeGate(pty)
    const info: WorkspaceTerminalInfo = {
      terminalId: `terminal:${randomUUID()}`, title: title ?? shellDisplayName(shell), cwd: workspace.cwd,
      createdBySessionId: sessionId, createdAt: Date.now(), exited: false,
    }
    const handle: Handle = { info, workspaceKey: workspace.key, pty, output: Buffer.alloc(0), cursor: 0, sockets: new Set(), disposers: [] }
    this.terminals.set(info.terminalId, handle)
    handle.disposers.push(pty.onData(data => { this.append(handle, data) }))
    handle.disposers.push(pty.onExit(({ exitCode }) => {
      info.exited = true
      info.exitCode = exitCode
      this.append(handle, `\r\n[process exited with code ${exitCode}]\r\n`)
      for (const socket of handle.sockets) socket.close(1000, 'terminal-exited')
    }))
    return { ...info }
  }

  list(workspace: LocalTerminalWorkspace): WorkspaceTerminalInfo[] {
    return [...this.terminals.values()].filter(h => h.workspaceKey === workspace.key).map(h => ({ ...h.info }))
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
    const detach = (): void => { handle.sockets.delete(ws) }
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
      } else { handle.pty.write(text) }
    })
  }

  private append(handle: Handle, data: string): void {
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
    for (const [id, handle] of this.terminals) this.terminate({ key: handle.workspaceKey, cwd: handle.info.cwd }, id)
  }
}

export function buildWorkspaceTerminalApi(ctx: Context, manager: WorkspaceTerminalManager | null,
  overrides: () => { shell?: string; shellArgs?: string[] } = () => ({})) {
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
      return manager.create(workspace, sessionId, raw as string | undefined, config.shell, config.shellArgs)
    },
    'workspace-terminal.list': async (payload: unknown) => {
      const { workspace } = await workspaceOf(payload)
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
