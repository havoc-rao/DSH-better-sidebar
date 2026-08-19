/**
 * Files-search keyboard model tests (v0.14.0+): the pure decision mapping of
 * the search box — arrows move a highlight (wrap-around), Enter opens,
 * Escape clears/blur, composition yields.
 */
import { describe, expect, it } from 'vitest'
import { clampSearchIndex, searchKeyAction } from '../src/client/search-keys.ts'

function key(key: string, isComposing = false, keyCode = 0): { key: string; isComposing: boolean; keyCode: number } {
  return { key, isComposing, keyCode }
}

describe('searchKeyAction', () => {
  it('ArrowDown moves the highlight forward and wraps around', () => {
    expect(searchKeyAction(key('ArrowDown'), 'app', 3, 0)).toEqual({ type: 'move', index: 1 })
    expect(searchKeyAction(key('ArrowDown'), 'app', 3, 2)).toEqual({ type: 'move', index: 0 })
  })

  it('ArrowUp moves the highlight backward and wraps around', () => {
    expect(searchKeyAction(key('ArrowUp'), 'app', 3, 1)).toEqual({ type: 'move', index: 0 })
    expect(searchKeyAction(key('ArrowUp'), 'app', 3, 0)).toEqual({ type: 'move', index: 2 })
  })

  it('arrows with no results fall through (the input keeps its native behavior)', () => {
    expect(searchKeyAction(key('ArrowDown'), 'app', 0, 0)).toEqual({ type: 'none' })
    expect(searchKeyAction(key('ArrowUp'), '', 0, 0)).toEqual({ type: 'none' })
  })

  it('Enter opens the clamped active result', () => {
    expect(searchKeyAction(key('Enter'), 'app', 5, 1)).toEqual({ type: 'open', index: 1 })
    // A stale out-of-range highlight is clamped, never out-of-bounds.
    expect(searchKeyAction(key('Enter'), 'app', 2, 99)).toEqual({ type: 'open', index: 1 })
  })

  it('Enter with no results falls through', () => {
    expect(searchKeyAction(key('Enter'), 'app', 0, 0)).toEqual({ type: 'none' })
  })

  it('Escape clears a non-empty query and blurs an empty one', () => {
    expect(searchKeyAction(key('Escape'), 'app', 4, 0)).toEqual({ type: 'clear' })
    expect(searchKeyAction(key('Escape'), '   ', 0, 0)).toEqual({ type: 'blur' })
    expect(searchKeyAction(key('Escape'), '', 0, 0)).toEqual({ type: 'blur' })
  })

  it('IME composition keys belong to the input method, never the list', () => {
    expect(searchKeyAction(key('ArrowDown', true), 'app', 3, 0)).toEqual({ type: 'none' })
    expect(searchKeyAction(key('Enter', true), 'app', 3, 0)).toEqual({ type: 'none' })
  })

  it('every other key (letters, Tab, Home, ...) falls through', () => {
    expect(searchKeyAction(key('a'), 'ap', 3, 0)).toEqual({ type: 'none' })
    expect(searchKeyAction(key('Tab'), 'app', 3, 0)).toEqual({ type: 'none' })
    expect(searchKeyAction(key('Home'), 'app', 3, 0)).toEqual({ type: 'none' })
  })
})

describe('clampSearchIndex', () => {
  it('clamps into range and round-trips zero-count lists', () => {
    expect(clampSearchIndex(5, 3)).toBe(2)
    expect(clampSearchIndex(-1, 3)).toBe(0)
    expect(clampSearchIndex(0, 0)).toBe(0)
  })
})