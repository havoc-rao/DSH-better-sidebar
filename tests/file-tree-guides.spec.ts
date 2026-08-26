/**
 * FileTree indent-guide tests: the `treeGuideBackground` painter emits a
 * VSCode-style background layer set — one vertical stroke per expanded
 * ancestor column (root at x=6), plus the horizontal corner segment on
 * expanded directory rows only. Geometry must track the row padding formula
 * (depth * 22 + 6) so the strokes line up under the ancestor icons; the
 * root row (depth 0) draws nothing.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { api, type FsEntry } from '../src/client/api.ts'
import { FileTree, treeGuideBackground } from '../src/client/FileTree.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const file = (name: string, path: string): FsEntry =>
  ({ name, path, isDir: false, hidden: false, isSymlink: false, broken: false })
const dir = (name: string, path: string): FsEntry =>
  ({ name, path, isDir: true, hidden: false, isSymlink: false, broken: false })

// Gradient strings contain commas inside color-mix(...), so count layers by
// their `linear-gradient(` opener rather than splitting on commas.
const layerCount = (guides: ReturnType<typeof treeGuideBackground>): number =>
  (guides.backgroundImage ?? '').match(/linear-gradient\(/g)?.length ?? 0

const branchCount = (guides: ReturnType<typeof treeGuideBackground>, branch: string): number =>
  (guides.backgroundImage ?? '').match(new RegExp(`linear-gradient\\(${branch}`, 'g'))?.length ?? 0

describe('treeGuideBackground', () => {
  it('draws nothing for the root row (depth 0)', () => {
    expect(treeGuideBackground(0, true)).toEqual({})
    expect(treeGuideBackground(0, false)).toEqual({})
  })

  it('draws one vertical stroke per ancestor column, aligned under the icons', () => {
    const guides = treeGuideBackground(2, false)
    const image = guides.backgroundImage ?? ''
    // Ancestor columns at x = k*22 + 6: the root's column (6) and the
    // depth-1 dir's column (28). The row's own column (50) is NOT a guide.
    expect(image).toContain('transparent 6px')
    expect(image).toContain('transparent 28px')
    expect(image).not.toContain('transparent 50px')
    expect(layerCount(guides)).toBe(2)
    expect(branchCount(guides, '90deg')).toBe(2)
    expect(branchCount(guides, '0deg')).toBe(0)
  })

  it('adds the horizontal corner only on expanded directory rows', () => {
    const dir = treeGuideBackground(1, true)
    const file = treeGuideBackground(1, false)
    expect(layerCount(dir)).toBe(2) // corner + the root-level vertical
    expect(layerCount(file)).toBe(1)
    expect(branchCount(dir, '0deg')).toBe(1) // the corner
    expect(branchCount(file, '0deg')).toBe(0)
  })

  it('spans the corner across the deepest indent column at mid-height', () => {
    const guides = treeGuideBackground(2, true)
    // Corner box: 22px wide, positioned from the depth-1 column (28) to the
    // row's own icon column (50), horizontal stroke at the 34px row center.
    expect(guides.backgroundSize).toContain('22px 100%')
    expect(guides.backgroundPosition).toContain('28px 0')
    expect(guides.backgroundImage).toContain('transparent 16.5px')
    expect(guides.backgroundImage).toContain('transparent 17.5px')
  })

  it('applies the same quiet stroke to every layer (token-driven, no hardcoded color)', () => {
    const guides = treeGuideBackground(3, true)
    const stroke = 'color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent)'
    expect(guides.backgroundImage).toContain(stroke)
    expect(branchCount(guides, '90deg')).toBe(3)
    expect(branchCount(guides, '0deg')).toBe(1)
  })
})

describe('FileTree row rendering', () => {
  it('paints the guides onto rendered rows: corner on expanded dirs, verticals elsewhere', async () => {
    vi.spyOn(api, 'fsTree').mockImplementation(async (_scope, path) => {
      if (path === '/repo') {
        return { path, entries: [dir('src', '/repo/src'), file('README.md', '/repo/README.md')], truncated: false }
      }
      if (path === '/repo/src') {
        return { path, entries: [dir('nested', '/repo/src/nested'), file('a.ts', '/repo/src/a.ts')], truncated: false }
      }
      return { path, entries: [], truncated: false }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(FileTree, {
        sessionId: 's',
        cwd: '/repo',
        expanded: ['/repo/src'],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
        refreshTick: 0,
      }))
    })
    try {
      await vi.waitFor(() => expect(container.textContent).toContain('README.md'))
      await vi.waitFor(() => expect(container.textContent).toContain('a.ts'))
      const rows = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
      // The expanded dir row (depth 1): the corner layer + the root column
      // vertical. Root is always expanded, so depth-1 rows carry one stroke.
      const src = rows.find(row => row.textContent?.startsWith('src'))!
      expect(src.style.backgroundImage).toContain('linear-gradient(0deg')
      expect(src.style.backgroundImage).toContain('linear-gradient(90deg')
      // A collapsible dir still inside src (depth 2, collapsed): verticals
      // for both ancestor columns ONLY — no corner, no own-column stroke.
      const nested = rows.find(row => row.textContent?.startsWith('nested'))!
      expect(nested.style.backgroundImage).not.toContain('linear-gradient(0deg')
      expect(nested.style.backgroundImage).toContain('transparent 6px')
      expect(nested.style.backgroundImage).toContain('transparent 28px')
      expect(nested.style.backgroundImage).not.toContain('transparent 50px')
      // A file inside src (depth 2): the same verticals, no corner.
      const aTs = rows.find(row => row.textContent?.startsWith('a.ts'))!
      expect(aTs.style.backgroundImage).not.toContain('linear-gradient(0deg')
      expect(aTs.style.backgroundImage).toContain('transparent 6px')
      expect(aTs.style.backgroundImage).toContain('transparent 28px')
      // README.md at depth 1: a single vertical at the root column.
      const readme = rows.find(row => row.textContent?.startsWith('README.md'))!
      expect(readme.style.backgroundImage).not.toContain('linear-gradient(0deg')
      expect(readme.style.backgroundImage).toContain('transparent 6px')
      expect(readme.style.backgroundImage).not.toContain('transparent 28px')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})

afterEach(() => { vi.restoreAllMocks() })