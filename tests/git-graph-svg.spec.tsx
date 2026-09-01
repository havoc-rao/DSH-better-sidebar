/**
 * GitGraphSvg coloring: a ref-classified row (see git-graph.ts refKindOf)
 * renders its commit DOT and every EDGE of the row in the local/remote
 * color instead of the per-column lane palette — local-branch rows green
 * (`var(--gg-local)`), fetch-only remote-tracking rows blue
 * (`var(--gg-remote)`), neutral rows (tags / undecorated ancestors) keep
 * the lane palette. The divergence shows on the lane itself: the vertical
 * segments re-tint where the classification changes.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { GitGraphEntry } from '../src/client/api.ts'
import { GitGraphSvg } from '../src/client/GitGraph.tsx'
import { computeGraphRows, type GitGraphRow } from '../src/client/git-graph.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function commit(hash: string, parents: string[], refs = ''): GitGraphEntry {
  return {
    hash,
    hashFull: hash,
    subject: `commit ${hash}`,
    author: 'Alice',
    date: '2024-01-01 00:00:00 +0000',
    refs,
    parents,
  }
}

/** Render one row (with its previous row above, when given) and return the
 *  stroke colors of every SVG edge plus the dot's inline background. */
function renderRow(entry: GitGraphEntry, prevEntry?: GitGraphEntry, watched = false): {
  strokes: string[]
  dotBackground: string
  dotBoxShadow: string
} {
  const entries = prevEntry === undefined ? [entry] : [prevEntry, entry]
  const layout = computeGraphRows(entries)
  const row: GitGraphRow = layout.rows[layout.rows.length - 1]!
  const prev: GitGraphRow | undefined = layout.rows.length > 1 ? layout.rows[0] : undefined
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  try {
    act(() => {
      root.render(createElement(GitGraphSvg, { row, prev, graphWidth: layout.graphWidth, watched }))
    })
    // Every lane path carries an explicit stroke (the SVG is aria-hidden and
    // never inherits one), so null would mean a rendering regression.
    const strokes = [...container.querySelectorAll('path')]
      .map(path => path.getAttribute('stroke') ?? '')
    const dot = container.querySelector<HTMLElement>('[class*="gitLogDot"]')
    if (dot === null) throw new Error('git log dot not rendered')
    return { strokes, dotBackground: dot.style.background, dotBoxShadow: dot.style.boxShadow }
  } finally {
    act(() => { root.unmount() })
    container.remove()
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('GitGraphSvg local/remote coloring', () => {
  const localTip = commit('c1', ['c2'], 'HEAD -> refs/heads/main')
  const remoteTip = commit('c2', ['c3'], 'refs/remotes/origin/main')
  // A neutral row WITH a parent: the lane below it is what keeps the palette.
  const shared = commit('c3', ['c4'], 'tag: refs/tags/v1')

  it('renders a local-branch row (dot + edges) in the local green', () => {
    const { strokes, dotBackground } = renderRow(localTip, shared)
    expect(strokes).toEqual(['var(--gg-local)', 'var(--gg-local)'])
    expect(dotBackground).toBe('var(--gg-local)')
  })

  it('renders a fetch-only remote row in the remote blue', () => {
    const { strokes, dotBackground } = renderRow(remoteTip, localTip)
    expect(strokes.length).toBeGreaterThan(0)
    expect(strokes.every(stroke => stroke === 'var(--gg-remote)')).toBe(true)
    expect(dotBackground).toBe('var(--gg-remote)')
  })

  it('keeps neutral rows (tag-only / undecorated) on the column palette', () => {
    const { strokes, dotBackground } = renderRow(shared)
    expect(strokes).toEqual(['var(--gg-lane-0)'])
    expect(dotBackground).toBe('var(--gg-lane-0)')
  })

  it('rings the dot when a watched (重点关注) branch points at the commit', () => {
    const { dotBoxShadow } = renderRow(localTip, shared, true)
    expect(dotBoxShadow).toContain('var(--gg-watched)')
    // No ring without the watched flag.
    const plain = renderRow(localTip, shared)
    expect(plain.dotBoxShadow).toBe('')
  })
})