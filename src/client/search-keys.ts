/**
 * Pure decision mapping for the files SEARCH box keyboard navigation
 * (v0.14.0+). The onKeyDown handler of the search input asks this module
 * what a key means; the component applies the action (move the highlight /
 * open / clear / blur). Kept DOM-free so the whole model is unit-testable
 * without rendering the panel.
 *
 * Model (type-ahead style, like a quick-open list):
 * - ArrowDown / ArrowUp move the highlighted result (wrap-around);
 * - Enter opens the highlighted result (first when the highlight is stale);
 * - Escape clears the query (returns to the tree); an already-empty query
 *   blurs the input;
 * - every other key falls through untouched — the input keeps its native
 *   caret/editing behavior while the 300ms debounce updates the list.
 */
import { isImeComposition } from './ime-guard.ts'

/** One decided action of the search keyboard model. */
export type SearchKeyAction =
  /** Move the highlight to `index` (a wrap-around move). */
  | { type: 'move'; index: number }
  /** Open the result at `index` (Enter). */
  | { type: 'open'; index: number }
  /** Escape: empty the query (the tree returns). */
  | { type: 'clear' }
  /** Escape on an empty query: leave the input. */
  | { type: 'blur' }
  /** The key belongs to the input (or does nothing here) — leave it alone. */
  | { type: 'none' }

/** Normalize an active index into a valid result range. */
export function clampSearchIndex(index: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(count - 1, Math.max(0, Math.round(index)))
}

/**
 * The pure decision for one keydown on the search input.
 * @param event - the key event (key/ctrl/meta/alt/shift + composition flags).
 * @param query - the current query text (non-empty trims to `needle`).
 * @param resultCount - the current result list length (0 = no results yet).
 * @param activeIndex - the highlighted result index (clamped internally).
 */
export function searchKeyAction(
  event: { key: string; isComposing: boolean; keyCode: number },
  query: string,
  resultCount: number,
  activeIndex: number,
): SearchKeyAction {
  // Composition keys (candidate arrows, confirm, cancel) belong to the IME.
  if (isImeComposition(event)) return { type: 'none' }
  // The arrows navigate the RESULT LIST; a focused input with no query and
  // no results leaves the event alone.
  if (event.key === 'ArrowDown') {
    if (resultCount <= 0) return { type: 'none' }
    return { type: 'move', index: (clampSearchIndex(activeIndex, resultCount) + 1) % resultCount }
  }
  if (event.key === 'ArrowUp') {
    if (resultCount <= 0) return { type: 'none' }
    const current = clampSearchIndex(activeIndex, resultCount)
    return { type: 'move', index: (current - 1 + resultCount) % resultCount }
  }
  if (event.key === 'Enter') {
    if (resultCount <= 0) return { type: 'none' }
    return { type: 'open', index: clampSearchIndex(activeIndex, resultCount) }
  }
  if (event.key === 'Escape') {
    return query.trim() === '' ? { type: 'blur' } : { type: 'clear' }
  }
  return { type: 'none' }
}