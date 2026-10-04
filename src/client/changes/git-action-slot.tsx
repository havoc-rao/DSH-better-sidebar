import { Component, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { BetterSidebarService, GitCommitTarget } from '../service.ts'

/**
 * Live owner props for `betterSidebar.git.actions`. The slot is deliberately
 * root-scoped: `scope` is the lens's real session, NOT the session inherited
 * from whichever header happens to carry the authorized renderer.
 */
export interface GitActionSlotProps extends GitCommitTarget {
  service?: BetterSidebarService
  commitMessage: string
  setCommitMessage(value: string): void
  busy: boolean
  /** Serialize with the built-in actions and share their error handling. */
  runAction(action: () => Promise<unknown>): Promise<void>
  refresh(): Promise<void>
  close(): void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'betterSidebar.git.actions': {
      kind: 'list'
      scope: 'root'
      owner: GitActionSlotProps
    }
  }
}

export type GitActionSlotRenderProps = PropsRenderSlots<'betterSidebar.git.actions'>

type Seat = { id: string; element: HTMLDivElement; owner: GitActionSlotProps }
// A workbench is an independent createRoot, so neither React context nor a
// renderSlot borrowed from that root can carry the host's authorization. Keep
// only DOM seats here; all slot rendering stays under the authorized entry.
const seats = new Map<HTMLDivElement, Seat>()
const bridges = new Set<object>()
const listeners = new Set<() => void>()
let nextSeatId = 0
let snapshot: { seats: readonly Seat[]; leader: object | undefined } = { seats: [], leader: undefined }
const getSnapshot = () => snapshot
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(): void {
  snapshot = { seats: [...seats.values()], leader: bridges.values().next().value }
  for (const listener of [...listeners]) listener()
}

/** DOM placement only; safe inside an independently rendered workbench. */
export function GitActionSlotHost({ owner }: { owner: GitActionSlotProps }) {
  const element = useRef<HTMLDivElement>(null)
  // Updating the owner must not remove/reinsert the seat (which would unmount
  // contributed controls and lose their local state on every keystroke).
  useLayoutEffect(() => {
    const node = element.current!
    const prior = seats.get(node)
    if (prior?.owner === owner) return
    seats.set(node, { id: prior?.id ?? `git-action-seat-${++nextSeatId}`, element: node, owner })
    publish()
  }, [owner])
  useLayoutEffect(() => {
    const node = element.current!
    return () => {
      if (seats.delete(node)) publish()
    }
  }, [])
  return <div ref={element} data-better-sidebar-git-action-slot="" />
}

class SeatBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? null : this.props.children }
}

// Invoke renderSlot INSIDE the boundary: authorization/dispatch can throw
// synchronously, before any contributed React component has rendered.
function SeatContent({ renderSlot, owner }: GitActionSlotRenderProps & { owner: GitActionSlotProps }) {
  return <>{renderSlot('betterSidebar.git.actions', owner)}</>
}

/** Mounted only by the bottom-toggle entry which declares this child slot. */
export function GitActionSlotBridge({ renderSlot }: GitActionSlotRenderProps) {
  const token = useRef<object>({}).current
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // Retained session headers can mount the same entry more than once. Only
  // one instance portals into the seats; disposal elects a surviving header.
  useLayoutEffect(() => {
    bridges.add(token)
    publish()
    return () => {
      bridges.delete(token)
      publish()
    }
  }, [token])
  if (state.leader !== token) return null
  return <>{state.seats.map(seat => createPortal(
    <SeatBoundary><SeatContent renderSlot={renderSlot} owner={seat.owner} /></SeatBoundary>,
    seat.element,
    seat.id,
  ))}</>
}
