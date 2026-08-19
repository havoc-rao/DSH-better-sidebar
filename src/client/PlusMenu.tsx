/**
 * The + menu as a small custom portal dropdown (v0.14.0+). The sidebar owns
 * this surface completely because its KEYBOARD-FIRST contract needs exact
 * row layout: a digit chip (1…9, 0 = the 10th) and a first-letter chip on
 * the RIGHT of each option's name make the shortcuts visible at a glance —
 * the primitives Menu's internal row CSS is opaque/hashed, so it cannot
 * right-align chips reliably.
 *
 * Positioning mirrors the primitives Menu: fixed-position, portaled to
 * document.body, right-aligned under the + button, clamped to the viewport,
 * re-placed on scroll/resize while open. Outside pointer-down closes.
 * Keyboard handling stays in TabBar (document-capture while open) — this
 * component is pure presentation over the same state.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** One + menu option (label text + optional leading icon). */
export interface PlusMenuOption {
  id: string
  label: string
  disabled?: boolean
  icon?: ReactNode
}

/** The digit chip of one row (1…9, 0 = the 10th; '' beyond 10 options). */
export function plusMenuDigit(index: number): string {
  if (index <= 8) return String(index + 1)
  if (index === 9) return '0'
  return ''
}

/** The first-letter chip of one row (only when the typeahead can match:
 *  the label must start with an ASCII letter — CJK labels type via the IME,
 *  which the menu's key layer deliberately yields to). */
export function plusMenuLetter(label: string): string {
  const match = /^[a-z]/i.exec(label)
  return match === null ? '' : match[0].toUpperCase()
}

export function PlusMenu(props: {
  open: boolean
  /** The + button (position anchor). */
  anchor: React.RefObject<HTMLButtonElement | null>
  items: PlusMenuOption[]
  /** The keyboard/hover highlight (Enter picks it). */
  highlightId: string | null
  onSelect: (id: string) => void
  onHighlight: (id: string) => void
  onClose: () => void
}) {
  const { open, anchor, items, highlightId, onSelect, onHighlight, onClose } = props
  const listRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Measure + place (open, and re-place on scroll/resize while open). The
  // first open renders hidden at the origin so offset sizes are real.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = (): void => {
      const anchorEl = anchor.current
      const list = listRef.current
      if (anchorEl === null || list === null) return
      const rect = anchorEl.getBoundingClientRect()
      const MARGIN = 12
      const width = list.offsetWidth || 200
      const height = list.offsetHeight || 100
      let left = rect.right - width
      let top = rect.bottom + 4
      left = Math.min(Math.max(left, MARGIN), window.innerWidth - width - MARGIN)
      top = Math.min(Math.max(top, MARGIN), window.innerHeight - height - MARGIN)
      setPos(current => (current !== null && current.left === left && current.top === top ? current : { left, top }))
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchor, items, highlightId])

  // Outside pointer-down closes (the primitives Menu's equivalent).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (listRef.current?.contains(event.target) === true) return
      if (anchor.current?.contains(event.target) === true) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [open, anchor, onClose])

  if (!open) return null

  const list = (
    <div
      ref={listRef}
      className={css.plusMenu}
      role="menu"
      aria-orientation="vertical"
      style={pos === null ? { visibility: 'hidden', left: 0, top: 0 } : { left: pos.left, top: pos.top }}
    >
      <div className={css.plusMenuList}>
        {items.map((item, index) => {
          const active = item.id === highlightId
          const digit = plusMenuDigit(index)
          const letter = plusMenuLetter(item.label)
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={clsx(css.plusMenuItem, active && css.plusMenuItemActive, item.disabled === true && css.plusMenuItemDisabled)}
              disabled={item.disabled === true}
              onMouseEnter={() => { if (item.disabled !== true) onHighlight(item.id) }}
              onClick={() => { if (item.disabled !== true) onSelect(item.id) }}
            >
              {item.icon ?? null}
              <span className={css.plusMenuItemLabel}>{item.label}</span>
              {(digit !== '' || letter !== '') && (
                <span className={css.plusMenuKeys} aria-hidden="true">
                  {digit !== '' && <kbd className={css.plusMenuKey}>{digit}</kbd>}
                  {letter !== '' && <kbd className={css.plusMenuKey}>{letter}</kbd>}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {items.length > 0 && (
        <div className={css.plusMenuFooter} role="presentation">{t('menuKeyboardHint')}</div>
      )}
    </div>
  )

  return createPortal(list, document.body)
}