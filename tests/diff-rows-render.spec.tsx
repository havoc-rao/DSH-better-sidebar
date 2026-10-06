// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DiffRows } from '../src/client/diff/DiffRows.tsx'
import { coalesceInline, diffInline, type DiffSegment } from '../src/client/diff/rows.ts'
import css from '../src/client/diff/diff.module.css'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

describe('DiffRows inline syntax rendering', () => {
  it.each([
    {
      name: 'colored tokens around a changed number',
      pairs: [
        ['const value = 10; return value + 20', 'const value = 12; return value + 20'],
        ['const value = 100; return value + 20', 'const value = 123; return value + 20'],
      ],
      comment: false,
    },
    {
      name: 'block-comment state across changed and unchanged runs',
      pairs: [
        ['const value = /* before old after */ 42;', 'const value = /* before new after */ 42;'],
        ['const value = /* before older after */ 42;', 'const value = /* before newer after */ 42;'],
      ],
      comment: true,
    },
  ])('keeps unique sibling keys and highlights on mount/update: $name', ({ pairs, comment }) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const keyWarnings = () => errors.mock.calls.filter(args =>
      args.some(arg => typeof arg === 'string' && /Encountered two children with the same key/.test(arg)),
    )
    try {
      for (const pair of pairs) {
        const [oldText, newText] = pair as [string, string]
        const inline = diffInline(oldText, newText)
        const sides = [coalesceInline(inline.old), coalesceInline(inline.next)]
        // Exercise multiple independently scanned runs on BOTH sides.
        for (const side of sides) {
          expect(side.map(seg => seg.changed)).toEqual([false, true, false])
        }
        const segments: DiffSegment[] = [{ kind: 'hunk', rows: [
          { kind: 'mod', oldLine: 1, text: oldText },
          { kind: 'mod', newLine: 1, text: newText },
        ] }]
        act(() => { root.render(createElement(DiffRows, { segments, lang: 'ts' })) })
        const rows = container.querySelectorAll('[data-kind="mod"]')
        expect(rows).toHaveLength(2)
        rows.forEach((row, index) => {
          const text = row.querySelector(`.${css.text}`)!
          expect(text.textContent).toBe(pair[index])
          const changes = [...text.querySelectorAll(`.${css.inlineChange}`)]
          expect(changes.map(span => span.textContent).join('')).toBe(
            sides[index]!.filter(seg => seg.changed).map(seg => seg.text).join(''),
          )
          expect(text.querySelector(`.${css.tokKeyword}`)?.textContent).toBe('const')
          expect(text.querySelector(`.${css.tokNumber}`)).not.toBeNull()
          if (comment) {
            expect(changes.every(span => span.classList.contains(css.tokComment!))).toBe(true)
            expect([...text.querySelectorAll(`.${css.tokComment}`)].map(span => span.textContent).join(''))
              .toBe(pair[index]!.match(/\/\*.*?\*\//)![0])
          }
        })
        // Check after every render so a bad mount cannot corrupt reconciliation
        // and obscure the original warning with a later text mismatch.
        expect(keyWarnings()).toEqual([])
      }
    } finally {
      act(() => { root.unmount() })
      errors.mockRestore()
      container.remove()
    }
  })
})
