/** Session-scoped drop owner; never mutate a draft via DOM or setDraft. */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './locales.ts'
import css from './sidebar.module.css'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Context } from '../context-types.ts'
import { canInsertFileReference, FILE_REFERENCE_MIME, insertDroppedFileReference, parseFileReferenceDrag } from './file-reference-drag.ts'

const docks = new Map<HTMLElement, () => void>()
function visible(node: HTMLElement): boolean {
  if (!node.isConnected || node.closest('[hidden], [aria-hidden="true"], [inert]')) return false
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    const style = getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

export function FileReferenceDrop(props: PropsRuntime<'conversation.input.left'> & { ctx: Context; sessionId?: string }) {
  const phase = props.useInput(state => state.phase)
  const [overlay, setOverlay] = useState<'ready' | 'blocked' | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const latest = useRef({ props, phase })
  latest.current = { props, phase }
  useEffect(() => {
    const dock = anchor.current!
    const reset = (): void => { setOverlay(null) }
    docks.set(dock, reset)
    const owns = (event: DragEvent): boolean => {
      if (!event.dataTransfer?.types.includes(FILE_REFERENCE_MIME) || event.dataTransfer.types.includes('Files')) return false
      const target = event.target instanceof Element ? event.target : null
      if (!target || target.closest('[role="tree"], [role="treeitem"], [data-dsh-file-tree], [data-dsh-panel-host], [data-dsh-native-tab-host], [data-dsh-enhanced-workspace]')) return false
      if (!visible(dock)) return false
      const occurrence = target.closest('[data-conversation-session]')
      // Only the actual conversation is a target, never arbitrary page chrome.
      if (!occurrence || occurrence.getAttribute('data-conversation-session') !== latest.current.props.sessionId) return false
      const candidates = [...docks.keys()].filter(candidate => visible(candidate) && occurrence.contains(candidate))
      return candidates.length === 1 && candidates[0] === dock
    }
    const writable = (): boolean => {
      const field = dock.closest('[data-composer-card]')?.querySelector('textarea')
      return latest.current.phase === 'plain' && !(field?.disabled || field?.readOnly)
        && canInsertFileReference(latest.current.props.inputActions)
    }
    const claim = (event: DragEvent): void => { event.preventDefault(); event.stopImmediatePropagation() }
    const over = (event: DragEvent): void => {
      if (!owns(event)) { reset(); return }
      for (const [candidate, clear] of docks) if (candidate !== dock) clear()
      claim(event)
      const allowed = writable()
      event.dataTransfer!.dropEffect = allowed ? 'copy' : 'none'
      setOverlay(allowed ? 'ready' : 'blocked')
    }
    const leave = (event: DragEvent): void => {
      const next = event.relatedTarget
      // Child transitions retain the overlay; exiting the occurrence/tree does not.
      if (next instanceof Element) {
        const occurrence = dock.closest('[data-conversation-session]')
        if (!occurrence?.contains(next) || next.closest('[data-dsh-file-tree], [data-dsh-panel-host], [data-dsh-native-tab-host], [role="tree"], [role="treeitem"]')) reset()
      } else if (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight) reset()
    }
    const drop = (event: DragEvent): void => {
      reset()
      if (!owns(event)) return
      // Even rejected drops must not fall through to native text insertion.
      claim(event)
      if (!writable()) return
      const payload = parseFileReferenceDrag(event.dataTransfer!.getData(FILE_REFERENCE_MIME))
      if (!payload) return
      const { ctx, sessionId, inputActions } = latest.current.props
      if (!sessionId) return
      const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      insertDroppedFileReference(inputActions, payload, cwd)
    }
    window.addEventListener('dragenter', over, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      docks.delete(dock)
      window.removeEventListener('dragenter', over, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])
  return <>
    <span ref={anchor} data-dsh-file-reference-drop="" />
    {overlay !== null && createPortal(
      <div className={css.fileReferenceDropOverlay} data-dsh-file-reference-overlay={overlay} role="status">
        <div className={css.fileReferenceDropHero}>
          <div className={overlay === 'blocked' ? css.fileReferenceDropBlocked : css.fileReferenceDropIcon} aria-hidden="true">
            <IconLinkOutlineRegular size={84} />
          </div>
          <div className={css.fileReferenceDropTitle}>{t(overlay === 'blocked' ? 'fileReferenceDropBlocked' : 'fileReferenceDropHint')}</div>
          {overlay === 'ready' && <div className={css.fileReferenceDropDescription}>{t('fileReferenceDropDescription')}</div>}
        </div>
      </div>, document.body,
    )}
  </>
}

export function registerFileReferenceDrop(ctx: Context): () => void {
  return ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'better-sidebar-file-reference-drop', order: 31,
    inject: () => ({ ctx }),
  }, FileReferenceDrop))
}
