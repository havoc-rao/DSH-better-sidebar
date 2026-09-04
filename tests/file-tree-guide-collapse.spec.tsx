/**
 * FileTree clickable indent guides (the VSCode affordance): every row
 * carries one clickable band per expanded-ancestor column, positioned over
 * that ancestor's guide stroke. Hovering a band lights up the ancestor's
 * WHOLE vertical line across its visible subtree (the "click collapses this
 * whole directory" signal), and clicking collapses that ancestor directory
 * — from any descendant row, so a folder full of expanded subdirs folds one
 * level (or all the way up) without scrolling to the directory rows. The
 * row's own action (dir toggle / file open) must never fire from a band
 * click, and rows whose only stroke is the workspace root's (depth-1 rows)
 * get no bands.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import type { FsEntry } from '../src/client/api.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vitest 4.1.11+ follows the OS locale; pin en-US for title assertions.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

/** The mock workspace tree: root → app → (components → {Button.tsx, deep},
 *  main.ts). Every directory expanded in the harness below. */
const LEVELS: Record<string, FsEntry[]> = {
  '/tmp': [entry('/tmp', 'app', true)],
  '/tmp/app': [
    entry('/tmp/app', 'components', true),
    entry('/tmp/app', 'main.ts', false),
  ],
  '/tmp/app/components': [
    entry('/tmp/app/components', 'Button.tsx', false),
    entry('/tmp/app/components', 'deep', true),
  ],
}

/** One mock tree entry under `dir` (all optional flags off). */
function entry(dir: string, name: string, isDir: boolean): FsEntry {
  return { name, path: `${dir}/${name}`, isDir, hidden: false, isSymlink: false, broken: false }
}

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async (_scope: unknown, dir: string) => ({
      entries: LEVELS[dir] ?? [],
    }),
  },
  downloadUrl: () => '/sidebar/file',
}))

interface Harness {
  container: HTMLElement
  toggles: string[]
  opens: string[]
  unmount: () => void
}

/** Mount the tree with app and components expanded (three rendered depths:
 *  app at depth 1, components/main.ts at depth 2, Button.tsx/deep at 3). */
async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const toggles: string[] = []
  const opens: string[] = []
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: ['/tmp/app', '/tmp/app/components'],
      revealed: [],
      onToggle: (path) => { toggles.push(path) },
      onOpenFile: (path) => { opens.push(path) },
      onReferenceFile: () => {},
      refreshTick: 0,
    }))
  })
  return {
    container,
    toggles,
    opens,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

/** The row whose label text matches (rows are role="button" divs). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** The guide bands of one row, in DOM order (ancestor column ascending). */
const bandsOf = (row: HTMLElement): HTMLElement[] =>
  [...row.querySelectorAll<HTMLElement>('[class*="explorerGuideHit"]')]

/** Dispatch a click inside act() so React flushes the state update. */
function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** React synthesizes onMouseEnter/onMouseLeave from mouseover/mouseout
 *  (with relatedTarget null they count as coming from outside the band). */
function hoverEnter(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null })) })
}

function hoverLeave(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null })) })
}

/** True when the row's background paints the hovered-guide highlight
 *  (treeGuideBackground's highlightCol stroke). */
const hasGuideHighlight = (row: HTMLElement): boolean =>
  row.style.backgroundImage.includes('interactive-bg-hover-accent')

describe('FileTree clickable indent guides', () => {
  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
  })

  it('renders one band per expanded-ancestor column, positioned over the stroke', async () => {
    harness = await mountTree()
    // Depth-1 rows (children of the workspace root) have no bands.
    expect(bandsOf(rowByName(harness.container, 'app'))).toHaveLength(0)
    // Depth-2 rows: one band (column 1 — the /tmp/app stroke).
    expect(bandsOf(rowByName(harness.container, 'components'))).toHaveLength(1)
    expect(bandsOf(rowByName(harness.container, 'main.ts'))).toHaveLength(1)
    // Depth-3 rows: two bands (columns 1 and 2).
    expect(bandsOf(rowByName(harness.container, 'Button.tsx'))).toHaveLength(2)
    // Inline left edges come from the same geometry constants as the guide
    // painter: k * INDENT_STEP + INDENT_BASE − (half-band − 0.5) = k·22 + 0.5.
    const [col1, col2] = bandsOf(rowByName(harness.container, 'Button.tsx'))
    expect(col1!.style.left).toBe('22.5px')
    expect(col2!.style.left).toBe('44.5px')
  })

  it('hovering a band lights up the ancestor\'s whole vertical line across its subtree', async () => {
    harness = await mountTree()
    const app = rowByName(harness.container, 'app')
    const components = rowByName(harness.container, 'components')
    const main = rowByName(harness.container, 'main.ts')
    const button = rowByName(harness.container, 'Button.tsx')
    const deep = rowByName(harness.container, 'deep')
    // Rest: no row paints the hover stroke.
    expect(hasGuideHighlight(button)).toBe(false)
    expect(hasGuideHighlight(deep)).toBe(false)
    // Hover the deepest band on Button.tsx — the parent (components) column:
    // every row in components' subtree lights its column-2 stroke (Button.tsx
    // and deep); shallower rows (app, components, main.ts) stay untouched.
    hoverEnter(bandsOf(button)[1]!)
    expect(hasGuideHighlight(button)).toBe(true)
    expect(hasGuideHighlight(deep)).toBe(true)
    expect(hasGuideHighlight(components)).toBe(false)
    expect(hasGuideHighlight(main)).toBe(false)
    expect(hasGuideHighlight(app)).toBe(false)
    // Moving to the shallower band (column 1 — the app stroke) re-lights the
    // whole first-level subtree: every row under app, at exactly one column.
    hoverEnter(bandsOf(button)[0]!)
    for (const row of [components, main, button, deep]) {
      expect(hasGuideHighlight(row)).toBe(true)
    }
    expect(hasGuideHighlight(app)).toBe(false)
    // Leaving the band clears the whole-line highlight.
    hoverLeave(bandsOf(button)[0]!)
    expect(hasGuideHighlight(button)).toBe(false)
    expect(hasGuideHighlight(components)).toBe(false)
  })

  it('clicking a band collapses the ancestor directory that owns the stroke', async () => {
    harness = await mountTree()
    const [col1, col2] = bandsOf(rowByName(harness.container, 'Button.tsx'))
    // The deepest band (column 2) is the parent's stroke: collapses components.
    click(col2!)
    expect(harness.toggles).toEqual(['/tmp/app/components'])
    // The shallower band (column 1) is the app stroke: collapses app.
    click(col1!)
    expect(harness.toggles).toEqual(['/tmp/app/components', '/tmp/app'])
    // A band on a FILE row collapses its parent too.
    click(bandsOf(rowByName(harness.container, 'main.ts'))[0]!)
    expect(harness.toggles).toEqual(['/tmp/app/components', '/tmp/app', '/tmp/app'])
    // Band clicks never open files.
    expect(harness.opens).toEqual([])
  })

  it('a band click never fires the row action (tree rows keep their toggle/open)', async () => {
    harness = await mountTree()
    // Clicking the FILE row body (not its band) still opens the file,
    // and clicking the DIR row body still toggles the dir itself.
    click(rowByName(harness.container, 'Button.tsx'))
    click(rowByName(harness.container, 'deep'))
    expect(harness.opens).toEqual(['/tmp/app/components/Button.tsx'])
    expect(harness.toggles).toEqual(['/tmp/app/components/deep'])
  })
})