import { useLayoutEffect, useRef, type RefObject } from 'react'

// Survives tab-body unmounts and closing/reopening Files, but not a page reload.
// Bound the cache so visiting many sessions cannot grow it indefinitely.
const positions = new Map<string, number>()
const MAX_SCOPES = 100

/** Remember tree scroll independently for each session and working directory. */
export function useTreeScroll(
  bodyRef: RefObject<HTMLDivElement>,
  sessionId: string,
  cwd: string | undefined,
  ready: boolean,
  visible: boolean,
): () => void {
  const key = JSON.stringify([sessionId, cwd])
  const pending = useRef(true)

  useLayoutEffect(() => {
    pending.current = true
  }, [key, visible])

  useLayoutEffect(() => {
    const body = bodyRef.current
    // A loading placeholder or a parked surface has no usable scroll range.
    // Do not let its clamped zero overwrite the last real position.
    if (!pending.current || !ready || !visible || body === null || body.clientHeight === 0) return
    body.scrollTop = positions.get(key) ?? 0
    pending.current = false
  }, [bodyRef, key, ready, visible])

  return () => {
    const body = bodyRef.current
    if (pending.current || !ready || !visible || body === null || body.clientHeight === 0) return
    positions.delete(key)
    positions.set(key, body.scrollTop)
    if (positions.size > MAX_SCOPES) positions.delete(positions.keys().next().value!)
  }
}
