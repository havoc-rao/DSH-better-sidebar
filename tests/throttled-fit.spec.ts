/**
 * Throttled-fit tests: the rate-limited terminal reflow (fit + resize) that
 * coalesces ResizeObserver bursts during a panel drag into one trailing run
 * per interval — ported from tabby's RESIZE_MIN_INTERVAL=32 resize handler.
 * A manual clock and frame queue drive the timing deterministically.
 */
import { describe, expect, it, vi } from 'vitest'
import { createThrottledFit, type ThrottledFitDeps } from '../src/client/throttled-fit.ts'

interface Harness {
  deps: ThrottledFitDeps
  /** Advance the fake clock; fires any timers that come due. */
  advance: (ms: number) => void
  /** Fire the next queued animation frame. */
  flushFrame: () => void
  hasFrame: () => boolean
  hasTimer: () => boolean
}

function makeHarness(): Harness {
  let now = 0
  let nextTimerId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const frames = new Map<number, FrameRequestCallback>()
  const deps: ThrottledFitDeps = {
    raf: vi.fn((cb) => {
      const id = nextTimerId + 1000 // keep timer and frame ids disjoint
      frames.set(id, cb)
      return id
    }),
    caf: vi.fn((id) => { frames.delete(id) }),
    setTimeout: vi.fn((fn, ms) => {
      const id = nextTimerId++
      timers.set(id, { at: now + ms, fn })
      return id
    }),
    clearTimeout: vi.fn((id) => { timers.delete(id) }),
    now: () => now,
  }
  return {
    deps,
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    flushFrame() {
      const first = frames.keys().next()
      if (first.done) return
      const id = first.value
      const cb = frames.get(id)!
      frames.delete(id)
      cb(now)
    },
    hasFrame: () => frames.size > 0,
    hasTimer: () => timers.size > 0,
  }
}

describe('createThrottledFit', () => {
  it('runs a cold schedule on the next animation frame', () => {
    const h = makeHarness()
    const run = vi.fn()
    const tf = createThrottledFit(run, 32, h.deps)
    tf.schedule()
    expect(h.hasTimer()).toBe(false) // cold: interval already elapsed (last=0)
    expect(h.hasFrame()).toBe(true)
    h.flushFrame()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst within the interval into one trailing run', () => {
    const h = makeHarness()
    const run = vi.fn()
    const tf = createThrottledFit(run, 32, h.deps)
    tf.schedule()
    h.flushFrame() // cold run at t=0
    expect(run).toHaveBeenCalledTimes(1)

    // A burst 5ms later only arms the timer (no frame yet).
    h.advance(5)
    tf.schedule()
    tf.schedule()
    tf.schedule()
    expect(h.hasFrame()).toBe(false)
    expect(h.hasTimer()).toBe(true)

    // Fast-forward past the 32ms window: one timer fires → one frame → one run.
    h.advance(27)
    h.flushFrame()
    expect(run).toHaveBeenCalledTimes(2)
    expect(h.hasFrame()).toBe(false)
    expect(h.hasTimer()).toBe(false)
  })

  it('schedules directly on rAF once the interval has elapsed', () => {
    const h = makeHarness()
    const run = vi.fn()
    const tf = createThrottledFit(run, 32, h.deps)
    tf.schedule()
    h.flushFrame()
    h.advance(100) // well past the interval
    tf.schedule()
    expect(h.hasTimer()).toBe(false)
    expect(h.hasFrame()).toBe(true)
    h.flushFrame()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('cancel drops a pending run and is idempotent', () => {
    const h = makeHarness()
    const run = vi.fn()
    const tf = createThrottledFit(run, 32, h.deps)
    tf.schedule()
    h.advance(5)
    tf.schedule() // arms the timer
    tf.cancel()
    expect(h.hasFrame()).toBe(false)
    expect(h.hasTimer()).toBe(false)
    h.advance(100)
    h.flushFrame()
    expect(run).not.toHaveBeenCalled()
    tf.cancel() // idempotent
    expect(run).not.toHaveBeenCalled()
  })

  it('a trailing run uses the latest dimensions (single run after burst)', () => {
    const h = makeHarness()
    const run = vi.fn()
    const tf = createThrottledFit(run, 32, h.deps)
    tf.schedule()
    h.flushFrame()
    h.advance(1)
    tf.schedule()
    tf.schedule()
    h.advance(31)
    h.flushFrame()
    expect(run).toHaveBeenCalledTimes(2) // only the trailing run of the burst
    expect(h.hasFrame()).toBe(false)
    expect(h.hasTimer()).toBe(false)
  })
})
