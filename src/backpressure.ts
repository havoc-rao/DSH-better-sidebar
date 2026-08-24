/**
 * Terminal output backpressure for the sidebar WebSockets.
 *
 * Concept ported from tabby-terminal's FlowControl (MIT, Copyright (c) 2017
 * Tabby Developers): slow consumers must PAUSE the producer, never silently
 * drop output. tabby counts xterm write callbacks against high/low
 * watermarks; here the same accounting rides the WebSocket send callback —
 * every output chunk is counted as in-flight bytes until `ws.send`'s
 * callback confirms the frame was flushed to the socket.
 *
 * Semantics:
 * - Total in-flight bytes across a pty's sockets crossing the high watermark
 *   → the pty is paused via node-pty's `pause()` (one slow client pauses the
 *   whole terminal; the 1MB watermark leaves plenty of headroom, and a
 *   shared terminal would rather stall than lose output).
 * - In-flight bytes falling back below the low watermark (ws send callbacks
 *   firing as the frames flush) → `resume()`.
 * - The pty is reference-counted by socket lifecycle: the last detach
 *   resumes it, so a controller abandoned mid-pause can never leak a frozen
 *   terminal.
 * - A hard ceiling remains as a last-resort drop for pathological cases
 *   where pause/resume is unavailable (e.g. an exotic Windows ConPTY build):
 *   frames that would push a socket past the ceiling are rejected (the
 *   caller logs once), keeping the old bounded-memory guarantee instead of
 *   growing without limit.
 */
import type { WebSocket } from 'ws'

/** Crossing this total in-flight byte count pauses the pty. */
export const BACKPRESSURE_HIGH_WATERMARK = 1 << 20

/** Falling back below this count resumes the pty (hysteresis). */
export const BACKPRESSURE_LOW_WATERMARK = 256 << 10

/** Frames that would push a socket past this count are dropped. */
export const BACKPRESSURE_HARD_CEILING = 8 << 20

export interface PtyBackpressure {
  /** Register a socket (call before its output flow starts). */
  attach(ws: WebSocket): void
  /** Unregister a socket (ws 'close'/'error'); resumes the pty on the last detach. */
  detach(ws: WebSocket): void
  /**
   * Send one output chunk with in-flight accounting. Returns false when the
   * send would push the socket past the hard ceiling (the frame was NOT
   * sent — the caller should drop it and log once); true otherwise.
   */
  send(ws: WebSocket, data: string): boolean
}

/**
 * Create one backpressure controller per pty. `pause`/`resume` are the pty
 * control callbacks (injected so tests can drive the state machine without
 * a real pty).
 */
export function createPtyBackpressure(
  pause: () => void,
  resume: () => void,
  highWatermark: number = BACKPRESSURE_HIGH_WATERMARK,
  lowWatermark: number = BACKPRESSURE_LOW_WATERMARK,
): PtyBackpressure {
  /** In-flight bytes per socket (frames flushed by the ws send callback). */
  const pending = new Map<WebSocket, number>()
  const attached = new Set<WebSocket>()
  let paused = false

  const totalPending = (): number => {
    let sum = 0
    for (const bytes of pending.values()) sum += bytes
    return sum
  }
  const maybePause = (): void => {
    if (!paused && totalPending() > highWatermark) {
      paused = true
      pause()
    }
  }
  const maybeResume = (): void => {
    if (paused && totalPending() < lowWatermark) {
      paused = false
      resume()
    }
  }

  return {
    attach(ws) {
      attached.add(ws)
    },
    detach(ws) {
      attached.delete(ws)
      pending.delete(ws)
      // A dead socket must never hold the pause; the last detach restores the
      // pty to its flowing state so a future attach does not inherit a
      // frozen terminal.
      if (attached.size === 0) {
        if (paused) {
          paused = false
          resume()
        }
      } else {
        maybeResume()
      }
    },
    send(ws, data) {
      const bytes = Buffer.byteLength(data)
      const next = (pending.get(ws) ?? 0) + bytes
      if (next > BACKPRESSURE_HARD_CEILING) return false
      pending.set(ws, next)
      ws.send(data, () => {
        const now = (pending.get(ws) ?? 0) - bytes
        if (now <= 0) pending.delete(ws)
        else pending.set(ws, now)
        maybeResume()
      })
      maybePause()
      return true
    },
  }
}
