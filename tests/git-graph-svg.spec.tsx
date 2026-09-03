/**
 * GitGraphSvg rendering: the graph geometry NEVER re-tints for local/remote
 * refs — every edge and the dot keep the per-column lane palette
 * (`var(--gg-lane-N)`). The local/remote story lives on the history ROW
 * itself (left border + faint background, applied by GitView from
 * `GitGraphRow.kind`), because tinting lanes drowns in multi-branch
 * histories. The watched (重点关注) ring is the only per-row SVG accent.
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
  kind: GitGraphRow['kind']
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
    return { strokes, dotBackground: dot.style.background, dotBoxShadow: dot.style.boxShadow, kind: row.kind }
  } finally {
    act(() => { root.unmount() })
    container.remove()
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('GitGraphSvg row-kind behavior', () => {
  const localTip = commit('c1', ['c2'], 'HEAD -> refs/heads/main')
  const remoteTip = commit('c2', ['c3'], 'refs/remotes/origin/main')
  // A neutral row WITH a parent: the lane below it is what keeps the palette.
  const shared = commit('c3', ['c4'], 'tag: refs/tags/v1')

  it('classifies each row (local/remote/neutral) for the GitView row marking', () => {
    expect(renderRow(localTip, shared).kind).toBe('local')
    expect(renderRow(remoteTip, localTip).kind).toBe('remote')
    expect(renderRow(shared).kind).toBe('neutral')
  })

  it('keeps the lane palette on a local-branch row (no graph re-tinting)', () => {
    const { strokes, dotBackground } = renderRow(localTip, shared)
    expect(strokes.every(stroke => stroke.startsWith('var(--gg-lane-'))).toBe(true)
    expect(dotBackground.startsWith('var(--gg-lane-')).toBe(true)
  })

  it('keeps the lane palette on a fetch-only remote row', () => {
    const { strokes, dotBackground } = renderRow(remoteTip, localTip)
    expect(strokes.length).toBeGreaterThan(0)
    expect(strokes.some(stroke => stroke.startsWith('var(--gg-lane-'))).toBe(true)
    expect(strokes.some(stroke => stroke === 'var(--gg-local)' || stroke === 'var(--gg-remote)')).toBe(false)
    expect(dotBackground.startsWith('var(--gg-lane-')).toBe(true)
  })

  it('keeps neutral rows (tag-only / undecorated) on the column palette', () => {
    const { strokes, dotBackground } = renderRow(shared)
    expect(strokes.every(stroke => stroke.startsWith('var(--gg-lane-'))).toBe(true)
    expect(dotBackground.startsWith('var(--gg-lane-')).toBe(true)
  })

  it('rings the dot when a watched (重点关注) branch points at the commit', () => {
    const { dotBoxShadow } = renderRow(localTip, shared, true)
    expect(dotBoxShadow).toContain('var(--gg-watched)')
    // No ring without the watched flag.
    const plain = renderRow(localTip, shared)
    expect(plain.dotBoxShadow).toBe('')
  })
})