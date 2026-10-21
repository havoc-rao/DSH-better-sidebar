/**
 * The file tree's bounded horizontal axis: both render paths stay within
 * the sidebar width. Long names ellipsize rather than widening the column;
 * full paths remain available through row tooltips.
 *
 * Three pieces have to line up, and each is pinned here:
 *
 *  - the tree body clips horizontal overflow (.explorerBody);
 *  - the content column is bounded by the viewport on BOTH render paths:
 *    the provider framework's root list and the built-in fallback wrapper;
 *  - everything that belongs to the VIEWPORT instead of the scrolled content
 *    stays put: the transient strips (sticky left), the batch bar (sticky
 *    bottom + left) and the row's @-reference pill (sticky right), so a wide
 *    tree never strands an affordance off-screen.
 *
 * jsdom has no layout, so the DOM half pins the wrapper/strip wiring and the
 * CSS half pins the sheet the browser actually lays out with (same pattern as
 * tests/panel-host-css.spec.ts).
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

/** A name far wider than any panel: the whole reason this contract exists. */
const LONG_NAME = 'applypatch-msg.sample-with-a-very-long-file-name-indeed.tar.gz'

const { fsTrees } = vi.hoisted(() => ({
  // One BATCHED list call answers every requested level with the same shape
  // (leaves only — a directory entry here would recurse forever); a rejecting
  // implementation drives the load-error strip instead.
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({
      path,
      entries: [
        { name: LONG_NAME, path: `/tmp/${LONG_NAME}`, isDir: false },
      ],
      truncated: false,
    })),
  })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain (this spec is about the horizontal axis).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

interface Harness {
  container: HTMLDivElement
  rerender: (patch: Record<string, unknown>) => Promise<void>
  unmount: () => void
}

/** Mount the built-in path (no fileTreeUi seat is installed in this spec). */
async function mountTree(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  let live = {
    sessionId: 's1',
    cwd: '/tmp',
    expanded: [] as string[],
    revealed: [] as string[],
    onToggle: () => {},
    onOpenFile: () => {},
    onReferenceFile: () => {},
    refreshTick: 0,
    onUploadRequest: () => {},
    busy: false,
    ...overrides,
  }
  const render = (): void => { root.render(createElement(FileTree, live as never)) }
  await act(async () => { render() })
  return {
    container,
    rerender: async (patch) => { live = { ...live, ...patch }; await act(async () => { render() }) },
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  fsTrees.mockClear()
})

describe('FileTree horizontal scrolling: rendered DOM', () => {
  it('wraps the built-in rows in the wide content column (both classes)', async () => {
    const tree = await mountTree()
    const column = tree.container.querySelector<HTMLElement>('[class*="explorerTreeBuiltin"]')
    expect(column, 'the fallback must render its own content column').not.toBeNull()
    // The same element carries the framework opt-in class: one wrapper, one
    // set of `--dsh-ftr-*` properties, whichever path renders.
    expect(column!.className).toContain('explorerTree')
    // Every row rides inside that column, so the tree widens as one block
    // (per-row widths would leave short rows behind when scrolled right).
    const names = [...column!.querySelectorAll<HTMLElement>('[class*="explorerName"]')]
      .map(el => el.textContent)
    expect(names).toContain(LONG_NAME)
    const rows = [...tree.container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(column!.contains(row)).toBe(true)
    tree.unmount()
  })

  it('uses compact accessible icon actions and clears the selection', async () => {
    const tree = await mountTree()
    const name = [...tree.container.querySelectorAll<HTMLElement>('[class*="explorerName"]')]
      .find(el => el.textContent === LONG_NAME)!
    await act(async () => {
      name.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    })
    const toolbar = tree.container.querySelector('[role="toolbar"]')!
    expect(toolbar).not.toBeNull()
    const buttons = [...toolbar.querySelectorAll('button')]
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBeTruthy()
      expect(button.title).toBe(button.getAttribute('aria-label'))
      expect(button.querySelector('svg')).not.toBeNull()
      expect(button.className).toContain('iconButtonSm')
      expect(button.hasAttribute('aria-pressed')).toBe(false)
    }
    expect(buttons[1]!.className).toContain('iconButtonDanger')
    await act(async () => { buttons[2]!.click() })
    expect(tree.container.querySelector('[role="toolbar"]')).toBeNull()
    tree.unmount()
  })

  it('marks the transient strips as viewport-pinned', async () => {
    const tree = await mountTree()
    // Only a FORCED re-list that fails while a listing is on screen surfaces
    // the hint strip (a cold failure degrades to per-level rows instead).
    fsTrees.mockRejectedValueOnce(new Error('boom: tree listing failed'))
    await tree.rerender({ refreshTick: 1 })
    const strip = tree.container.querySelector<HTMLElement>('[class*="explorerStrip"]')
    expect(strip, 'the failed refresh must surface a strip').not.toBeNull()
    expect(strip!.textContent).toContain('boom')
    tree.unmount()
  })
})

// ── The sheet the browser lays out with ─────────────────────────────────

const css = readFileSync('src/client/sidebar.module.css', 'utf8')

/** Body of one rule by a regex for its (literal) selector, up to the
 *  un-indented `}`. */
function rule(selectorPattern: string): string {
  const body = css.match(new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1]
  expect(body, `the ${selectorPattern} rule must exist`).toBeDefined()
  return body!
}

describe('FileTree horizontal scrolling: stylesheet', () => {
  it('keeps long names within the sidebar without horizontal scrolling', () => {
    const body = rule('\\.explorerBody')
    expect(body).toMatch(/overflow-x:\s*hidden/)
    const name = rule('(?:^|\\n)\\.explorerName')
    expect(name).toMatch(/display:\s*block/)
    expect(name).toMatch(/min-width:\s*0/)
    expect(name).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('bounds the framework root to the sidebar width', () => {
    const tree = rule('\\.explorerTree')
    expect(tree).toMatch(/--dsh-ftr-root-width:\s*100%/)
    expect(tree).toMatch(/--dsh-ftr-actions-position:\s*absolute/)
    expect(tree).toMatch(/max-width:\s*100%/)
    expect(tree).not.toContain('max-content')
  })

  it('gives the built-in fallback the same bounded column', () => {
    const builtin = rule('\\.explorerTreeBuiltin')
    expect(builtin).toMatch(/width:\s*100%/)
    expect(builtin).toMatch(/min-width:\s*0/)
    expect(builtin).toMatch(/max-width:\s*100%/)
    expect(builtin).not.toContain('max-content')
  })

  it('pins the transient strips to the viewport (left, never the content)', () => {
    for (const selector of ['\\.explorerStrip', '\\.explorerActionError']) {
      const strip = rule(selector)
      expect(strip, `${selector} must be viewport-pinned`).toMatch(/position:\s*sticky/)
      expect(strip, `${selector} must be viewport-pinned`).toMatch(/left:\s*0/)
    }
  })

  it('keeps batch actions on one line while the count can shrink', () => {
    const actions = rule('\\.explorerSelectionActions')
    expect(actions).toMatch(/flex:\s*none/)
    expect(actions).toMatch(/flex-wrap:\s*nowrap/)
    expect(actions).not.toContain('max-width:')
    const text = rule('\\.explorerSelectionText')
    expect(text).toMatch(/min-width:\s*0/)
    expect(text).toMatch(/text-overflow:\s*ellipsis/)
  })

  it('keeps the batch bar docked while the tree scrolls under it', () => {
    const bar = rule('\\.explorerSelectionBar')
    expect(bar).toMatch(/position:\s*sticky/)
    expect(bar).toMatch(/bottom:\s*0/)
    expect(bar).toMatch(/left:\s*0/)
  })

  it('overlays the @-reference pill without reserving filename width', () => {
    const tail = rule('\\.explorerRef,\\s*\\.explorerRow > \\.explorerCopied')
    expect(tail).toMatch(/position:\s*absolute/)
    expect(tail).toMatch(/right:\s*8px/)
    expect(tail).toMatch(/top:\s*50%/)
    expect(tail).toMatch(/z-index:\s*1/)
    expect(tail).not.toMatch(/margin-left:/)
    const provider = rule('\\.explorerTree > div > span:has\\(> \\.explorerCopied\\)')
    expect(provider).toMatch(/position:\s*absolute/)
    expect(provider).toMatch(/right:\s*8px/)
  })

  it('reveals the overlay on hover or focus without changing layout', () => {
    const pill = rule('\\.explorerRef')
    expect(pill).toMatch(/display:\s*inline-flex/)
    expect(pill).not.toMatch(/display:\s*none/)
    expect(pill).toMatch(/visibility:\s*hidden/)
    // The reveal flips visibility only — the layout slot stays put.
    const reveal = css.match(/\.explorerRow:hover \.explorerRef,\s*\n\.explorerRow:focus-within \.explorerRef \{([\s\S]*?)\n\}/)?.[1]
    expect(reveal, 'the hover/focus reveal rule must exist').toBeDefined()
    expect(reveal).toMatch(/visibility:\s*visible/)
    expect(reveal).not.toMatch(/display:/)
  })
})
