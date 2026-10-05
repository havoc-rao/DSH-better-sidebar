import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { BetterSidebarService } from './service.ts'
import type { ResourceActionContext, ResourceActionDescriptor } from './resource-actions.ts'
import css from './sidebar.module.css'

export function isResourceAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

export function resourceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function resourceActionLabel(action: ResourceActionDescriptor): string {
  return typeof action.label === 'function' ? action.label() : action.label
}

export function resourceActionIcon(action: ResourceActionDescriptor, size = 14): ReactNode {
  return typeof action.icon === 'function' ? action.icon(size) : action.icon
}

/** Shared compact action seat. All consumer callbacks, including availability,
 * are guarded so an extension cannot take down the surrounding resource UI. */
export function ResourceActions(props: {
  service?: BetterSidebarService
  readContext: () => ResourceActionContext
  containerClassName?: string
}) {
  const { service } = props
  const latest = useRef(props.readContext)
  useLayoutEffect(() => { latest.current = props.readContext })
  const [, rerender] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useLayoutEffect(() => service?.subscribe?.(() => { rerender(value => value + 1) }), [service])
  let renderError: string | null = null
  let actions: { id: string; label: string; icon: ReactNode }[] = []
  try {
    actions = service?.getResourceActions?.(props.readContext()).map(action => ({
      id: action.id, label: resourceActionLabel(action), icon: resourceActionIcon(action),
    })) ?? []
  } catch (failure) {
    if (!isResourceAbort(failure)) renderError = resourceErrorMessage(failure)
  }
  if (actions.length === 0 && error === null && renderError === null) return null
  const content = <>
    {actions.map(action => <button
      key={action.id}
      type="button"
      className={css.iconButton}
      aria-label={action.label}
      title={action.label}
      onClick={() => {
        setError(null)
        void (async () => {
          try { await service?.runResourceAction?.(action.id, () => latest.current()) }
          catch (failure) { if (!isResourceAbort(failure)) setError(resourceErrorMessage(failure)) }
        })()
      }}
    >{action.icon ?? action.label}</button>)}
    {(renderError ?? error) !== null && <span role="alert" className={css.editorError}>{renderError ?? error}</span>}
  </>
  return props.containerClassName === undefined ? content : <div className={props.containerClassName}>{content}</div>
}
