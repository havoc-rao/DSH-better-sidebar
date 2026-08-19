/**
 * Pure matching for the + menu keyboard shortcuts (v0.14.0+). The menu is
 * opened by clicking (or focusing) the + button; a document-capture
 * keydown handler in TabBar maps the pressed key to an option here:
 *
 * - `1`…`9`, `0` select the 1st…9th, 10th option (positional); disabled
 *   options are skipped by cycling to the next enabled one;
 * - letters select the first ENABLED option whose **letter key** matches
 *   (re-pressing the same letter cycles to the next match — handled by the
 *   component through {@link menuLetterMatches}). The letter key comes from
 *   the option's STABLE id (`terminal` → T, `git` → G, …), never from the
 *   label: labels are localized (CJK labels like 终端 have no ASCII first
 *   letter), while ids are always ASCII — so the chip shown on the row and
 *   the key the user presses always agree, in every language.
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
  /** The typeahead letter key (derived from the id — see above). */
  letter: string
  disabled?: boolean
}

/** The digit chip of one row (1…9, 0 = the 10th; '' beyond 10 options). */
export function plusMenuDigit(index: number): string {
  if (index <= 8) return String(index + 1)
  if (index === 9) return '0'
  return ''
}

/** The letter chip / typeahead key of one option: the first ASCII letter of
 *  its stable id (`terminal` → 'T'). Empty when the id starts with a
 *  non-letter (numeric/underscore prefixes) — that row gets no letter chip
 *  and no letter typeahead. */
export function plusMenuLetterOf(id: string): string {
  const match = /^[a-z]/i.exec(id)
  return match === null ? '' : match[0].toUpperCase()
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

/** The enabled option indices whose LETTER KEY equals `letter`
 *  (case-insensitive, ASCII letters only — punctuation keys fall through).
 *  Duplicate letters (two plugins sharing an id prefix) both match; the
 *  component cycles through them on repeated presses. */
export function menuLetterMatches(options: readonly MenuKeyOption[], letter: string): number[] {
  if (!/^[a-z]$/i.test(letter)) return []
  const lower = letter.toLowerCase()
  const matches: number[] = []
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]!
    if (option.disabled === true) continue
    if (option.letter.toLowerCase() === lower) matches.push(index)
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