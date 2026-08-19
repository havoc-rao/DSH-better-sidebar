/**
 * Pure matching for the + menu keyboard shortcuts (v0.14.0+). The menu is
 * opened by clicking (or focusing) the + button; a document-capture
 * keydown handler in TabBar maps the pressed key to an option here:
 *
 * - `1`…`9`, `0` select the 1st…9th, 10th option (positional); disabled
 *   options are skipped by cycling to the next enabled one;
 * - letters select the first ENABLED option whose label starts with the
 *   letter (re-pressing the same letter cycles to the next match — handled
 *   by the component through {@link menuLetterMatches});
 * - arrows / Home / End move a highlight (`selectedId`); Enter selects it.
 *
 * Everything here is a pure function over the option list — unit-testable
 * without rendering the dropdown.
 */
import { isImeComposition } from './ime-guard.ts'

/** The keyboard-relevant slice of a + menu option. */
export interface MenuKeyOption {
  id: string
  label: string
  disabled?: boolean
}

/** The enabled options' indices (the navigation pool). */
export function enabledMenuIndices(options: readonly MenuKeyOption[]): number[] {
  return options
    .map((option, index) => (option.disabled === true ? -1 : index))
    .filter(index => index !== -1)
}

/** A positional digit press (1…9, 0 = 10th) → the option index it names,
 *  or null when the position is out of range. The caller still skips
 *  disabled options (cycling to the next enabled one). */
export function menuDigitIndex(options: readonly MenuKeyOption[], digit: number): number | null {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) return null
  const position = digit === 0 ? 9 : digit - 1
  return position < options.length ? position : null
}

/** The enabled option indices whose label starts with `letter`
 *  (case-insensitive, ASCII letters only — punctuation keys fall through). */
export function menuLetterMatches(options: readonly MenuKeyOption[], letter: string): number[] {
  if (!/^[a-z]$/i.test(letter)) return []
  const lower = letter.toLowerCase()
  const matches: number[] = []
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]!
    if (option.disabled === true) continue
    if (option.label.toLowerCase().startsWith(lower)) matches.push(index)
  }
  return matches
}

/** Move a highlight index by `delta` inside the ENABLED pool (wrap-around). */
export function menuMoveIndex(current: number, delta: number, options: readonly MenuKeyOption[]): number {
  const pool = enabledMenuIndices(options)
  if (pool.length === 0) return -1
  const at = pool.indexOf(current)
  const next = at === -1 ? 0 : (at + delta + pool.length) % pool.length
  return pool[next]!
}

/** Clamp an index into the enabled pool (first enabled option fallback). */
export function menuAnchorIndex(options: readonly MenuKeyOption[]): number {
  const pool = enabledMenuIndices(options)
  return pool.length === 0 ? -1 : pool[0]!
}

/** A composition signal check (reuses the IME guard's rule). */
export function isMenuImeComposition(event: { isComposing: boolean; keyCode: number }): boolean {
  return isImeComposition(event)
}