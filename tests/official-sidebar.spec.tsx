/**
 * Official-left-sidebar integration + full-page Global Info tests:
 * - `registerOfficialSidebarEntry` injects into the additive
 *   `sidebar.footer.action` seat (the verified seam into DSH's own
 *   ui-sidebar) with the right name/id/order, and its disposer unregisters.
 * - `GlobalInfoFooterButton` renders wide/rail variants and opens the
 *   FULL-PAGE global info view (the module-level page controller) on click.
 * - `GlobalView` (the panel tab) lists the instance-level global windows
 *   from the host-side `globalWindows` prop; a card click ATTACHES the
 *   window to the current session (onAttachGlobal) and the card ✕ unbinds
 *   it from the whole instance (onUnbindGlobal), plus the "expand to full
 *   page" affordance.
 * - `GlobalPage` (the complete-page surface) renders the same list; a card
 *   click closes the page and restores the pre-page session with the window
 *   attached (the page is a no-session surface), the card ✕ unbinds, and
 *   Escape (or opening a session) dismisses the page.
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
import { isGlobalPageOpen, openGlobalPage, resetGlobalPageForTests, setGlobalPageOpen } from '../src/client/global-page.ts'

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
  /** A ctx whose sessions face records clear() calls (the no-session open contract). */
  const ctxWithClear = () => {
    const clear = vi.fn()
    return { ctx: { sessions: { clear } } as unknown as Context, clear }
  }

  it('opens the FULL-PAGE global info on click (wide variant carries the label)', () => {
    const { ctx, clear } = ctxWithClear()
    const container = mount(createElement(GlobalInfoFooterButton, { wide: true, ctx }))
    const button = container.querySelector('button')!
    expect(button.textContent).toContain('Global Workspace')
    expect(isGlobalPageOpen()).toBe(false)
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(isGlobalPageOpen()).toBe(true)
    // The page opens FROM the hero: the current session's activation is
    // cleared first, so any session click dismisses the page naturally.
    expect(clear).toHaveBeenCalledTimes(1)
    container.remove()
  })

  it('renders the rail icon-only variant when collapsed and still opens the page', () => {
    const { ctx, clear } = ctxWithClear()
    const container = mount(createElement(GlobalInfoFooterButton, { wide: false, ctx }))
    const button = container.querySelector('button')!
    expect(button.textContent?.trim()).toBe('') // icon-only in the rail
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(isGlobalPageOpen()).toBe(true)
    expect(clear).toHaveBeenCalledTimes(1)
    container.remove()
  })
})

describe('GlobalView (the panel tab face)', () => {
  const windowOf = (id: string, title: string) => ({ id, type: 'terminal', title, area: 'right' as const })

  it('lists the global-shared windows and ATTACHES one on click', () => {
    const onAttachGlobal = vi.fn()
    const onUnbindGlobal = vi.fn()
    const ctx = {} as unknown as Context
    const globalWindows = [windowOf('gb:1', 'zsh'), windowOf('gb:2', 'npm run dev')]
    const container = mount(createElement(GlobalView, { ctx, globalWindows, onAttachGlobal, onUnbindGlobal } as never))
    expect(container.textContent).toContain('zsh')
    expect(container.textContent).toContain('npm run dev')
    // The card's main button is the first button in the card; clicking
    // attaches the window to the current session (not a plain activate —
    // the window is parked in the Global Workspace until then).
    const rows = container.querySelectorAll('button')
    act(() => { (rows[0] as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onAttachGlobal).toHaveBeenCalledWith('gb:1')
    expect(onUnbindGlobal).not.toHaveBeenCalled()
    container.remove()
  })

  it('renders a card ✕ that unbinds the window from the whole instance', () => {
    const onAttachGlobal = vi.fn()
    const onUnbindGlobal = vi.fn()
    const ctx = {} as unknown as Context
    const container = mount(createElement(GlobalView, { ctx, globalWindows: [windowOf('gb:1', 'zsh')], onAttachGlobal, onUnbindGlobal } as never))
    const close = container.querySelector('button[aria-label="Stop global sharing"]')!
    expect(close).toBeDefined()
    act(() => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onUnbindGlobal).toHaveBeenCalledWith('gb:1')
    expect(onAttachGlobal).not.toHaveBeenCalled()
    container.remove()
  })

  it('shows the empty-state hint when no global windows exist', () => {
    const ctx = {} as unknown as Context
    const container = mount(createElement(GlobalView, { ctx, globalWindows: [] } as never))
    expect(container.textContent).toContain('No globally shared windows')
    container.remove()
  })

  it('the expand affordance opens the FULL-PAGE global info', () => {
    const clear = vi.fn()
    const ctx = { sessions: { clear } } as unknown as Context
    const container = mount(createElement(GlobalView, { ctx, globalWindows: [] } as never))
    const expand = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Expand to full page'))!
    expect(expand).toBeDefined()
    act(() => { expand.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(isGlobalPageOpen()).toBe(true)
    // Same no-session open contract as the footer button.
    expect(clear).toHaveBeenCalledTimes(1)
    container.remove()
  })
})

describe('GlobalPage (the in-place conversation surface)', () => {
  const windowOf = (id: string, title: string) => ({ id, type: 'terminal', title, area: 'right' as const })

  /** A fake workspace windows store exposing a live global list plus the
   *  attach/unbind actions the page's cards drive. */
  const fakeWindows = (
    global: Array<{ id: string; type: string; title: string; area: string }>,
    hooks: { attach?: (id: string, sessionId?: string) => void; unbind?: (id: string, keep: boolean) => void } = {},
  ) => ({
    subscribe: () => () => {},
    getSnapshot: () => ({ global }),
    attachGlobal: hooks.attach ?? vi.fn(),
    unbindGlobal: hooks.unbind ?? vi.fn(),
  }) as unknown as Parameters<typeof GlobalPage>[0]['windows']

  it('renders the global windows list under a page header', () => {
    const ctx = {} as unknown as Context
    const container = mount(createElement(GlobalPage, { ctx, windows: fakeWindows([windowOf('gb:1', 'zsh')]) } as never))
    expect(container.textContent).toContain('Global Workspace')
    expect(container.textContent).toContain('zsh')
    container.remove()
  })

  it('renders no header close button (Esc / opening a session dismiss the page)', () => {
    const ctx = {} as unknown as Context
    const container = mount(createElement(GlobalPage, { ctx, windows: undefined } as never))
    expect(container.querySelector('button[aria-label="Close"]')).toBeNull()
    container.remove()
  })

  it('Escape closes the page', () => {
    const ctx = {} as unknown as Context
    const container = mount(createElement(GlobalPage, { ctx, windows: undefined } as never))
    act(() => { setGlobalPageOpen(true) })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(isGlobalPageOpen()).toBe(false)
    container.remove()
  })

  it('a card click closes the page and restores the pre-page session with the window attached', () => {
    const attach = vi.fn()
    const open = vi.fn()
    // Open the page the real way: openGlobalPage captures the current
    // session (s1) before clearing it — the restore target for card clicks.
    const sessions = {
      list: { getSnapshot: () => ({ current: 's1', byId: {} }), subscribe: () => () => {} },
      open,
    }
    const ctx = { sessions } as unknown as Context
    openGlobalPage(ctx)
    expect(isGlobalPageOpen()).toBe(true)
    const windows = fakeWindows([windowOf('gb:1', 'zsh')], { attach })
    const container = mount(createElement(GlobalPage, { ctx, windows } as never))
    const card = container.querySelector('button')!
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // The page closed and the window attached to the session it was opened
    // from, which is re-activated ("take me back with this terminal").
    expect(isGlobalPageOpen()).toBe(false)
    expect(attach).toHaveBeenCalledWith('gb:1', 's1')
    expect(open).toHaveBeenCalledWith('s1')
    container.remove()
  })

  it('a card click with NO session to restore leaves the page open (no-op overview)', () => {
    const attach = vi.fn()
    const ctx = {} as unknown as Context
    act(() => { setGlobalPageOpen(true) }) // page opened from the hero: no captured session
    const windows = fakeWindows([windowOf('gb:1', 'zsh')], { attach })
    const container = mount(createElement(GlobalPage, { ctx, windows } as never))
    const card = container.querySelector('button')!
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(isGlobalPageOpen()).toBe(true)
    expect(attach).not.toHaveBeenCalled()
    container.remove()
  })

  it('a card ✕ unbinds the window from the whole instance without leaving the page', () => {
    const unbind = vi.fn()
    const ctx = {} as unknown as Context
    act(() => { setGlobalPageOpen(true) })
    const windows = fakeWindows([windowOf('gb:1', 'zsh')], { unbind })
    const container = mount(createElement(GlobalPage, { ctx, windows } as never))
    const close = container.querySelector('button[aria-label="Stop global sharing"]')!
    expect(close).toBeDefined()
    act(() => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(unbind).toHaveBeenCalledWith('gb:1', false)
    expect(isGlobalPageOpen()).toBe(true)
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
