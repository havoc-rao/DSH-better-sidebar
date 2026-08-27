/**
 * The VSCode-style Activity Bar: a 48px vertical icon strip that iconizes
 * the `+` menu — every registered, non-hidden, enabled tab descriptor becomes
 * one icon row (sorted by `order`, exactly like {@link buildNewTabOptions}),
 * and a click opens that tab type through the same `openTab` path the `+`
 * menu uses. The active tab's type gets the inner-edge indicator bar
 * (VSCode's active-view mark); the `available` predicate disables a row the
 * same way the `+` menu shows a disabled entry (e.g. terminal at quota).
 *
 * The bar is rendered only in `sidebarLayout: 'vscode'` — in docked mode the
 * `+` menu stays the sole launcher (zero change to the original behavior). It
 * carries no state of its own: every value is derived from the registry and
 * the current session snapshot, so HMR and session switches need no teardown.
 *
 * `flipped` (`sideBarSide: 'left'`) mirrors the WHOLE bar to the panel's left
 * edge together with the Side Bar column; the bottom toggle button (shown
 * when `onToggleSideBarSide` is wired) flips the arrangement back and forth.
 */
import { type ReactNode } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { activeTabOf, type SidebarState } from './state.ts'
import { t } from './locales.ts'
import { keySpecLabel, parseKeySpec } from './keybindings.ts'
import type { SessionScope } from './api.ts'
import { IconSwapSides16 } from './icons.tsx'
import css from './sidebar.module.css'

/** The platform-aware shortcut hints shown in the icon tooltips (⌘⇧E / ⌘⇧G,
 *  matching the builtin view-switch keybindings). The IDE chat-column toggle
 *  carries ⌘⌥B (the "right panel" muscle memory) AND ⌘⇧B — both hotkeys
 *  exist only inside IDE FULLSCREEN. */
const EXPLORER_HINT = keySpecLabel(parseKeySpec('Cmd+Shift+E'))
const GIT_HINT = keySpecLabel(parseKeySpec('Cmd+Shift+G'))
const CHAT_HINT = `${keySpecLabel(parseKeySpec('Cmd+Alt+B'))} / ${keySpecLabel(parseKeySpec('Cmd+Shift+B'))}`

/** One iconized launcher derived from a tab descriptor. */
interface ActivityIcon {
  id: string
  label: string
  icon: ReactNode
  disabled: boolean
}

/** Derive the activity-bar icons from the registry — the same filter/sort as
 *  the `+` menu (non-hidden, enabled, by `order`), so the two never diverge. */
function activityIcons(state: SidebarState, ctx: Context, scope: SessionScope): ActivityIcon[] {
  const service = ctx.betterSidebar
  if (service === undefined) return []
  return service.getTabs()
    .filter(d => !d.hidden && service.isTabEnabled(d.id))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map(d => ({
      id: d.id,
      label: typeof d.title === 'function' ? d.title() : d.title,
      icon: typeof d.icon === 'function' ? d.icon(22) : d.icon,
      disabled: !(d.available?.(ctx, scope, state) ?? true),
    }))
}

export function ActivityBar(props: {
  ctx: Context
  state: SidebarState
  scope: SessionScope
  /** Open a tab type (the same path the `+` menu takes). */
  onOpen: (tabType: string) => void
  /** Whether the vscode EXPLORER drawer (the independent file-tree column)
   *  is expanded. When given, the files-window icon becomes the explorer
   *  drawer toggle (click collapses/expands it, highlight = expanded)
   *  instead of opening an editor tab — the "explorer is a drawer, files are
   *  tabs" separation. Absent = the plain launcher behavior. */
  sideBarOpen?: boolean
  /** Toggle the explorer drawer (wired with `sideBarOpen`). */
  onToggleSideBar?: () => void
  /** Whether the IDE-FULLSCREEN chat column (the Side Chat section at the
   *  panel's right edge) is expanded. When given, the Side Chat icon becomes
   *  the chat column toggle (click collapses/expands it, highlight =
   *  expanded) instead of opening a chat tab — inside the IDE the column IS
   *  the chat surface. Absent = the plain launcher behavior. */
  chatOpen?: boolean
  /** Toggle the IDE chat column (wired with `chatOpen`). */
  onToggleChat?: () => void
  /** Mirror the whole bar to the panel's LEFT edge (`sideBarSide: 'left'`):
   *  the border + active indicator flip, and the icon tooltips open to the
   *  RIGHT (VSCode's activity-bar tooltip side) instead of below. */
  flipped?: boolean
  /** Flip the Side Bar to the other side of the panel. When given, a toggle
   *  button pins to the BAR'S BOTTOM (the VSCode activity-bar settings-gear
   *  spot) instead of a separate strip. */
  onToggleSideBarSide?: () => void
}) {
  const { ctx, state, scope, onOpen, sideBarOpen, onToggleSideBar, chatOpen, onToggleChat, flipped, onToggleSideBarSide } = props
  const icons = activityIcons(state, ctx, scope)
  const activeTab = activeTabOf(state)
  const activeType = activeTab?.type ?? ''
  // The bar's tooltips: at the panel's RIGHT edge they open below the icon;
  // mirrored to the LEFT edge, they open to the right (VSCode's side).
  const tooltipSide = flipped === true ? 'right' : 'bottom'

  return (
    <div className={clsx(css.activityBar, flipped === true && css.activityBarFlipped)} role="toolbar" aria-label={t('activityBarLabel')} aria-orientation="vertical">
      {icons.map(icon => {
        // In the vscode layout the files-window icon is the EXPLORER drawer
        // toggle: the file tree lives in the collapsible side bar, so the
        // icon expands/collapses it (highlight follows sideBarOpen) instead
        // of opening an editor tab.
        const isExplorer = icon.id === 'editor' && onToggleSideBar !== undefined
        // Inside IDE FULLSCREEN the Side Chat icon is the CHAT COLUMN
        // toggle: the column at the panel's right edge IS the chat surface
        // (a chat tab would hide behind the fullscreen editor group), so the
        // icon expands/collapses it (highlight follows chatOpen) instead of
        // opening another chat tab.
        const isChat = icon.id === 'sidechat' && onToggleChat !== undefined
        const label = isExplorer
          ? t('explorer')
          : isChat
            ? (chatOpen === true ? t('sideChat') : t('sideChatExpand'))
            : icon.label
        const active = isExplorer
          ? (sideBarOpen === true)
          : isChat
            ? (chatOpen === true)
            : icon.id === activeType
        // The styled hover tooltip (the corner toggles' look): the explorer /
        // git / (IDE) chat icons also carry their shortcut hint.
        const hint = isExplorer
          ? EXPLORER_HINT
          : isChat
            ? CHAT_HINT
            : icon.id === 'git' ? GIT_HINT : undefined
        return (
          <Tooltip
            key={icon.id}
            label={hint !== undefined ? `${label} (${hint})` : label}
            side={tooltipSide}
            delayMs={500}
            disabled={icon.disabled}
          >
            <button
              type="button"
              className={clsx(css.activityBarIcon, active && css.activityBarIconActive)}
              aria-label={label}
              aria-current={active ? 'true' : undefined}
              disabled={icon.disabled}
              onClick={() => {
                if (isExplorer) { onToggleSideBar() } else if (isChat) { onToggleChat() } else { onOpen(icon.id) }
              }}
            >
              {icon.icon}
            </button>
          </Tooltip>
        )
      })}
      {/*
        The Side Bar position toggle, pinned to the BAR'S BOTTOM (the spacer
        pushes it down — the VSCode activity-bar settings-gear spot). The
        swap-sides glyph (left↔right arrows) reads as "move the whole
        arrangement to the other side"; one tap flips it (icon bar +
        file-tree column mirror to the other edge).
      */}
      {onToggleSideBarSide !== undefined && (
        <>
          <div className={css.activityBarSpacer} />
          <Tooltip label={t('sideBarSideToggle')} side={tooltipSide} delayMs={500}>
            <button
              type="button"
              className={css.activityBarIcon}
              aria-label={t('sideBarSideToggle')}
              onClick={onToggleSideBarSide}
            >
              <IconSwapSides16 size={18} />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  )
}
