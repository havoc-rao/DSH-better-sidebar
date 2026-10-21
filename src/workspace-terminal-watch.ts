/** Workspace catalog push is metadata-only: observing never attaches a PTY view. */
import { WebSocket } from 'ws'
import type { Context } from './context-types.ts'
import { resolveTerminalWorkspace, type WorkspaceTerminalManager } from './workspace-terminal.ts'
import { SidebarError } from './wire.ts'

export async function attachWorkspaceTerminalWatch(
  ctx: Context, manager: WorkspaceTerminalManager | null, ws: WebSocket,
  requestUrl: string,
): Promise<void> {
  let disposed = false
  let unsubscribe: (() => void) | undefined
  const dispose = () => { disposed = true; unsubscribe?.(); unsubscribe = undefined }
  ws.on('close', dispose)
  ws.on('error', dispose)
  try {
    const sessionId = new URL(requestUrl, 'http://dsh.internal').searchParams.get('sessionId')
    if (!sessionId) { ws.close(1008, 'sessionId is required'); return }
    // Same authoritative local workspace lookup as the management API. No cwd
    // supplied by the browser is accepted; never share another workspace's rows.
    const workspace = await resolveTerminalWorkspace(ctx, sessionId)
    if (disposed || ws.readyState !== WebSocket.OPEN) return
    if (!manager) { ws.send(JSON.stringify({ revision: 0, terminals: [] })); return }
    const off = manager.subscribe(workspace, snapshot => {
      if (disposed || ws.readyState !== WebSocket.OPEN) return
      // A slow observer must reconnect for a full snapshot, not accumulate an
      // unbounded queue or silently miss the final state of a terminal.
      if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, 'workspace-terminal-watch-backpressure'); return }
      ws.send(JSON.stringify(snapshot))
    })
    if (disposed) off()
    else unsubscribe = off
  } catch (error) {
    dispose()
    if (ws.readyState === WebSocket.OPEN) {
      const policy = error instanceof SidebarError && error.status < 500
      ws.close(policy ? 1008 : 1011, 'workspace-terminal-watch-unavailable')
    }
  }
}
