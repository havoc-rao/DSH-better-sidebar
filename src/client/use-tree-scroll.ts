import { useLayoutEffect, useRef, type RefObject } from 'react'

/** One remembered scroll offset: the tree body scrolls on both axes (long
 *  labels push the content column past the viewport horizontally). */
interface TreeScrollPosition {
  top: number
  left: number
}

// Survives tab-body unmounts and closing/reopening Files, but not a page reload.
// Bound the cache so visiting many sessions cannot grow it indefinitely.
const positions = new Map<string, TreeScrollPosition>()
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
    const saved = positions.get(key)
    body.scrollTop = saved?.top ?? 0
    // The horizontal offset survives with the vertical one: a reopened tree
    // returns to the same long label the user was reading.
    body.scrollLeft = saved?.left ?? 0
    pending.current = false
  }, [bodyRef, key, ready, visible])

  return () => {
    const body = bodyRef.current
    if (pending.current || !ready || !visible || body === null || body.clientHeight === 0) return
    positions.delete(key)
    positions.set(key, { top: body.scrollTop, left: body.scrollLeft })
    if (positions.size > MAX_SCOPES) positions.delete(positions.keys().next().value!)
  }
}
