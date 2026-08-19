/**
 * + menu keyboard mapping tests (v0.14.0+): positional digits, letter-key
 * typeahead, highlight movement over the ENABLED pool, the row chips, and
 * the IME guard — the pure helpers the TabBar keydown layer wires together.
 */
import { describe, expect, it } from 'vitest'
import {
  enabledMenuIndices, isMenuImeComposition, menuAnchorIndex, menuDigitIndex, menuLetterMatches, menuMoveIndex,
  plusMenuDigit, plusMenuLetterOf,
  type MenuKeyOption,
} from '../src/client/menu-keys.ts'

const options: MenuKeyOption[] = [
  { id: 'editor', label: '文件', letter: plusMenuLetterOf('editor') },
  { id: 'git', label: '源代码管理', letter: plusMenuLetterOf('git') },
  { id: 'terminal', label: '终端', letter: plusMenuLetterOf('terminal') },
  { id: 'locked', label: 'Locked', letter: plusMenuLetterOf('locked'), disabled: true },
  { id: 'browser', label: '浏览器', letter: plusMenuLetterOf('browser') },
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

describe('menuLetterMatches — letter-key typeahead', () => {
  it('matches enabled options by their letter KEY (from the id, not the label)', () => {
    // Labels are CJK here — the letter key still resolves: editor→E, git→G…
    expect(menuLetterMatches(options, 'e')).toEqual([0])
    expect(menuLetterMatches(options, 'G')).toEqual([1])
    expect(menuLetterMatches(options, 't')).toEqual([2])
  })

  it('duplicate letter keys all match (the component cycles through them)', () => {
    const dup = [
      { id: 'my:db', label: 'DB', letter: 'M' },
      { id: 'my:docs', label: 'Docs', letter: 'M' },
    ]
    expect(menuLetterMatches(dup, 'm')).toEqual([0, 1])
  })

  it('skips disabled options and ignores non-letters / unknown letters', () => {
    expect(menuLetterMatches(options, 'l')).toEqual([]) // disabled row
    expect(menuLetterMatches(options, 's')).toEqual([]) // no option owns S
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
    expect(menuMoveIndex(-1, 1, [{ id: 'x', label: 'X', letter: 'X', disabled: true }])).toBe(-1)
  })
})

describe('menuAnchorIndex', () => {
  it('anchors on the first enabled option', () => {
    expect(menuAnchorIndex(options)).toBe(0)
    expect(menuAnchorIndex([{ id: 'x', label: 'X', letter: 'X', disabled: true }])).toBe(-1)
  })
})

describe('isMenuImeComposition', () => {
  it('reuses the IME guard rule', () => {
    expect(isMenuImeComposition({ isComposing: true, keyCode: 0 })).toBe(true)
    expect(isMenuImeComposition({ isComposing: false, keyCode: 229 })).toBe(true)
    expect(isMenuImeComposition({ isComposing: false, keyCode: 0 })).toBe(false)
  })
})

describe('plusMenuDigit / plusMenuLetterOf — the row chips', () => {
  it('digits name positions 1…9 and 0 for the 10th; nothing beyond', () => {
    expect(plusMenuDigit(0)).toBe('1')
    expect(plusMenuDigit(8)).toBe('9')
    expect(plusMenuDigit(9)).toBe('0')
    expect(plusMenuDigit(10)).toBe('')
  })

  it('the letter chip is the stable id\'s first ASCII letter (uppercase)', () => {
    expect(plusMenuLetterOf('terminal')).toBe('T')
    expect(plusMenuLetterOf('git')).toBe('G')
    expect(plusMenuLetterOf('my-plugin:db')).toBe('M')
  })

  it('CJK labels still get a chip — the letter comes from the id, not the label', () => {
    expect(plusMenuLetterOf('terminal')).toBe('T') // label 「终端」→ still T
    expect(plusMenuLetterOf('subagent')).toBe('S') // label 「任务管理」→ still S
  })

  it('ids starting with a non-letter get no letter chip', () => {
    expect(plusMenuLetterOf('1password')).toBe('')
    expect(plusMenuLetterOf('_internal')).toBe('')
  })
})