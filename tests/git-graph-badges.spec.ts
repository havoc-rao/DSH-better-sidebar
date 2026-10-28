/** Graph ref styling contract: soft theme-backed badges, readable text, and
 * shrink/ellipsis containment without changing the virtualizer's 28px rows.
 * jsdom has no layout; these assertions guard the sizing/paint declarations,
 * while git-graph-ui.spec.tsx covers the actual ref names and native tooltips. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/client/changes/graph.module.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
function rule(selector: string): string {
  const block = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(match => match[1]!.trim() === selector)?.[2]
  if (block === undefined) throw new Error(`Missing graph style: ${selector}`)
  return block
}

describe('graph ref badge styling', () => {
  it('uses rounded soft fills instead of high-contrast outlines, with distinct kind emphasis', () => {
    const badge = rule('.ref')
    expect(badge).toContain('border: 0;')
    expect(badge).toContain('border-radius: 6px;')
    expect(badge).toContain('height: 20px;')
    expect(badge).toContain('box-sizing: border-box;')
    expect(badge).toContain('font: var(--dsw-font-xxs-12);')
    expect(badge).toContain('currentColor 10%, var(--dsw-alias-bg-base)')
    expect(rule('.ref[data-tone="head"]')).toContain('currentColor 20%')
    expect(rule('.ref[data-tone="head"]')).toContain('var(--dsw-font-xxs-strong-12)')
    expect(rule('.ref[data-tone="remote"]')).toContain('currentColor 5%')
    expect(rule('.ref[data-tone="tag"]')).toContain('color: var(--dsw-alias-label-secondary)')
    expect(rule('.ref[data-tone="tag"]')).toContain('background: var(--dsw-alias-interactive-bg-hover)')
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(/i)
  })

  it('allows both the group and long badges to shrink while retaining the fixed row height', () => {
    expect(rule('.row')).toContain('height: 28px;')
    for (const selector of ['.refs', '.ref']) {
      expect(rule(selector)).toContain('flex: 0 1 auto;')
      expect(rule(selector)).toContain('min-width: 0;')
      expect(rule(selector)).toContain('overflow: hidden;')
    }
    expect(rule('.refs')).toContain('max-width: 50%;')
    expect(rule('.ref')).toContain('max-width: min(180px, 100%);')
    expect(rule('.refName')).toContain('text-overflow: ellipsis;')
    expect(rule('.refName')).toContain('white-space: nowrap;')
    expect(rule('.subject')).toContain('min-width: 0;')
  })
})
