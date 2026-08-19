/**
 * + menu keyboard mapping tests (v0.14.0+): positional digits, first-letter
 * typeahead, highlight movement over the ENABLED pool, and the IME guard —
 * the pure helpers the TabBar keydown layer wires together.
 */
import { describe, expect, it } from 'vitest'
import {
  enabledMenuIndices, isMenuImeComposition, menuAnchorIndex, menuDigitIndex, menuLetterMatches, menuMoveIndex,
  type MenuKeyOption,
} from '../src/client/menu-keys.ts'
import { plusMenuDigit, plusMenuLetter } from '../src/client/PlusMenu.tsx'

const options: MenuKeyOption[] = [
  { id: 'files', label: 'Files' },
  { id: 'git', label: 'Source Control' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'locked', label: 'Locked', disabled: true },
  { id: 'browser', label: 'Browser' },
]

describe('enabledMenuIndices', () => {
  it('lists only the non-disabled rows (the navigation pool)', () => {
    expect(enabledMenuIndices(options)).toEqual([0, 1, 2, 4])
  })
})

describe('menuDigitIndex — positional selection', () => {
  it('1…9 name the 1st…9th option, 0 names the 10th', () => {
    expect(menuDigitIndex(options, 1)).toBe(0)
    expect(menuDigitIndex(options, 3)).toBe(2)
    expect(menuDigitIndex(options, 4)).toBe(3)
  })

  it('a digit past the list length names nothing', () => {
    expect(menuDigitIndex(options, 9)).toBeNull()
    expect(menuDigitIndex(options, 0)).toBeNull() // only 5 options — no 10th
  })

  it('invalid digits name nothing', () => {
    expect(menuDigitIndex(options, -1)).toBeNull()
    expect(menuDigitIndex(options, 10)).toBeNull()
  })
})

describe('menuLetterMatches — first-letter typeahead', () => {
  it('matches enabled options whose label starts with the letter (case-insensitive)', () => {
    expect(menuLetterMatches(options, 'f')).toEqual([0])
    expect(menuLetterMatches(options, 'T')).toEqual([2])
    expect(menuLetterMatches(options, 's')).toEqual([1])
  })

  it('skips disabled options and ignores non-letters', () => {
    expect(menuLetterMatches(options, 'l')).toEqual([]) // disabled
    expect(menuLetterMatches(options, '1')).toEqual([])
    expect(menuLetterMatches(options, '/')).toEqual([])
  })
})

describe('menuMoveIndex — highlight movement', () => {
  it('moves within the enabled pool only, wrapping around', () => {
    expect(menuMoveIndex(0, 1, options)).toBe(1)
    expect(menuMoveIndex(2, 1, options)).toBe(4) // skips the disabled row
    expect(menuMoveIndex(4, 1, options)).toBe(0) // wrap
    expect(menuMoveIndex(0, -1, options)).toBe(4) // backward wrap
  })

  it('a stale highlight anchors on the first enabled option', () => {
    expect(menuMoveIndex(-1, 1, options)).toBe(0)
    expect(menuMoveIndex(-1, -1, options)).toBe(0)
  })

  it('an all-disabled menu has no movable highlight', () => {
    expect(menuMoveIndex(-1, 1, [{ id: 'x', label: 'X', disabled: true }])).toBe(-1)
  })
})

describe('menuAnchorIndex', () => {
  it('anchors on the first enabled option', () => {
    expect(menuAnchorIndex(options)).toBe(0)
    expect(menuAnchorIndex([{ id: 'x', label: 'X', disabled: true }])).toBe(-1)
  })
})

describe('isMenuImeComposition', () => {
  it('reuses the IME guard rule', () => {
    expect(isMenuImeComposition({ isComposing: true, keyCode: 0 })).toBe(true)
    expect(isMenuImeComposition({ isComposing: false, keyCode: 229 })).toBe(true)
    expect(isMenuImeComposition({ isComposing: false, keyCode: 0 })).toBe(false)
  })
})

describe('plusMenuDigit / plusMenuLetter — the row chips', () => {
  it('digits name positions 1…9 and 0 for the 10th; nothing beyond', () => {
    expect(plusMenuDigit(0)).toBe('1')
    expect(plusMenuDigit(8)).toBe('9')
    expect(plusMenuDigit(9)).toBe('0')
    expect(plusMenuDigit(10)).toBe('')
  })

  it('the letter chip is the label\'s first ASCII letter (uppercase)', () => {
    expect(plusMenuLetter('Files')).toBe('F')
    expect(plusMenuLetter('terminal')).toBe('T')
  })

  it('non-ASCII-leading labels (CJK) get no letter chip — the IME owns those keys', () => {
    expect(plusMenuLetter('任务管理')).toBe('')
    expect(plusMenuLetter('后台任务')).toBe('')
  })
})