import type { WorkspaceTerminalInfo } from './api.ts'
import { hostWebSocketUrl } from './host-route-url.ts'

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Reject malformed rows before they reach render-time string/date operations. */
function terminalInfo(value: unknown): value is WorkspaceTerminalInfo {
  if (!record(value)) return false
  if (!['terminalId', 'title', 'cwd', 'createdBySessionId'].every(key => typeof value[key] === 'string')
    || !finite(value.createdAt) || typeof value.exited !== 'boolean') return false
  if (value.activity !== undefined && (typeof value.activity !== 'string' || !['idle', 'busy', 'unknown', 'exited'].includes(value.activity))) return false
  if (value.activityReason !== undefined && typeof value.activityReason !== 'string') return false
  if (value.pinned !== undefined && typeof value.pinned !== 'boolean') return false
  if (value.runningCommands !== undefined && (!Array.isArray(value.runningCommands) || !value.runningCommands.every(command => typeof command === 'string'))) return false
  if (value.exitCode !== undefined && value.exitCode !== null && !finite(value.exitCode)) return false
  return ['attachedViews', 'lastInputAt', 'lastOutputAt', 'lastDetachedAt', 'exitedAt',
    'commandStartedAt', 'commandFinishedAt', 'commandExitCode', 'commandDurationMs']
    .every(key => value[key] === undefined || finite(value[key]))
}

/** One active catalog subscription. Each new connection supplies a fresh full
 * snapshot and revision baseline; revisions are never compared across sockets. */
export function watchWorkspaceTerminals(
  sessionId: string,
  onSnapshot: (snapshot: { terminals: WorkspaceTerminalInfo[] }) => void,
  onError?: (error: unknown) => void,
): () => void {
  let disposed = false
  let stopped = false
  let socket: WebSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  const fail = (message: string, policy = false) => {
    if (disposed || stopped) return
    stopped = true
    onError?.(Object.assign(new Error(message), { code: policy ? 'FORBIDDEN' : 'TERMINAL_SUBSCRIPTION_ERROR', ...(policy ? { status: 403 } : {}), retryable: false }))
  }
  const retry = () => {
    if (disposed || stopped) return
    timer = setTimeout(connect, Math.min(1000 * 2 ** Math.min(failures++, 4), 15_000))
  }
  const connect = () => {
    if (disposed || stopped) return
    let current: WebSocket
    try {
      const url = hostWebSocketUrl('sidebar/ws/workspace-terminals')
      url.search = new URLSearchParams({ sessionId }).toString()
      current = new WebSocket(url.toString())
    } catch (error) {
      onError?.(error)
      retry()
      return
    }
    socket = current
    let revision = -1
    const live = () => !disposed && !stopped && socket === current
    current.onopen = () => {
      // Some browsers reject close during CONNECTING. Retain this handler so
      // even a late successful handshake after unsubscribe is immediately closed.
      if (!live()) current.close()
    }
    current.onmessage = event => {
      if (!live() || typeof event.data !== 'string') return
      let frame: unknown
      try { frame = JSON.parse(event.data) } catch { return }
      if (!record(frame)) return
      if (typeof frame.error === 'string' || (record(frame.error) && typeof frame.error.message === 'string')) {
        fail(typeof frame.error === 'string' ? frame.error : String((frame.error as Record<string, unknown>).message))
        current.close()
        return
      }
      if (!Number.isSafeInteger(frame.revision) || (frame.revision as number) < 0
        || (frame.revision as number) <= revision || !Array.isArray(frame.terminals) || !frame.terminals.every(terminalInfo)) return
      revision = frame.revision as number
      failures = 0 // Only a valid resync proves recovery, not an open-close loop.
      onSnapshot({ terminals: frame.terminals })
    }
    current.onclose = event => {
      if (!live()) return
      socket = undefined
      if (event.code === 1008 || (event.code >= 4000 && event.code < 5000)) {
        fail(event.reason || `Workspace terminal subscription refused (${event.code})`, true)
        return
      }
      onError?.(Object.assign(new Error(event.reason || `Workspace terminal subscription disconnected (${event.code}); reconnecting`), { code: 'TERMINAL_SUBSCRIPTION_DISCONNECTED', retryable: true, closeCode: event.code }))
      retry()
    }
    // Browsers report network errors via close; scheduling here would double retry.
    current.onerror = () => {}
  }
  connect()
  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    if (socket !== undefined && socket.readyState !== WebSocket.CONNECTING) socket.close()
  }
}
