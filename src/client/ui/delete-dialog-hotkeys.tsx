import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '../../context-types.ts'
import css from './kit.module.css'

export const DELETE_CONFIRM = 'betterSidebar.delete.confirm'
export const DELETE_CANCEL = 'betterSidebar.delete.cancel'
interface HintDef {
  kind: 'single'
  scope: 'root'
  owner: { hotkeyHint: { version: 1; commandId: string; disabled: boolean } }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'betterSidebar.delete.confirm.hotkeyHint': HintDef
    'betterSidebar.delete.cancel.hotkeyHint': HintDef
  }
}
export type DeleteHintRenderProps = PropsRenderSlots<
  'betterSidebar.delete.confirm.hotkeyHint' | 'betterSidebar.delete.cancel.hotkeyHint'
>
interface Action {
  id: string
  owner: string
  zh: string
  en: string
  group: string
  defaultBinding: string | { mac: string; default: string }
  scope: 'focus'
  element: HTMLElement
  available(): boolean
  run(): boolean
}
interface Registry { version: 1; registerAction(action: Action): () => void }
interface Owner {
  busy?: boolean
  confirmLabel: string
  cancelLabel: string
  onConfirm(): void
  onClose(): void
}
interface Seat { element: HTMLElement; confirm: HTMLElement; cancel: HTMLElement; owner: Owner }
// DOM seats bridge independently rendered workbenches to ONE authorized slot
// entry, just like the git action slot. Never borrow another entry's renderer.
const seats = new Map<HTMLElement, Seat>()
const listeners = new Set<() => void>()
const bridges = new Set<object>()
let snapshot: { seats: Seat[]; leader?: object } = { seats: [] }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const getSnapshot = () => snapshot
function publish(): void {
  snapshot = { seats: [...seats.values()], leader: bridges.values().next().value }
  for (const listener of [...listeners]) listener()
}

/** Only file deletion opts in; unrelated ConfirmDialog callers are unchanged. */
export function DeleteDialogActions(props: Owner): ReactNode {
  const element = useRef<HTMLDivElement>(null)
  const confirm = useRef<HTMLSpanElement>(null)
  const cancel = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const node = element.current!
    seats.set(node, { element: node, confirm: confirm.current!, cancel: cancel.current!, owner: props })
    publish()
  }, [props])
  useLayoutEffect(() => {
    const node = element.current!
    return () => { seats.delete(node); publish() }
  }, [])
  return <div ref={element} className={css.confirmActions}>
    <Button variant="outline" data-modal-autofocus disabled={props.busy} onClick={props.onClose}>
      {props.cancelLabel}<span ref={cancel} className={css.confirmHotkey} />
    </Button>
    <Button variant="primary" disabled={props.busy} onClick={props.onConfirm}>
      {props.confirmLabel}<span ref={confirm} className={css.confirmHotkey} />
    </Button>
  </div>
}

export function registerDeleteDialogHotkeys(registry: Registry): () => void {
  let releases: Array<() => void> = []
  let current: Seat | undefined
  const clear = () => { for (const release of releases.splice(0).reverse()) release() }
  const sync = () => {
    const seat = snapshot.seats.at(-1)
    // Bridge elections do not change the action owner or reset its latch.
    if (seat === current) return
    current = seat
    clear()
    if (!seat) return
    // The whole modal, not just its footer, owns focus. Foreground arbitration
    // remains the dispatcher's job; order cannot bypass another modal.
    const element = seat.element.closest<HTMLElement>('[role="dialog"]')
    if (!element) return
    let claimed = false
    const available = () => !claimed && !seat.owner.busy && seats.get(seat.element) === seat && element.isConnected
    try {
      for (const [id, zh, en, defaultBinding, run] of [
        [DELETE_CONFIRM, '确认删除文件', 'Confirm file deletion', { mac: 'meta+enter', default: 'ctrl+enter' }, seat.owner.onConfirm],
        // Plain Escape stays with Modal's IME/menu-aware native dismissal.
        [DELETE_CANCEL, '取消删除文件', 'Cancel file deletion', { mac: 'meta+escape', default: 'ctrl+escape' }, seat.owner.onClose],
      ] as const) releases.push(registry.registerAction({
        id, owner: 'dsh-better-sidebar', zh, en, group: 'files', defaultBinding,
        scope: 'focus', element, available,
        run: () => {
          if (!available()) return false
          claimed = true
          run()
          return true
        },
      }))
    } catch (error) { clear(); throw error }
  }
  const unsubscribe = subscribe(sync)
  try { sync() } catch (error) { unsubscribe(); throw error }
  return () => { unsubscribe(); clear() }
}

export function installDeleteDialogHotkeys(ctx: Context): void {
  ctx.inject(['hotkey'], scope => {
    const registry = scope.get('hotkey') as Registry | undefined
    if (registry?.version !== 1 || typeof registry.registerAction !== 'function') return
    scope.effect(() => registerDeleteDialogHotkeys(registry), 'dsh-better-sidebar: delete dialog hotkeys')
  })
}

export function DeleteDialogHintBridge({ renderSlot }: DeleteHintRenderProps): ReactNode {
  const token = useRef<object>({}).current
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useLayoutEffect(() => {
    bridges.add(token); publish()
    return () => { bridges.delete(token); publish() }
  }, [token])
  if (state.leader !== token) return null
  return <>{state.seats.map(seat => <HintSeat key={state.seats.indexOf(seat)} seat={seat} renderSlot={renderSlot} />)}</>
}
function HintSeat({ seat, renderSlot }: DeleteHintRenderProps & { seat: Seat }): ReactNode {
  const disabled = !!seat.owner.busy
  return <>
    {createPortal(renderSlot('betterSidebar.delete.confirm.hotkeyHint', { hotkeyHint: { version: 1, commandId: DELETE_CONFIRM, disabled } }), seat.confirm)}
    {createPortal(renderSlot('betterSidebar.delete.cancel.hotkeyHint', { hotkeyHint: { version: 1, commandId: DELETE_CANCEL, disabled } }), seat.cancel)}
  </>
}
