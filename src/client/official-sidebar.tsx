/**
 * Official-left-sidebar integration: the plugin injects a "Global info"
 * footer action into DSH's OFFICIAL left sidebar (`ui-sidebar`) through the
 * additive `sidebar.footer.action` slot (a list seat — every registrant
 * stacks above Settings without replacing the navigation column).
 *
 * Verified seam (2026-08-20): `ui-sidebar` registers `SidebarRoot` into the
 * `sidebar` slot and declares `sidebar.footer.action` as a `list` seat; the
 * shell renders it at the foot via `renderSlot('sidebar.footer.action',
 * { wide })`, so each entry receives `{ wide }` (column state). The
 * registration rides `ctx.slots.inject` so it waits for the declaration and
 * auto-disposes on fiber unload (HMR-safe) — no DSH source change, no
 * replacement of the official column.
 *
 * The button opens the plugin's FULL-PAGE "Global info" view (which records
 * the instance-level global windows incl. the `gb:` all-projects terminals)
 * via the module-level page controller — one click from the official rail to
 * the complete global page.
 */
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { IconGlobeOutline16 } from './icons.tsx'
import { setGlobalPageOpen } from './global-page.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** The official footer-action entry id (also the diagnostics label). */
const FOOTER_ACTION_ID = 'dsh-better-sidebar:global-info'

/**
 * The official `sidebar.footer.action` entry props: the shell hands each
 * entry only the column state. Kept structural (not imported from the
 * official package) — ui-sidebar is not a peer dep, and the shape is the
 * documented `{ wide }` owner share.
 */
interface OfficialFooterActionProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** The official sidebar footer button that opens the FULL-PAGE global info. */
export function GlobalInfoFooterButton(props: OfficialFooterActionProps) {
  const { wide } = props
  const open = (): void => {
    try {
      // The global info expands into a complete full-viewport page (not a
      // panel tab): the plugin shell renders <GlobalPage/> on this signal.
      setGlobalPageOpen(true)
    } catch {
      // Never let a footer click take the official sidebar down.
    }
  }
  const button = (
    <button
      type="button"
      className={wide ? css.officialFooterAction : `${css.officialFooterAction} ${css.officialFooterRail}`}
      aria-label={t('globalInfoFooter')}
      onClick={open}
    >
      <IconGlobeOutline16 size={wide ? 16 : 18} />
      {wide && <span className={css.officialFooterActionLabel}>{t('globalInfoFooter')}</span>}
    </button>
  )
  if (wide) return button
  return (
    <Tooltip label={t('globalInfoFooter')} side="right" delayMs={500}>
      {button}
    </Tooltip>
  )
}

/**
 * Register the "Global info" footer action into the official left sidebar.
 * Uses `ctx.slots.inject` (waits for the `sidebar.footer.action`
 * declaration; the callback returns the register disposer, collected by the
 * fiber on unload — HMR-safe). No-op (undefined) when the slots service is
 * absent (degraded host), mirroring the plugin's other slot registrations.
 * @returns a disposer, or undefined when there is nothing to register.
 */
export function registerOfficialSidebarEntry(ctx: Context): (() => void) | undefined {
  if (ctx.slots === undefined) return undefined
  return ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: FOOTER_ACTION_ID,
    order: 10,
    label: () => t('globalInfoFooter'),
  }, (props: OfficialFooterActionProps) => (
    <GlobalInfoFooterButton {...props} />
  )))
}
