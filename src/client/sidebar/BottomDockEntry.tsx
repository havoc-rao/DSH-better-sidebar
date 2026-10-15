/** Lightweight blank-session entry; mounted before workbench settings resolve. */
import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { Context } from '../../context-types.ts'
import type { SidebarStore } from '../state.ts'
import { mountedSessions } from '../native/surface.ts'
import { DockFallback } from './dock-fallback.tsx'

export function BottomDockEntry({ ctx, store }: { ctx: Context; store: SidebarStore }) {
  const mounted = useMemo(() => mountedSessions(ctx), [ctx])
  const sessionId = useSyncExternalStore(
    useCallback((listener: () => void) => mounted.subscribe(listener), [mounted]),
    useCallback(() => mounted.getSnapshot(), [mounted]),
  )
  // Bind before paint so an early click writes to the selected session, not a
  // previous session. The later workbench mount reuses this same store.
  useLayoutEffect(() => {
    if (sessionId !== undefined) store.setSession(sessionId)
  }, [sessionId, store])
  return <DockFallback ctx={ctx} store={store} />
}
