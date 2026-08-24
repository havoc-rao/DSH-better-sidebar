/**
 * Rate-limited terminal reflow (fit + resize), ported from tabby-terminal's
 * xtermFrontend resize handling (MIT, Copyright (c) 2017 Tabby Developers).
 *
 * A panel drag or window resize fires ResizeObserver callbacks many times
 * per frame; each reflow resizes xterm's renderer drawing buffer and
 * re-uploads the glyph atlas, so at full rate a fast drag reflows faster
 * than the renderer can repaint — visible flicker — while every reflow also
 * hits the pty's `resize()` (a SIGWINCH storm for the shell). Capping the
 * reflow rate and always running a trailing fit keeps the final size
 * correct without outrunning the renderer.
 *
 * Semantics (mirror of tabby's RESIZE_MIN_INTERVAL=32):
 * - A schedule() within `minInterval` of the last run only marks pending;
 * - the pending run fires on the next animation frame after the interval
 *   elapses (timer → rAF → run), so rapid bursts coalesce into one trailing
 *   fit with the final dimensions;
 * - schedule() after the interval has elapsed runs on the next rAF.
 * The returned cancel() drops a pending run (idempotent).
 */
export interface ThrottledFitDeps {
  raf: (cb: FrameRequestCallback) => number
  caf: (id: number) => void
  setTimeout: (fn: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  now: () => number
}

export interface ThrottledFit {
  /** Request a reflow; coalesced to at most one trailing run per interval. */
  schedule: () => void
  /** Drop a pending run (idempotent); call from the effect cleanup. */
  cancel: () => void
}

const defaultDeps: ThrottledFitDeps = {
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  now: () => Date.now(),
}

export function createThrottledFit(
  run: () => void,
  minInterval = 32,
  deps: ThrottledFitDeps = defaultDeps,
): ThrottledFit {
  let pending = false
  // Negative so the FIRST schedule() is always a fast-path rAF: wait =
  // max(0, minInterval - (now - last)) is 0 both for a real epoch clock
  // (now » 0) and for a test clock sitting at 0.
  let last = -minInterval
  let timer: number | null = null
  let frame: number | null = null

  const fire = (): void => {
    pending = false
    last = deps.now()
    timer = null
    frame = null
    run()
  }

  return {
    schedule() {
      if (pending) return
      pending = true
      const wait = Math.max(0, minInterval - (deps.now() - last))
      if (wait > 0) {
        timer = deps.setTimeout(() => {
          timer = null
          frame = deps.raf(fire)
        }, wait)
      } else {
        frame = deps.raf(fire)
      }
    },
    cancel() {
      pending = false
      if (timer !== null) {
        deps.clearTimeout(timer)
        timer = null
      }
      if (frame !== null) {
        deps.caf(frame)
        frame = null
      }
    },
  }
}
