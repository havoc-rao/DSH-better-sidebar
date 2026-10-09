/**
 * The @-reference button and its transient copied label share a file-tree
 * row with a filename that may be far wider than the panel. Both need the
 * row's only auto margin so a short filename cannot leave the affordance
 * stranded in the middle, and both must stay reachable once the wide content
 * column scrolls: `sticky right` pins them to the scrollport edge instead of
 * riding the row's (off-screen) end.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/sidebar.module.css', 'utf8')

describe('FileTree @-reference row tail', () => {
  it('anchors both mutually-exclusive reference affordances after a short filename', () => {
    const rule = css.match(/\.explorerRef,\s*\.explorerCopied\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(rule).toBeDefined()
    expect(rule).toMatch(/margin-left:\s*auto/)
    expect(rule).toMatch(/position:\s*sticky/)
    expect(rule).toMatch(/right:\s*0/)
  })
})
