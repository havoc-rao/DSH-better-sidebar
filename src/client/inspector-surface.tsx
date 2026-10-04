/** Adapter for the host's public ROOT right-column seat (never a Session tab). */
import type { Context } from '../context-types.ts'
import type { BetterSidebarService } from './service.ts'
import { InspectorHost } from './InspectorHost.tsx'

/** Structural ISidebarRightRoot mirror, compatible with older installed typings. */
export interface RootInspectorController {
  register(key: string): () => void
  open(key: string): void
  close(key: string): void
}
export const INSPECTOR_VIEW_ID = 'dsh-better-sidebar:inspectors'
export const INSPECTOR_ROOT_SLOT = 'rightbar.root'

/** Availability follows both the public root key and its declared render seat. */
export function registerInspectorSurface(ctx: Context, service: BetterSidebarService, controller: RootInspectorController): () => void {
  const disposers: (() => void)[] = []
  try {
    disposers.push(ctx.slots.inject(INSPECTOR_ROOT_SLOT, () => {
      const releaseKey = controller.register(INSPECTOR_VIEW_ID)
      let unregister: (() => void) | undefined
      try {
        unregister = ctx.slots.register({
          name: INSPECTOR_ROOT_SLOT,
          key: INSPECTOR_VIEW_ID,
          id: INSPECTOR_VIEW_ID,
          // Host renders only the selected root; no Session or visible owner prop.
          inject: () => ({ service, visible: true }),
        }, InspectorHost)
        service.setInspectorSurface({
          reveal: () => {
            try { controller.open(INSPECTOR_VIEW_ID); return true } catch (error) {
              console.error('[dsh-better-sidebar] inspector root open failed:', error)
              return false
            }
          },
          close: () => controller.close(INSPECTOR_VIEW_ID),
        })
      } catch (error) {
        service.setInspectorSurface(undefined)
        unregister?.()
        releaseKey()
        throw error
      }
      return () => {
        service.setInspectorSurface(undefined)
        unregister?.()
        releaseKey()
      }
    }))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
