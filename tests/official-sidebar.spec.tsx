/**
 * Official-left-sidebar integration + full-page Global Info tests:
 * - `registerOfficialSidebarEntry` injects into the additive
 *   `sidebar.footer.action` seat (the verified seam into DSH's own
 *   ui-sidebar) with the right name/id/order, and its disposer unregisters.
 * - `GlobalInfoFooterButton` renders wide/rail variants and opens the
 *   FULL-PAGE global info view (the module-level page controller) on click.
 * - `GlobalView` (the panel tab) lists the instance-level global windows
 *   from the host-side `globalWindows` prop, activates them, and offers the
 *   "expand to full page" affordance.
 * - `GlobalPage` (the complete-page overlay) renders the same list and
 *   closes via the header ✕, Escape, or a backdrop click.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import {
  GlobalInfoFooterButton, registerOfficialSidebarEntry,
} from '../src/client/official-sidebar.tsx'
import { GlobalView } from '../src/client/GlobalView.tsx'
import { GlobalPage, registerGlobalPageSurface } from '../src/client/GlobalPage.tsx'
import { isGlobalPageOpen, resetGlobalPageForTests, setGlobalPageOpen } from '../src/client/global-page.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => { resetGlobalPageForTests() })

/** A fake ctx.slots capturing inject/register calls (mirror of the runtime
 *  SlotRegistry face the plugin types against). The runtime's inject runs
 *  the callback synchronously when the slot is already declared (ui-sidebar
 *  declares its seats at boot) — the fake does the same. */
function fakeSlots(): {
  ctx: Context
  injected: string[]
  registered: Array<{ name: string; id?: string; order?: number }>
  dispose: () => void
} {
  const injected: string[] = []
  const registered: Array<{ name: string; id?: string; order?: number }> = []
  let active: (() => void) | undefined
  const slots = {
    inject: (key: string, callback: () => () => void) => {
      injected.push(key)
      active = callback()
      return () => { active?.() }
    },
    register: (options: { name: string; id?: string; order?: number }, _component: unknown) => {
      registered.push({ name: options.name, id: options.id, order: options.order })
      return () => {}
    },
  } as unknown as Context['slots']
  return {
    ctx: { slots } as unknown as Context,
    injected,
    registered,
    dispose: () => { active?.() },
  }
}

/** Mount a component; returns the container. */
function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  return container
}

describe('registerOfficialSidebarEntry', () => {
  it('injects into sidebar.footer.action with the global-info entry', () => {
    const fake = fakeSlots()
    const dispose = registerOfficialSidebarEntry(fake.ctx)
    expect(dispose).toBeTypeOf('function')
    expect(fake.injected).toEqual(['sidebar.footer.action'])
    // The declaration is already live, so the register already ran with the
    // additive entry identity.
    expect(fake.registered).toEqual([
      { name: 'sidebar.footer.action', id: 'dsh-better-sidebar:global-info', order: 10 },
    ])
    dispose?.()
  })

  it('is a no-op when the slots service is absent', () => {
    const ctx = {} as unknown as Context
    expect(registerOfficialSidebarEntry(ctx)).toBeUndefined()
  })
})

describe('GlobalInfoFooterButton', () => {
  it('opens the FULL-PAGE global info on click (wide variant carries the label)', () => {
    const container = mount(createElement(GlobalInfoFooterButton, { wide: true }))
    const button = container.querySelector('button')!
    expect(button.textContent).toContain('Global Workspace')
    expect(isGlobalPageOpen()).toBe(false)
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(isGlobalPageOpen()).toBe(true)
    container.remove()
  })

  it('renders the rail icon-only variant when collapsed and still opens the page', () => {
    const container = mount(createElement(GlobalInfoFooterButton, { wide: false }))
    const button = container.querySelector('button')!
    expect(button.textContent?.trim()).toBe('') // icon-only in the rail
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(isGlobalPageOpen()).toBe(true)
    container.remove()
  })
})

describe('GlobalView (the panel tab face)', () => {
  const windowOf = (id: string, title: string) => ({ id, type: 'terminal', title, area: 'right' as const })

  it('lists the global-shared windows and activates one on click', () => {
    const activateTab = vi.fn()
    const ctx = { betterSidebar: { activateTab } } as unknown as Context
    const globalWindows = [windowOf('gb:1', 'zsh'), windowOf('gb:2', 'npm run dev')]
    const container = mount(createElement(GlobalView, { ctx, globalWindows } as never))
    expect(container.textContent).toContain('zsh')
    expect(container.textContent).toContain('npm run dev')
    const rows = container.querySelectorAll('button')
    // Each row has an activate link; clicking focuses the stub.
    act(() => { (rows[0] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(activateTab).toHaveBeenCalledWith('gb:1')
    container.remove()
  })

  it('shows the empty-state hint when no global windows exist', () => {
    const ctx = { betterSidebar: { activateTab: vi.fn() } } as unknown as Context
    const container = mount(createElement(GlobalView, { ctx, globalWindows: [] } as never))
    expect(container.textContent).toContain('No globally shared windows')
    container.remove()
  })

  it('the expand affordance opens the FULL-PAGE global info', () => {
    const ctx = { betterSidebar: { activateTab: vi.fn() } } as unknown as Context
    const container = mount(createElement(GlobalView, { ctx, globalWindows: [] } as never))
    const expand = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Expand to full page'))!
    expect(expand).toBeDefined()
    act(() => { expand.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(isGlobalPageOpen()).toBe(true)
    container.remove()
  })
})

describe('GlobalPage (the in-place conversation surface)', () => {
  const windowOf = (id: string, title: string) => ({ id, type: 'terminal', title, area: 'right' as const })

  /** A fake workspace windows store exposing a live global list. */
  const fakeWindows = (global: Array<{ id: string; type: string; title: string; area: string }>) => ({
    subscribe: () => () => {},
    getSnapshot: () => ({ global }),
  }) as unknown as Parameters<typeof GlobalPage>[0]['windows']

  it('renders the global windows list under a page header', () => {
    const ctx = { betterSidebar: { activateTab: vi.fn() } } as unknown as Context
    const container = mount(createElement(GlobalPage, { ctx, windows: fakeWindows([windowOf('gb:1', 'zsh')]) } as never))
    expect(container.textContent).toContain('Global Workspace')
    expect(container.textContent).toContain('zsh')
    container.remove()
  })

  it('the header close button closes the page', () => {
    const ctx = { betterSidebar: { activateTab: vi.fn() } } as unknown as Context
    const container = mount(createElement(GlobalPage, { ctx, windows: undefined } as never))
    expect(isGlobalPageOpen()).toBe(false)
    act(() => { setGlobalPageOpen(true) })
    const close = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement | null
    expect(close).not.toBeNull()
    act(() => { close!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(isGlobalPageOpen()).toBe(false)
    container.remove()
  })

  it('Escape closes the page', () => {
    const ctx = { betterSidebar: { activateTab: vi.fn() } } as unknown as Context
    const container = mount(createElement(GlobalPage, { ctx, windows: undefined } as never))
    act(() => { setGlobalPageOpen(true) })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(isGlobalPageOpen()).toBe(false)
    container.remove()
  })
})

describe('registerGlobalPageSurface (conversation-slot takeover)', () => {
  it('registers into the conversation slot at priority -1 (lowest renders → shadows the chat)', () => {
    const registered: Array<{ name: string; id?: string; priority?: number }> = []
    const ctx = {
      slots: {
        register: (options: { name: string; id?: string; priority?: number }, _component: unknown) => {
          registered.push({ name: options.name, id: options.id, priority: options.priority })
          return () => { registered.length = 0 }
        },
      },
    } as unknown as Context
    const dispose = registerGlobalPageSurface(ctx, undefined)
    expect(dispose).toBeTypeOf('function')
    expect(registered).toEqual([
      { name: 'conversation', id: 'dsh-better-sidebar:global-info', priority: -1 },
    ])
    // Disposing restores the official conversation (unregisters our entry).
    dispose?.()
    expect(registered).toEqual([])
  })

  it('is a no-op when the slots service is absent', () => {
    const ctx = {} as unknown as Context
    expect(registerGlobalPageSurface(ctx, undefined)).toBeUndefined()
  })
})
