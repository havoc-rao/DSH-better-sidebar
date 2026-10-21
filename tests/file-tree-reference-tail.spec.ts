/**
 * Reference actions overlay the bounded file-tree row at its trailing edge.
 * Neither the reference button nor the copied label reserves filename width;
 * built-in and provider render paths share the same positioning contract.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/sidebar.module.css', 'utf8')

describe('FileTree @-reference row tail', () => {
  it('overlays both mutually-exclusive reference affordances at the row edge', () => {
    const rule = css.match(/\.explorerRef,\s*\.explorerRow > \.explorerCopied\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(rule).toBeDefined()
    expect(rule).not.toMatch(/margin-left:/)
    expect(rule).toMatch(/position:\s*absolute/)
    expect(rule).toMatch(/right:\s*8px/)
    expect(rule).toMatch(/top:\s*50%/)
    const provider = css.match(/\.explorerTree > div > span:has\(> \.explorerCopied\)\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(provider).toBeDefined()
    expect(provider).toMatch(/position:\s*absolute/)
    expect(provider).toMatch(/right:\s*8px/)
  })
})
