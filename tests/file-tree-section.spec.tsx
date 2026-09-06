/**
 * FileTree upper-module slot (v0.19.0+): a plugin-registered SECTION
 * renders in an independent region ABOVE the local tree (the lower module
 * keeps every existing capability), resolved FIRST match wins in
 * registration order with throwing matches skipped. Covers: the pure
 * resolver, the service registry surface (dup ids, disposer, notify,
 * order), the TreePanel mount (no-section regression = pre-slot DOM, a
 * matched section renders above the tree with the right scope, first
 * match wins, live register/unregister, independent expand + scroll
 * contexts, throwing matches skipped, and the local search box
 * replacing the whole tree area in search mode).
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, SIDEBAR_FEATURES } from '../src/client/service.ts'
import {
  resolveFileTreeSection, useFileTreeSection,
  type FileTreeSectionDescriptor, type FileTreeSectionScope,
} from '../src/client/file-tree-section.ts'
import type { Context } from '../src/context-types.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

// Host route spies: the spec asserts the LOCAL tree keeps working under the
// section (fsTree) and the search box still serves the local route.
const fsTreeMock = vi.hoisted(() => vi.fn())
const gitStatusMock = vi.hoisted(() => vi.fn())
const fsSearchMock = vi.hoisted(() => vi.fn())
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: fsTreeMock,
    gitStatus: gitStatusMock,
    fsSearch: fsSearchMock,
    uploadFile: vi.fn(),
  },
  downloadUrl: () => '/sidebar/file',
}))

beforeEach(() => {
  fsTreeMock.mockReset()
  fsTreeMock.mockResolvedValue({
    entries: [
      { name: 'sub', path: '/r/sub', isDir: true },
      { name: 'local.txt', path: '/r/local.txt', isDir: false },
    ],
  })
  gitStatusMock.mockReset()
  gitStatusMock.mockResolvedValue({ isRepo: true, branch: 'main', entries: [] })
  fsSearchMock.mockReset()
  fsSearchMock.mockResolvedValue({ matches: ['x.txt'], truncated: false })
})

/** One section to register: `matches` may throw (declared as an Error).
 *  The rendered content is a marker div whose text is `label`. */
interface SectionSpec {
  id: string
  matches?: boolean | Error
  label?: string
  /** Custom render (captures the scope / returns custom content). */
  render?: (scope: FileTreeSectionScope) => ReactElement
}

interface Harness {
  container: HTMLDivElement
  service: ReturnType<typeof createBetterSidebarService>
  /** The local tree's onToggle calls (independence assertions). */
  toggles: string[]
  rerender: (patch: Record<string, unknown>) => Promise<void>
  unmount: () => void
}

async function mountPanel(options: {
  specs?: SectionSpec[]
  ctx?: Context
  cwd?: string
} = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const toggles: string[] = []
  let ctx = options.ctx
  if (ctx === undefined) {
    for (const spec of options.specs ?? []) {
      service.registerFileTreeSection({
        id: spec.id,
        match: () => {
          if (spec.matches instanceof Error) throw spec.matches
          return spec.matches !== false
        },
        render: spec.render ?? (() => <div data-section-label={spec.id}>{spec.label ?? spec.id}</div>),
      } satisfies FileTreeSectionDescriptor)
    }
    ctx = { betterSidebar: service } as unknown as Context
  }
  const props: Record<string, unknown> = {
    sessionId: 's1',
    cwd: options.cwd ?? '/r',
    expanded: [],
    revealed: [],
    ctx,
    onToggle: (path: string) => { toggles.push(path) },
    onOpenFile: () => {},
    onOpenFileNewTab: () => {},
    onOpenFileSide: () => {},
    onReferenceFile: () => {},
    visible: true,
  }
  const render = (patch: Record<string, unknown> = {}): void => {
    root.render(createElement(TreePanel, { ...props, ...patch } as never))
  }
  await act(async () => { render() })
  await act(async () => { await Promise.resolve() })
  return {
    container,
    service,
    toggles,
    rerender: async (patch: Record<string, unknown>) => {
      await act(async () => { render(patch) })
      await act(async () => { await Promise.resolve() })
    },
    unmount: () => { act(() => { root.unmount() }) },
  }
}

/** A local tree row (role="button") whose name span matches. */
function rowNamed(container: HTMLDivElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

function rowMaybe(container: HTMLDivElement, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
}

/** The mounted upper-module container (null = none rendered). */
const sectionContainer = (container: HTMLDivElement, id: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-dsh-file-tree-section="${id}"]`)

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('file-tree section contract (v0.19.0+)', () => {
  it('SIDEBAR_FEATURES advertises the new capability', () => {
    expect(SIDEBAR_FEATURES).toContain('fileTreeSection')
    expect(SIDEBAR_FEATURES).toContain('fileTreeSectionSource')
  })

  it('registerFileTreeSection validates EXACTLY ONE of render (v0.19) / source (v0.20)', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const source = { createSource: () => ({ list: async () => ({ entries: [] }) }) }
    // The v0.19 render form still registers…
    const disposeRender = service.registerFileTreeSection({ id: 'r', match: () => true, render: () => null })
    // …and the v0.20 source form does too (no render at all).
    const disposeSource = service.registerFileTreeSection({ id: 's', match: () => true, source })
    expect(service.getFileTreeSections().map(section => section.id)).toEqual(['r', 's'])
    // BOTH forms → a clear throw.
    expect(() => service.registerFileTreeSection({ id: 'both', match: () => true, render: () => null, source }))
      .toThrow(/must provide exactly one/)
    // NEITHER form → a clear throw.
    expect(() => service.registerFileTreeSection({ id: 'none', match: () => true }))
      .toThrow(/must provide exactly one/)
    disposeRender()
    disposeSource()
  })

  it('resolveFileTreeSection handles source-form sections without touching their data (pure match)', () => {
    const sections: FileTreeSectionDescriptor[] = [
      { id: 'plain', match: () => false, render: () => null },
      {
        id: 'src-form',
        match: () => true,
        source: {
          createSource: () => ({ list: async () => ({ entries: [] }) }),
          roots: () => [{ id: 'root', label: 'Remote', dir: '/remote/proj' }],
        },
      },
    ]
    expect(resolveFileTreeSection(sections, 's1', '/r')?.id).toBe('src-form')
    expect(resolveFileTreeSection(sections, 's2', '/r')?.id).toBe('src-form') // 'plain' declined
  })

  it('resolveFileTreeSection: first match wins, throwing matches are skipped, no match is undefined', () => {
    const sections: Array<FileTreeSectionDescriptor & { hit?: boolean }> = [
      { id: 'a', match: () => false, render: () => null },
      { id: 'b', match: () => { throw new Error('boom') }, render: () => null },
      { id: 'c', match: () => true, render: () => null },
      { id: 'd', match: () => true, render: () => null },
    ]
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 'b' threw → skipped; 'c' is the first surviving match.
      expect(resolveFileTreeSection(sections, 's1', '/r')?.id).toBe('c')
      // No match → undefined (the upper region stays unrendered).
      expect(resolveFileTreeSection([sections[0]!], 's1', '/r')).toBeUndefined()
    } finally {
      error.mockRestore()
    }
  })

  it('registerFileTreeSection: duplicate ids throw, the disposer unregisters and notifies, order is registration order', () => {
    const service = createBetterSidebarService(createSidebarStore())
    const listener = vi.fn()
    service.subscribe(listener)
    const disposeA = service.registerFileTreeSection({ id: 'a', match: () => true, render: () => null })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(() => service.registerFileTreeSection({ id: 'a', match: () => true, render: () => null }))
      .toThrow(/already registered/)
    service.registerFileTreeSection({ id: 'b', match: () => true, render: () => null })
    expect(service.getFileTreeSections().map(section => section.id)).toEqual(['a', 'b'])
    // The disposer unregisters exactly its own descriptor…
    disposeA()
    expect(service.getFileTreeSections().map(section => section.id)).toEqual(['b'])
    expect(listener).toHaveBeenCalledTimes(3) // register a, register b, disposeA
    // …and a STALE disposer never removes a newer registration of the
    // same id (the identity guard): re-register 'a' (it lands at the END
    // of the registration order, Map re-insertion semantics — same as the
    // tab/viewer registries), then call the old disposeA — 'a' must
    // survive; the new disposer removes it.
    const disposeANew = service.registerFileTreeSection({ id: 'a', match: () => true, render: () => null })
    expect(listener).toHaveBeenCalledTimes(4)
    disposeA()
    expect(service.getFileTreeSections().map(section => section.id)).toEqual(['b', 'a'])
    disposeANew()
    expect(service.getFileTreeSections().map(section => section.id)).toEqual(['b'])
    expect(listener).toHaveBeenCalledTimes(5)
  })
})

describe('TreePanel upper-module slot', () => {
  let harness: Harness
  afterEach(() => {
    harness?.unmount()
    document.body.innerHTML = ''
  })

  it('no section matches: the tree renders exactly as before — no wrapper, no section, the tree body stays a DIRECT panel child', async () => {
    harness = await mountPanel({})
    expect(sectionContainer(harness.container, 'anything')).toBeNull()
    expect(harness.container.querySelector('[class*="explorerDual"]')).toBeNull()
    expect(harness.container.querySelector('[class*="explorerSection"]')).toBeNull()
    // The local tree works (root + data through the local route) and its
    // scroll container is a direct child of the panel (pre-slot DOM).
    expect(rowMaybe(harness.container, 'sub')).toBeDefined()
    expect(rowMaybe(harness.container, 'local.txt')).toBeDefined()
    const panel = harness.container.firstElementChild!
    expect(panel.querySelector(':scope > [class*="explorerBody"]')).not.toBeNull()
    expect(fsTreeMock).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/r' }, '/r')
  })

  it('a matched section renders ABOVE the local tree, inside the dual stack, with the session scope', async () => {
    let captured: FileTreeSectionScope | undefined
    harness = await mountPanel({
      specs: [{
        id: 'remote',
        render: (scope) => {
          captured = scope
          return <div>REMOTE CONTENT</div>
        },
      }],
    })
    const section = sectionContainer(harness.container, 'remote')
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain('REMOTE CONTENT')
    // The dual stack exists and the local tree renders below it, still
    // served by the local route (its own scroll container intact).
    const dual = harness.container.querySelector('[class*="explorerDual"]')
    expect(dual).not.toBeNull()
    const body = harness.container.querySelector('[class*="explorerBody"]')!
    expect(body).not.toBeNull()
    // The section is the stack's FIRST child (above the tree)…
    expect(dual!.firstElementChild).toBe(section)
    // …the tree body is its own scroll element BELOW the section…
    expect((section!.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    // …and the two scroll regions are distinct elements with their own
    // scroll-container classes (the CSS declares overflow-y on each).
    expect(section).not.toBe(body)
    expect(section!.className).toContain('explorerSection')
    expect(body.className).toContain('explorerBody')
    // The injected scope carries the session identity + client context.
    expect(captured).toEqual({ sessionId: 's1', cwd: '/r', ctx: expect.anything() })
    // The lower module keeps every panel-level capability: the local tree
    // rows are present and the local search/refresh/upload chrome too.
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
    expect(harness.container.querySelector('[data-dsh-sidebar-search]')).not.toBeNull()
  })

  it('first match wins: only the earliest matching section renders', async () => {
    harness = await mountPanel({
      specs: [
        { id: 'first', label: 'FIRST' },
        { id: 'second', label: 'SECOND' },
      ],
    })
    expect(sectionContainer(harness.container, 'first')).not.toBeNull()
    expect(sectionContainer(harness.container, 'second')).toBeNull()
    expect(harness.container.textContent).toContain('FIRST')
    expect(harness.container.textContent).not.toContain('SECOND')
  })

  it('a section whose match rejects the session stays unrendered (predicate honored)', async () => {
    harness = await mountPanel({ specs: [{ id: 'local-only', matches: false, label: 'LOCAL' }] })
    expect(sectionContainer(harness.container, 'local-only')).toBeNull()
    expect(harness.container.textContent).not.toContain('LOCAL')
    expect(harness.container.querySelector('[class*="explorerDual"]')).toBeNull()
  })

  it('a SOURCE-form section (v0.20.0) renders the HOST FileTree bound to the plugin data source in the upper module', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const sourceList = vi.fn(async () => ({
      entries: [{ name: 'remote.txt', path: '/remote/proj/remote.txt', isDir: false }],
    }))
    service.registerFileTreeSection({
      id: 'remote-src',
      match: () => true,
      source: {
        createSource: () => ({ list: sourceList }),
        roots: () => [{ id: 'root', label: 'Remote Proj', dir: '/remote/proj' }],
        capabilities: { open: true },
      },
    })
    harness = await mountPanel({ ctx: { betterSidebar: service } as unknown as Context })
    await act(async () => { await Promise.resolve() })
    const section = sectionContainer(harness.container, 'remote-src')
    expect(section).not.toBeNull()
    // The upper module hosts the section's own tree (host-drawn, source-fed).
    expect(section!.querySelector('[data-dsh-file-tree-section-source="remote-src"]')).not.toBeNull()
    expect(sourceList).toHaveBeenCalledWith('/remote/proj')
    expect(section!.textContent).toContain('remote.txt')
    // The root row shows the remote root's basename.
    expect(section!.textContent).toContain('proj')
    // The LOWER module keeps the local tree through the local host route.
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
    expect(fsTreeMock).toHaveBeenCalled()
  })

  it('live registration: a section registered while the panel is mounted appears immediately; disposing it disappears', async () => {
    harness = await mountPanel({})
    expect(sectionContainer(harness.container, 'live')).toBeNull()
    // Plugin activates AFTER the panel exists: the registry notify tick
    // re-resolves the section without any remount.
    let disposeLive: (() => void) | undefined
    act(() => {
      disposeLive = harness.service.registerFileTreeSection({
        id: 'live',
        match: () => true,
        render: () => <div>LIVE REMOTE</div>,
      })
    })
    await act(async () => { await Promise.resolve() })
    const section = sectionContainer(harness.container, 'live')
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain('LIVE REMOTE')
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
    // Plugin deactivates: the disposer unregisters, the upper module
    // disappears, the local tree stays exactly as before.
    act(() => { disposeLive!() })
    await act(async () => { await Promise.resolve() })
    expect(sectionContainer(harness.container, 'live')).toBeNull()
    expect(harness.container.querySelector('[class*="explorerDual"]')).toBeNull()
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
  })

  it('the upper and lower modules expand and scroll INDEPENDENTLY', async () => {
    harness = await mountPanel({
      specs: [{
        id: 'remote',
        render: () => {
          const RemoteModule = (): ReactElement => {
            const [open, setOpen] = useState(false)
            return (
              <div>
                <button data-remote-toggle onClick={() => { setOpen(prev => !prev) }}>toggle</button>
                {open && <div data-remote-child>remote-child</div>}
              </div>
            )
          }
          return <RemoteModule />
        },
      }],
    })
    const section = sectionContainer(harness.container, 'remote')!
    // Toggling the SECTION's own expand state never touches the local
    // tree's expansion contract (no local onToggle fired).
    click(section.querySelector('[data-remote-toggle]')!)
    expect(harness.container.querySelector('[data-remote-child]')).not.toBeNull()
    expect(harness.toggles).toEqual([])
    // Expanding a LOCAL directory works as before and leaves the section
    // state untouched (its child stays visible).
    click(rowNamed(harness.container, 'sub'))
    expect(harness.toggles).toEqual(['/r/sub'])
    expect(harness.container.querySelector('[data-remote-child]')).not.toBeNull()
    // The two scroll contexts are separate elements: the section's own
    // overflow region vs. the tree body's overflow region.
    const body = harness.container.querySelector('[class*="explorerBody"]')!
    expect(section.querySelector('[data-remote-child]')!.closest('[class*="explorerSection"]')).toBe(section)
    expect(section).not.toBe(body)
    expect(section.className).toContain('explorerSection')
    expect(body.className).toContain('explorerBody')
  })

  it('a throwing match is skipped at render time: the next section wins, and a lone throwing section leaves the tree untouched', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      harness = await mountPanel({
        specs: [
          { id: 'boom', matches: new Error('match exploded'), label: 'BOOM' },
          { id: 'good', label: 'GOOD' },
        ],
      })
      expect(sectionContainer(harness.container, 'boom')).toBeNull()
      expect(sectionContainer(harness.container, 'good')).not.toBeNull()
      expect(harness.container.textContent).toContain('GOOD')
      // The local tree below is unaffected.
      expect(rowNamed(harness.container, 'local.txt')).toBeDefined()

      harness.unmount()
      document.body.innerHTML = ''
      harness = await mountPanel({ specs: [{ id: 'boom', matches: new Error('match exploded'), label: 'BOOM' }] })
      // No surviving match → the pre-slot render path, tree fully intact.
      expect(sectionContainer(harness.container, 'boom')).toBeNull()
      expect(harness.container.querySelector('[class*="explorerDual"]')).toBeNull()
      expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
      expect(fsTreeMock).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/r' }, '/r')
    } finally {
      error.mockRestore()
    }
  })

  it('the panel-level search box REPLACES the whole tree area in search mode (both modules), then the tree returns', async () => {
    harness = await mountPanel({ specs: [{ id: 'remote', label: 'REMOTE' }] })
    expect(sectionContainer(harness.container, 'remote')).not.toBeNull()
    const input = harness.container.querySelector<HTMLInputElement>('[data-dsh-sidebar-search]')
    expect(input).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'needle')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })
    // Search mode: the results surface replaces the tree area — the
    // section and the local tree are both gone, the local search route
    // was queried (the debounce is not awaited here; the mode flip is
    // synchronous with the query).
    expect(sectionContainer(harness.container, 'remote')).toBeNull()
    expect(harness.container.querySelector('[class*="explorerDual"]')).toBeNull()
    expect(harness.container.querySelector('[class*="explorerBody"]')).not.toBeNull()
    // Clearing the query brings both modules back.
    act(() => {
      setter.call(input, '')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })
    expect(sectionContainer(harness.container, 'remote')).not.toBeNull()
    expect(rowNamed(harness.container, 'local.txt')).toBeDefined()
  })

  it('useFileTreeSection degrades to undefined without a registry service (registry-less ctx)', async () => {
    let resolved: FileTreeSectionDescriptor | undefined = { id: 'x', match: () => true, render: () => null }
    const Probe = (): ReactElement => {
      resolved = useFileTreeSection(undefined, 's1', '/r')
      return <div />
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    await act(async () => { root.render(createElement(Probe)) })
    await act(async () => { await Promise.resolve() })
    expect(resolved).toBeUndefined()
    act(() => { root.unmount() })
    container.remove()
  })
})