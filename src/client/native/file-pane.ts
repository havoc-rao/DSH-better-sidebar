/** Files-window placement using the host's read-only dock/session DOM markers.
 * The public controller accepts paneId but exposes no layout reader. Resolve at
 * click time (not mount time), since kept bodies can move between panes.
 */
import type { Context } from '../../context-types.ts'
import { addressBaseOf } from '../address-base.ts'
import { fileAddressFor } from '../resource-address.ts'
import { mountedSessionId } from './surface.ts'

/** Open in an existing sibling docked pane, or leave the normal flow untouched.
 * Never splits, touches another session, or treats floating panels as columns.
 * The host still owns resource claiming and reveal/deduplication.
 */
export function openFileInOtherPane(
  ctx: Context,
  sessionId: string,
  root: HTMLElement | null,
  cwd: string | undefined,
  path: string,
): boolean {
  if (root === null || mountedSessionId(ctx) !== sessionId) return false
  const source = root.closest<HTMLElement>('[data-dockkit-pane], [data-dockkit-float]')
  const owner = source?.closest<HTMLElement>('[data-sidebar-right-session]')
  if (source === null || source === undefined || !source.hasAttribute('data-dockkit-pane')
    || owner?.dataset.sidebarRightSession !== sessionId) return false
  // A compact host can hide the other window group without removing its
  // pane marker. Keep it eligible: native navigation selects/reveals it.
  const other = [...owner.querySelectorAll<HTMLElement>('[data-dockkit-pane]')].find(pane =>
    pane !== source && pane.closest('[data-sidebar-right-session]') === owner)
  const paneId = other?.dataset.dockkitPane
  if (paneId === undefined || paneId === '') return false
  // Structural slice: the plugin's minimal Context does not model placement.
  const api = ctx.get('sidebarRight') as unknown as {
    openResource(address: string, options: { paneId: string }): void
  } | undefined
  if (api === undefined) return false
  api.openResource(fileAddressFor(sessionId, addressBaseOf(ctx, sessionId) ?? cwd, path), { paneId })
  return true
}
