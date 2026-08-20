/**
 * The tab strip of one pane: tabs capped at TAB_MAX_WIDTH (ellipsized),
 * overflow scrolls horizontally, a close button per tab, a four-way split
 * button cluster, and the + menu that opens new tabs (explorer / git /
 * terminal). Tabs are draggable; dropping onto another tab inserts before it,
 * dropping on the strip background appends to this pane.
 *
 * Workspace-bound windows (the "pinned" stubs) render at the END of the
 * strip behind a divider, whatever their array position: the caller hands
 * the full tab list and an `isBoundTabId` predicate, this component
 * partitions. Pinned tabs stay draggable like any tab — the pin marks the
 * window as workspace-shared, not as immovable — and their close button
 * routes to the shell's unbind path like any other close.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconCloseFill14, IconPlusOutline16, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTab } from './state.ts'
import { IconPinOutline16 } from './icons.tsx'
import { t } from './locales.ts'
import {
  enabledMenuIndices, isMenuImeComposition, menuAnchorIndex, menuDigitIndex, menuLetterMatches, menuMoveIndex,
  plusMenuDigit, plusMenuLetterOf,
  type MenuKeyOption,
} from './menu-keys.ts'
import { setPlusMenuOpen } from './keybindings.ts'
import css from './sidebar.module.css'

/** One + menu option. */
export interface NewTabOption {
  id: string
  label: string
  disabled?: boolean
  /** Leading icon (Menu row). */
  icon?: ReactNode
}

/** Drag payload for tab moves (HTML5 DnD dataTransfer). */
export const TAB_DRAG_TYPE = 'application/x-dsh-tab'

export interface TabDragPayload {
  tabId: string
  paneId: string
}

export function serializeDrag(payload: TabDragPayload): string {
  return JSON.stringify(payload)
}

export function parseDrag(raw: string): TabDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as TabDragPayload
    if (typeof parsed.tabId === 'string' && typeof parsed.paneId === 'string') return parsed
    return null
  } catch {
    return null
  }
}

/** Global tab-drag flag: PDF iframes become non-interactive synchronously. */
function setTabDragging(active: boolean): void {
  if (active) document.body.setAttribute('data-dsh-tab-dragging', '')
  else document.body.removeAttribute('data-dsh-tab-dragging')
}

export function TabBar(props: {
  paneId: string
  tabs: SidebarTab[]
  active: string | null
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onNewTab: (optionId: string) => void
  newTabOptions: NewTabOption[]
  /** Drop of a tab from any pane: (payload, insertBeforeTabId | null). */
  onDropTab: (payload: TabDragPayload, before: string | null) => void
  /** Icon resolver for tab labels (reads from the tab descriptor registry). */
  getTabIcon?: (tab: SidebarTab) => ReactNode
  /** Badge resolver for tab labels (reads the descriptor's `badge`; the
   *  resolver returns the rendered pill or null). */
  getTabBadge?: (tab: SidebarTab) => ReactNode
  /** Workspace-bound stub detection (pinned rendering; absent → no pins). */
  isBoundTabId?: (tabId: string) => boolean
  /** Right-click on a tab: the shell positions its workspace menu here. */
  onTabContextMenu?: (tab: SidebarTab, event: ReactMouseEvent) => void
  /** Whether a tab may be renamed by double-clicking its label (only
   *  renamable tabs get the inline editor; others keep the plain label). */
  canRenameTab?: (tab: SidebarTab) => boolean
  /** Commit a tab's renamed label (the store persists it with the layout). */
  onRename?: (tabId: string, title: string) => void
}) {
  const {
    paneId, tabs, active, onActivate, onClose, onNewTab, newTabOptions, onDropTab, getTabIcon, getTabBadge,
    isBoundTabId, onTabContextMenu, canRenameTab, onRename,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  /** The bound stub whose close button is ARMED (first click of the
   *  two-step close confirm); null = nothing armed. */
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null)
  const armedTimerRef = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** The + menu's keyboard highlight (drives Menu's `selectedId`). */
  const [menuHighlightId, setMenuHighlightId] = useState<string | null>(null)
  /** The letter-typeahead cursor: the same letter re-pressed advances to the
   *  NEXT matching option (standard menu typeahead). */
  const letterCursorRef = useRef<{ letter: string; index: number } | null>(null)

  // Inline rename: the tab id being edited + the draft text. A ref mirrors
  // the state so Enter (commit → unmount → blur) and IME composition never
  // double-commit.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const renamingRef = useRef<string | null>(null)
  useEffect(() => { renamingRef.current = renaming }, [renaming])

  /** Enter rename mode for one tab (double-click on its label). */
  const startRename = (tab: SidebarTab): void => {
    setDraft(tab.title)
    setRenaming(tab.id)
  }

  /**
   * Focus + select the whole draft when the rename editor mounts. MUST be a
   * stable callback: an inline arrow would be re-invoked on every keystroke
   * re-render (React re-runs ref callbacks whose identity changed), re-selecting
   * the value and making each new character replace the previous one.
   */
  const focusDraft = useCallback((el: HTMLInputElement | null): void => {
    if (el !== null) {
      el.focus()
      el.select()
    }
  }, [])

  /** Leave rename mode; `cancel` restores the old label, otherwise the
   *  trimmed draft is committed when non-empty and changed. */
  const commitRename = (tab: SidebarTab, cancel: boolean): void => {
    if (renamingRef.current !== tab.id) return
    setRenaming(null)
    if (cancel) return
    const next = draft.trim()
    if (next.length === 0 || next === tab.title) return
    onRename?.(tab.id, next)
  }

  /** How long the armed state survives without a confirming click. */
  const ARMED_MS = 2000

  /** The + menu options as the keyboard mapper reads them: the letter key is
   *  derived from the STABLE id (`terminal` → T), so the chip on the row and
   *  the typeahead key agree in every locale. */
  const menuKeyOptions: MenuKeyOption[] = newTabOptions.map(option => ({
    id: option.id,
    label: option.label,
    letter: plusMenuLetterOf(option.id),
    disabled: option.disabled,
  }))

  /** The + menu item rows: the original Menu's look, with the digit + letter
   *  chips appended to each row's label (right-aligned via the label flex
   *  wrapper — see .menuOptionLabel). */
  const menuItems = newTabOptions.map((option, index) => {
    const digit = plusMenuDigit(index)
    const letter = plusMenuLetterOf(option.id)
    // ONE chip per row in the form 4/T: position digit + letter key merged.
    const chip = digit !== '' && letter !== ''
      ? `${digit}/${letter}`
      : digit !== '' ? digit
        : letter !== '' ? letter : ''
    return {
      id: option.id,
      disabled: option.disabled,
      icon: option.icon,
      label: (
        <span className={css.menuOptionLabel}>
          <span className={css.menuOptionName}>{option.label}</span>
          {chip !== '' && (
            <span className={css.menuOptionKeys} aria-hidden="true">
              <kbd className={css.menuOptionKey}>{chip}</kbd>
            </span>
          )}
        </span>
      ),
    }
  })

  /** Close the + menu and publish the transient keybinding-context marker. */
  const closeMenu = (): void => {
    setMenuOpen(false)
    setMenuHighlightId(null)
    letterCursorRef.current = null
    setPlusMenuOpen(false)
  }

  /** Pick one option (by keyboard or click): opens the tab, closes the menu. */
  const pickOption = (id: string): void => {
    const option = newTabOptions.find(candidate => candidate.id === id)
    if (option === undefined || option.disabled === true) return
    onNewTab(id)
    closeMenu()
  }

  /** Open the + menu and settle its keyboard highlight on the first option. */
  const openMenu = (): void => {
    if (menuKeyOptions.length === 0) return
    setMenuHighlightId(newTabOptions[menuAnchorIndex(menuKeyOptions)]?.id ?? null)
    letterCursorRef.current = null
    setPlusMenuOpen(true)
    setMenuOpen(true)
  }

  /**
   * The + menu keyboard layer (v0.14.0+): a document-CAPTURE handler active
   * only while the menu is open. Digits (1…9, 0) select positionally
   * (skipping disabled rows by cycling forward), letters select the first
   * enabled option whose label starts with the letter (repeat advances),
   * arrows / Home / End move the highlight, Enter picks it, Escape closes.
   * Composition keys (the IME guard) and typed form fields yield entirely.
   */
  useEffect(() => {
    if (!menuOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isMenuImeComposition(event)) return
      const target = event.target as HTMLElement | null
      // Defensive: if focus somehow sits in a real form field, keep the keys
      // native (normally the + button holds focus while the menu is open).
      if (target !== null
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const key = event.key
      // Positional digits: 1…9 = the 1st…9th option, 0 = the 10th; a disabled
      // row is skipped by cycling forward around the list.
      if (/^[0-9]$/.test(key)) {
        let index = menuDigitIndex(menuKeyOptions, Number(key))
        if (index !== null && index < menuKeyOptions.length) {
          const start = index
          while (menuKeyOptions[index]?.disabled === true) {
            index = (index + 1) % menuKeyOptions.length
            if (index === start) break
          }
          if (menuKeyOptions[index]?.disabled !== true) {
            event.preventDefault()
            event.stopPropagation()
            pickOption(menuKeyOptions[index]!.id)
          }
        }
        return
      }
      // Letter typeahead (labels are localized; matching is on the visible
      // text). Re-pressing the same letter advances to the next match.
      if (/^[a-z]$/i.test(key)) {
        const matches = menuLetterMatches(menuKeyOptions, key)
        if (matches.length > 0) {
          event.preventDefault()
          event.stopPropagation()
          const cursor = letterCursorRef.current
          let pick = matches[0]!
          if (cursor !== null && cursor.letter === key.toLowerCase()) {
            const at = matches.indexOf(cursor.index)
            pick = matches[(at + 1) % matches.length]!
          }
          letterCursorRef.current = { letter: key.toLowerCase(), index: pick }
          pickOption(menuKeyOptions[pick]!.id)
        }
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        const base = menuHighlightId === null
          ? -1
          : menuKeyOptions.findIndex(option => option.id === menuHighlightId)
        const next = menuMoveIndex(base, event.key === 'ArrowDown' ? 1 : -1, menuKeyOptions)
        if (next !== -1 && menuKeyOptions[next] !== undefined) {
          setMenuHighlightId(menuKeyOptions[next]!.id)
        }
        return
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        event.stopPropagation()
        const pool = enabledMenuIndices(menuKeyOptions)
        if (pool.length > 0) {
          const index = event.key === 'Home' ? pool[0]! : pool[pool.length - 1]!
          if (menuKeyOptions[index] !== undefined) setMenuHighlightId(menuKeyOptions[index]!.id)
        }
        return
      }
      if (event.key === 'Enter') {
        const id = menuHighlightId ?? newTabOptions[menuAnchorIndex(menuKeyOptions)]?.id
        if (id !== undefined && menuKeyOptions.find(option => option.id === id)?.disabled !== true) {
          event.preventDefault()
          event.stopPropagation()
          pickOption(id)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        return
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [menuOpen, menuKeyOptions, menuHighlightId, newTabOptions, onNewTab])

  // Unmount safety: no stale + menu marker if the strip disappears mid-open.
  useEffect(() => {
    return () => { setPlusMenuOpen(false) }
  }, [])

  /** Arm the two-step close on a bound stub (first click). */
  const armClose = (tabId: string): void => {
    if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current)
    setArmedCloseId(tabId)
    armedTimerRef.current = window.setTimeout(() => {
      armedTimerRef.current = null
      setArmedCloseId(null)
    }, ARMED_MS)
  }

  /** Disarm (any other interaction: tab click, menu open, unmount). */
  const disarmClose = (): void => {
    if (armedTimerRef.current !== null) {
      window.clearTimeout(armedTimerRef.current)
      armedTimerRef.current = null
    }
    setArmedCloseId(null)
  }

  useEffect(() => {
    return () => {
      if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current)
    }
  }, [])

  // Wheel over the strip scrolls the tab row horizontally (a plain mouse
  // wheel emits deltaY, which overflow-x alone never consumes). Bound as a
  // native NON-passive listener: React registers onWheel passively at the
  // root, where preventDefault() is a no-op. Modifier keys keep their native
  // meaning (shift = horizontal scroll, ctrl/cmd = zoom), and a strip that
  // does not overflow leaves the event alone so the page scrolls normally.
  useEffect(() => {
    const el = listRef.current
    if (el === null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
      if (el.scrollWidth <= el.clientWidth) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1
      el.scrollLeft += (event.deltaX + event.deltaY) * unit
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [])

  useEffect(() => {
    const clear = (): void => { setTabDragging(false); setDragOver(false) }
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [])

  // Partition: the session's own tabs first, the workspace-bound stubs
  // (pinned) behind a divider at the end — independent of array order.
  const boundIds = new Set(isBoundTabId === undefined ? [] : tabs.filter(tab => isBoundTabId(tab.id)).map(tab => tab.id))
  const sessionTabs = tabs.filter(tab => !boundIds.has(tab.id))
  const pinnedTabs = tabs.filter(tab => boundIds.has(tab.id))

  /** One tab element; `bound` renders the pinned variant (pin glyph,
   *  two-click close confirm, context-menu enabled — same close/activate
   *  wiring). Pinned tabs ARE draggable like any tab: the pin marks the
   *  window as workspace-shared, not as immovable — dragging a stub to
   *  another leaf or panel moves the shared window's per-session
   *  placement (reconcile only re-homes stubs that are missing entirely). */
  const renderTabEl = (tab: SidebarTab, bound: boolean): ReactNode => (
    <div
      key={tab.id}
      className={clsx(css.tab, active === tab.id && css.tabActive, bound && css.tabBound)}
      title={renaming === tab.id ? undefined : tab.title}
      draggable={renaming !== tab.id}
      onDragStart={(event) => {
        setTabDragging(true)
        event.dataTransfer.setData(TAB_DRAG_TYPE, serializeDrag({ tabId: tab.id, paneId }))
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => { setTabDragging(false); setDragOver(false) }}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setTabDragging(false)
        const raw = event.dataTransfer.getData(TAB_DRAG_TYPE)
        const payload = parseDrag(raw)
        if (payload !== null) onDropTab(payload, tab.id)
      }}
      onClick={() => {
        // Any tab activation disarms a pending close confirm.
        disarmClose()
        onActivate(tab.id)
      }}
      onAuxClick={(event) => {
        // Middle-click closes the tab (and suppresses autoscroll). Bound
        // stubs share the two-step confirm: the first middle-click arms.
        if (event.button === 1) {
          event.preventDefault()
          if (!bound) onClose(tab.id)
          else if (armedCloseId === tab.id) {
            disarmClose()
            onClose(tab.id)
          } else armClose(tab.id)
        }
      }}
      onContextMenu={(event) => {
        if (onTabContextMenu === undefined) return
        event.preventDefault()
        event.stopPropagation()
        disarmClose()
        onTabContextMenu(tab, event)
      }}
    >
      {getTabIcon?.(tab) ?? null}
      {bound && <IconPinOutline16 size={12} className={css.tabPin} />}
      {getTabBadge?.(tab) ?? null}
      {renaming === tab.id ? (
        <input
          ref={focusDraft}
          className={css.tabRename}
          value={draft}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            // IME composition: let Enter confirm the candidate text
            // instead of committing the draft mid-composition.
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename(tab, false)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              commitRename(tab, true)
            }
          }}
          onBlur={() => { commitRename(tab, false) }}
          onClick={(event) => { event.stopPropagation() }}
          onDoubleClick={(event) => { event.stopPropagation() }}
          onPointerDown={(event) => { event.stopPropagation() }}
          aria-label={t('renameTab')}
        />
      ) : (
        <span
          className={css.tabTitle}
          title={canRenameTab?.(tab) === true ? `${tab.title} · ${t('renameTabHint')}` : undefined}
          onDoubleClick={(event) => {
            if (canRenameTab?.(tab) !== true) return
            event.stopPropagation()
            startRename(tab)
          }}
        >
          {tab.title}
        </span>
      )}
      <Tooltip
        label={bound && armedCloseId === tab.id ? t('closeBoundConfirm') : t('close')}
        side="bottom"
        delayMs={500}
      >
        <button
          type="button"
          className={clsx(css.tabClose, bound && armedCloseId === tab.id && css.tabCloseArmed)}
          aria-label={bound && armedCloseId === tab.id ? t('closeBoundConfirm') : t('close')}
          onClick={(event) => {
            event.stopPropagation()
            // Bound stubs close EVERYWHERE (shared windows): the first click
            // arms a red confirm state, the second click really closes — an
            // accidental ✕ must never wipe the window from every session.
            if (!bound) {
              onClose(tab.id)
              return
            }
            if (armedCloseId === tab.id) {
              disarmClose()
              onClose(tab.id)
            } else {
              armClose(tab.id)
            }
          }}
        >
          <IconCloseFill14 />
        </button>
      </Tooltip>
    </div>
  )

  return (
    <div
      className={clsx(css.tabBar, dragOver && css.tabBarDrop)}
      onDragOver={(event) => {
        // The strip owns drops on itself (merge into this pane); stopping
        // propagation keeps the pane root from also running its edge-zone
        // handler on the same drop.
        event.preventDefault()
        event.stopPropagation()
        setDragOver(true)
      }}
      onDragLeave={() => { setDragOver(false) }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setDragOver(false)
        setTabDragging(false)
        const raw = event.dataTransfer.getData(TAB_DRAG_TYPE)
        const payload = parseDrag(raw)
        if (payload !== null) onDropTab(payload, null)
      }}
    >
      <div ref={listRef} className={css.tabList}>
        {sessionTabs.map(tab => renderTabEl(tab, false))}
        {pinnedTabs.length > 0 && <div className={css.tabBarDivider} role="separator" />}
        {pinnedTabs.map(tab => renderTabEl(tab, true))}
        {/*
          The + sits immediately after the rightmost tab (sticky at the
          right edge of the scrollport when the tabs overflow, so it stays
          reachable no matter how many tabs are open). Its menu keeps the
          app's standard Menu look; every row's label carries the digit +
          first-letter chips on its right (the 1-9 / letter shortcuts).
        */}
        <Menu
          open={menuOpen}
          onClose={closeMenu}
          selectedId={menuHighlightId ?? undefined}
          items={menuItems}
          footer={menuKeyOptions.length > 0
            ? [{ type: 'label' as const, id: 'keyboard-hint', text: t('menuKeyboardHint') }]
            : []}
          onSelect={pickOption}
          portal
          align="end"
          anchor={(
            <Tooltip label={t('newTab')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={css.tabBarPlus}
                aria-label={t('newTab')}
                aria-haspopup="menu"
                aria-expanded={menuOpen || undefined}
                onClick={() => { if (menuOpen) closeMenu(); else openMenu() }}
              >
                <IconPlusOutline16 />
              </button>
            </Tooltip>
          )}
        />
      </div>
    </div>
  )
}
