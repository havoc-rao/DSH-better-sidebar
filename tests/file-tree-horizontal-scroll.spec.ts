/**
 * The file tree's horizontal axis. Before this contract every row was pinned
 * to the scrollport (`width: 100%` + `text-overflow: ellipsis`), so a deep
 * tree squeezed its labels into ellipses with no way to read them; now the
 * content column grows to its widest row and the tree body scrolls
 * left/right — the same model VSCode's explorer uses.
 *
 * Three pieces have to line up, and each is pinned here:
 *
 *  - the tree body itself scrolls horizontally (.explorerBody);
 *  - the content column is as wide as its widest row, on BOTH render paths:
 *    the provider framework's root list (opt-in through the two
 *    `--dsh-ftr-*` properties the consumer sets on .explorerTree) and the
 *    built-in fallback wrapper (.explorerTreeBuiltin);
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
  it('scrolls the tree body horizontally', () => {
    const body = rule('\\.explorerBody')
    expect(body).toMatch(/overflow-x:\s*auto/)
    expect(body).not.toMatch(/overflow-x:\s*hidden/)
  })

  it('opts the framework root into the wide column and the pinned actions slot', () => {
    const tree = rule('\\.explorerTree')
    expect(tree).toMatch(/--dsh-ftr-root-width:\s*max-content/)
    expect(tree).toMatch(/--dsh-ftr-actions-position:\s*sticky/)
  })

  it('gives the built-in fallback the same wide column', () => {
    const builtin = rule('\\.explorerTreeBuiltin')
    expect(builtin).toMatch(/width:\s*max-content/)
    expect(builtin).toMatch(/min-width:\s*100%/)
  })

  it('pins the transient strips to the viewport (left, never the content)', () => {
    for (const selector of ['\\.explorerStrip', '\\.explorerActionError']) {
      const strip = rule(selector)
      expect(strip, `${selector} must be viewport-pinned`).toMatch(/position:\s*sticky/)
      expect(strip, `${selector} must be viewport-pinned`).toMatch(/left:\s*0/)
    }
  })

  it('keeps the batch bar docked while the tree scrolls under it', () => {
    const bar = rule('\\.explorerSelectionBar')
    expect(bar).toMatch(/position:\s*sticky/)
    expect(bar).toMatch(/bottom:\s*0/)
    expect(bar).toMatch(/left:\s*0/)
  })

  it('keeps the @-reference pill at the scrollport edge', () => {
    const tail = rule('\\.explorerRef,\\s*\\.explorerCopied')
    expect(tail).toMatch(/margin-left:\s*auto/)
    expect(tail).toMatch(/position:\s*sticky/)
    expect(tail).toMatch(/right:\s*0/)
  })

  it('reserves the pill slot instead of collapsing it (a reveal must not re-squeeze the name)', () => {
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
