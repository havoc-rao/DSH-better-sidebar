/**
 * Output backpressure tests: the per-pty pause/resume state machine that
 * keeps a slow WebSocket consumer from ever losing terminal output (ported
 * concept from tabby-terminal's FlowControl — pause, never drop). In-flight
 * bytes are counted through the ws send callback; tests drive flushing by
 * invoking the captured callbacks.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import {
  BACKPRESSURE_HARD_CEILING,
  BACKPRESSURE_HIGH_WATERMARK,
  createPtyBackpressure,
} from '../src/backpressure.ts'

/** A minimal ws-shaped stub: send() records the flush callback. */
function stubSocket(): WebSocket & { flush: () => void; sent: string[] } {
  const callbacks: Array<() => void> = []
  const sent: string[] = []
  const ws = {
    bufferedAmount: 0,
    send: (data: string, cb?: (err?: Error) => void) => {
      sent.push(data)
      if (cb) callbacks.push(cb)
    },
    flush: () => {
      const cb = callbacks.shift()
      cb?.()
    },
    sent,
  }
  return ws as unknown as WebSocket & { flush: () => void; sent: string[] }
}

describe('createPtyBackpressure', () => {
  it('does not pause below the high watermark', () => {
    const pause = vi.fn()
    const resume = vi.fn()
    const bp = createPtyBackpressure(pause, resume)
    const ws = stubSocket()
    bp.attach(ws)
    bp.send(ws, 'a'.repeat(BACKPRESSURE_HIGH_WATERMARK - 1024))
    expect(pause).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('pauses once when in-flight bytes cross the high watermark', () => {
    const pause = vi.fn()
    const resume = vi.fn()
    const bp = createPtyBackpressure(pause, resume)
    const ws = stubSocket()
    bp.attach(ws)
    bp.send(ws, 'a'.repeat(BACKPRESSURE_HIGH_WATERMARK - 512))
    expect(pause).not.toHaveBeenCalled()
    bp.send(ws, 'a'.repeat(1024)) // crosses the 1MB watermark
    expect(pause).toHaveBeenCalledTimes(1)
    bp.send(ws, 'a'.repeat(16)) // still pending: no second pause
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('resumes only when in-flight bytes fall below the low watermark', () => {
    const pause = vi.fn()
    const resume = vi.fn()
    const bp = createPtyBackpressure(pause, resume)
    const ws = stubSocket()
    bp.attach(ws)
    bp.send(ws, 'a'.repeat(BACKPRESSURE_HIGH_WATERMARK + 1))
    expect(pause).toHaveBeenCalledTimes(1)
    // Flush everything: below the low watermark → exactly one resume.
    ws.flush()
    expect(resume).toHaveBeenCalledTimes(1)
    // A fresh overload cycles the state machine again.
    bp.send(ws, 'a'.repeat(BACKPRESSURE_HIGH_WATERMARK + 1))
    expect(pause).toHaveBeenCalledTimes(2)
    ws.flush()
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it('keeps the pause while any socket is still backed up', () => {
    const pause = vi.fn()
    const resume = vi.fn()
    const bp = createPtyBackpressure(pause, resume)
    const a = stubSocket()
    const b = stubSocket()
    bp.attach(a)
    bp.attach(b)
    bp.send(a, 'a'.repeat(700 * 1024))
    bp.send(b, 'b'.repeat(700 * 1024)) // total 1.4MB → pause
    expect(pause).toHaveBeenCalledTimes(1)
    a.flush() // total 700KB — still above the 256KB low watermark
    expect(resume).not.toHaveBeenCalled()
    b.flush() // total 0 → resume
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('the last detach resumes the pty even when bytes never flushed', () => {
    const pause = vi.fn()
    const resume = vi.fn()
    const bp = createPtyBackpressure(pause, resume)
    const ws = stubSocket()
    bp.attach(ws)
    bp.send(ws, 'a'.repeat(BACKPRESSURE_HIGH_WATERMARK + 1))
    expect(pause).toHaveBeenCalledTimes(1)
    bp.detach(ws)
    expect(resume).toHaveBeenCalledTimes(1)
    bp.detach(ws) // idempotent
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('detaching a quiet socket while another is backed up keeps the pause', () => {
    const pause = vi.fn()
    const resume = vi.fn()
    const bp = createPtyBackpressure(pause, resume)
    const blocked = stubSocket()
    const quiet = stubSocket()
    bp.attach(blocked)
    bp.attach(quiet)
    bp.send(blocked, 'a'.repeat(BACKPRESSURE_HIGH_WATERMARK + 1))
    bp.detach(quiet)
    expect(resume).not.toHaveBeenCalled()
    bp.detach(blocked)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('rejects frames past the hard ceiling without sending them', () => {
    const pause = vi.fn()
    const bp = createPtyBackpressure(pause, () => {})
    const ws = stubSocket()
    bp.attach(ws)
    bp.send(ws, 'a'.repeat(BACKPRESSURE_HARD_CEILING)) // at the ceiling: allowed
    expect(bp.send(ws, 'a'.repeat(16))).toBe(false) // past it: rejected
    expect(ws.sent).toHaveLength(1)
  })

  it('accounts UTF-8 bytes, not code units', () => {
    const pause = vi.fn()
    const bp = createPtyBackpressure(pause, () => {})
    const ws = stubSocket()
    bp.attach(ws)
    bp.send(ws, '你'.repeat(1)) // 3 bytes in UTF-8
    expect(pause).not.toHaveBeenCalled() // 3 bytes « 1MB
    ws.flush()
    expect(ws.sent[0]).toBe('你')
  })
})
