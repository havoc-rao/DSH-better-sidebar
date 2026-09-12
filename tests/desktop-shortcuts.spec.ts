// @vitest-environment jsdom
/**
 * The desktop-shell shortcut bridge (v0.20.x, deepseek-harness Electron),
 * semantics "A":
 *
 * 1. `readDesktopShellBridge()` resolves `window.dshDesktopShell` — the
 *    preload bridge the harness Electron shell exposes — and returns
 *    `undefined` in plain browsers / shells without it.
 * 2. `claimCloseActiveTab()` is the plugin's Cmd+W decision: close the
 *    native right Sidebar's active tab while the column is expanded; fold
 *    the column when nothing more is closable there; else work the bottom
 *    workbench (close its active tab, fold an open workbench with no tabs).
 *    The press is ALWAYS claimed — Cmd+W never falls through to the shell's
 *    window close confirmation while the plugin is mounted.
 */
import { describe, expect, it, vi } from 'vitest'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore, allLeaves, toggleBottomPanel } from '../src/client/state.ts'
import {
  CMD_W_SHORTCUT,
  claimCloseActiveTab,
  readDesktopShellBridge,
  type DesktopShellBridge,
} from '../src/client/desktop-shortcuts.ts'

/** A context whose `sidebarRight` is whatever the caller hands over. */
function makeCtx(controller: unknown, throwsOnGet = false): {
  get: (name: string) => unknown
} {
  return {
    get: (name: string) => {
      if (throwsOnGet) throw new Error('no services')
      return name === 'sidebarRight' ? controller : undefined
    },
  }
}

/** A service bound to session s1 with the terminal type registered. */
function mount(): {
  service: ReturnType<typeof createBetterSidebarService>
  store: ReturnType<typeof createSidebarStore>
} {
  const store = createSidebarStore()
  store.setSession('s1')
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'terminal', title: 'Terminal', component: () => null })
  return { store, service }
}

/** Open one terminal tab in the bottom workbench (the no-surface path). */
function openBottomTerminal(service: ReturnType<typeof createBetterSidebarService>): string {
  service.openTab({ type: 'terminal', title: 'Terminal 1' }, { sessionId: 's1' })
  const state = service.getSnapshot().state!
  const tabs = allLeaves(state.bottomSplits).flatMap(leaf => leaf.tabs)
  return tabs[0]!.id
}

/** A scriptable fake of the kernel `sidebarRight` controller face. */
function fakeSidebar(options: {
  expanded?: boolean | 'unknown'
  activeTab?: string | null
  /** Close removes the tab (active becomes undefined afterwards). Default true. */
  closes?: boolean
  /** `active()` throws. */
  activeThrows?: boolean
  /** `close()` throws. */
  closeThrows?: boolean
  /** `isExpanded()` throws. */
  expandedThrows?: boolean
  /** `toggleExpanded()` throws. */
  toggleThrows?: boolean
  /** No `toggleExpanded` on the face at all. */
  noToggle?: boolean
}): {
  face: unknown
  closeCalls: string[]
  toggleCalls: number
} {
  const state = { activeTab: options.activeTab ?? null }
  const closeCalls: string[] = []
  let toggleCalls = 0
  const face = {
    isExpanded: () => {
      if (options.expandedThrows === true) throw new Error('boom')
      if (options.expanded === 'unknown') return undefined
      return options.expanded ?? true
    },
    active: () => {
      if (options.activeThrows === true) throw new Error('boom')
      return state.activeTab === null ? undefined : { id: state.activeTab }
    },
    close: (tabId: string) => {
      if (options.closeThrows === true) throw new Error('boom')
      closeCalls.push(tabId)
      if (options.closes !== false) state.activeTab = null
    },
    ...(options.noToggle === true ? {} : {
      toggleExpanded: () => {
        if (options.toggleThrows === true) throw new Error('boom')
        toggleCalls += 1
      },
    }),
  }
  return {
    face,
    closeCalls,
    get toggleCalls() { return toggleCalls },
  }
}

describe('readDesktopShellBridge', () => {
  it('is undefined without the window global', () => {
    delete (window as unknown as Record<string, unknown>).dshDesktopShell
    expect(readDesktopShellBridge()).toBeUndefined()
  })

  it('returns the bridge when the preload exposed a shortcut API', () => {
    const bridge = { onShortcut: vi.fn(() => () => {}) }
    ;(window as unknown as Record<string, unknown>).dshDesktopShell = bridge
    expect(readDesktopShellBridge()).toBe(bridge)
    delete (window as unknown as Record<string, unknown>).dshDesktopShell
  })

  it('is undefined when the global is not an object or lacks onShortcut', () => {
    ;(window as unknown as Record<string, unknown>).dshDesktopShell = 42
    expect(readDesktopShellBridge()).toBeUndefined()
    ;(window as unknown as Record<string, unknown>).dshDesktopShell = {}
    expect(readDesktopShellBridge()).toBeUndefined()
    delete (window as unknown as Record<string, unknown>).dshDesktopShell
  })
})

describe('claimCloseActiveTab: native right Sidebar path', () => {
  it('closes the expanded column\'s active tab and claims the press', () => {
    const { face, closeCalls, toggleCalls } = fakeSidebar({ expanded: true, activeTab: 'files' })
    const { service } = mount()
    expect(claimCloseActiveTab(makeCtx(face), service)).toBe(true)
    expect(closeCalls).toEqual(['files'])
    expect(toggleCalls).toBe(0)
  })

  it('claims even when the closed tab leaves no active tab behind', () => {
    const { face, closeCalls, toggleCalls } = fakeSidebar({ activeTab: 'editor:1', closes: true })
    const { service } = mount()
    expect(claimCloseActiveTab(makeCtx(face), service)).toBe(true)
    expect(closeCalls).toEqual(['editor:1'])
    expect(toggleCalls).toBe(0)
  })

  it('folds the column instead of falling through when the kernel refuses (sole guide)', () => {
    // The kernel refuses only that: close() leaves the same tab active.
    const entry = fakeSidebar({ activeTab: 'guide', closes: false })
    const { service } = mount()
    expect(claimCloseActiveTab(makeCtx(entry.face), service)).toBe(true)
    expect(entry.closeCalls).toEqual(['guide'])
    expect(entry.toggleCalls).toBe(1)
  })

  it('folds the column when the expanded column has no active tab', () => {
    const entry = fakeSidebar({ expanded: true, activeTab: null })
    const { service } = mount()
    expect(claimCloseActiveTab(makeCtx(entry.face), service)).toBe(true)
    expect(entry.toggleCalls).toBe(1)
  })

  it('claims with a no-op toggle when the face lacks toggleExpanded', () => {
    const entry = fakeSidebar({ activeTab: null, noToggle: true })
    const { service } = mount()
    expect(claimCloseActiveTab(makeCtx(entry.face), service)).toBe(true)
    expect(entry.toggleCalls).toBe(0)
  })

  it('keeps claiming when the controller throws anywhere', () => {
    for (const entry of [
      fakeSidebar({ activeThrows: true }),
      fakeSidebar({ expandedThrows: true }),
      fakeSidebar({ closeThrows: true, activeTab: 'x' }),
      fakeSidebar({ toggleThrows: true, activeTab: null }),
    ]) {
      const { service } = mount()
      expect(claimCloseActiveTab(makeCtx(entry.face), service)).toBe(true)
    }
  })
})

describe('claimCloseActiveTab: bottom workbench fallback', () => {
  it('closes the workbench\'s active tab without a native controller', () => {
    const { service } = mount()
    const tabId = openBottomTerminal(service)
    expect(claimCloseActiveTab(makeCtx(undefined), service)).toBe(true)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain(tabId)
  })

  it('closes the workbench tab from a collapsed native column', () => {
    const entry = fakeSidebar({ expanded: false, activeTab: 'files' })
    const { service } = mount()
    const tabId = openBottomTerminal(service)
    expect(claimCloseActiveTab(makeCtx(entry.face), service)).toBe(true)
    expect(entry.closeCalls).toEqual([])
    expect(entry.toggleCalls).toBe(0)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain(tabId)
  })

  it('folds an open workbench that has no tab to close', () => {
    const { service, store } = mount()
    store.reduce(state => ({ ...state, bottomOpen: true }))
    const collapse = vi.fn(() => true)
    expect(claimCloseActiveTab(makeCtx(undefined), service, collapse)).toBe(true)
    expect(collapse).toHaveBeenCalledTimes(1)
  })

  it('never calls the collapse callback while the workbench is closed', () => {
    const { service } = mount()
    const collapse = vi.fn(() => true)
    expect(claimCloseActiveTab(makeCtx(undefined), service, collapse)).toBe(true)
    expect(collapse).not.toHaveBeenCalled()
  })

  it('claims as a no-op when nothing is closable anywhere', () => {
    const noNative = mount()
    expect(claimCloseActiveTab(makeCtx(undefined), noNative.service)).toBe(true)
    const collapsed = fakeSidebar({ expanded: false, activeTab: 'files' })
    expect(claimCloseActiveTab(makeCtx(collapsed.face), noNative.service)).toBe(true)
  })

  it('handles a ctx.get that throws like a missing native controller', () => {
    const { service } = mount()
    const tabId = openBottomTerminal(service)
    expect(claimCloseActiveTab(makeCtx(undefined, true), service)).toBe(true)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain(tabId)
  })

  it('the mount-point collapse callback folds the real workbench (index.tsx shape)', () => {
    // Mirrors src/client/index.tsx: the injected callback reads the snapshot
    // and reduces toggleBottomPanel against the plugin's own store.
    const { service, store } = mount()
    store.reduce(state => ({ ...state, bottomOpen: true }))
    const collapse = (): boolean => {
      if (service.getSnapshot().state?.bottomOpen !== true) return false
      store.reduce(toggleBottomPanel)
      return true
    }
    expect(claimCloseActiveTab(makeCtx(undefined), service, collapse)).toBe(true)
    expect(store.getSnapshot().state?.bottomOpen).toBe(false)
  })
})

describe('bridge contract wiring (the shell side of the contract)', () => {
  it('registers one handler per shortcut and returns a working disposer', () => {
    const handlers = new Map<string, (() => boolean | undefined) | undefined>()
    const bridge: DesktopShellBridge = {
      onShortcut: (name, handler) => {
        handlers.set(name, handler)
        return () => {
          if (handlers.get(name) === handler) handlers.delete(name)
        }
      },
    }
    const first = vi.fn(() => false)
    const second = vi.fn(() => true)
    const offFirst = bridge.onShortcut(CMD_W_SHORTCUT, first)
    bridge.onShortcut(CMD_W_SHORTCUT, second)
    // Last registration wins; a stale disposer removes nothing.
    offFirst()
    expect(handlers.has(CMD_W_SHORTCUT)).toBe(true)
    const active = handlers.get(CMD_W_SHORTCUT)!
    expect(active()).toBe(true)
    expect(first).not.toHaveBeenCalled()
    const offSecond = bridge.onShortcut(CMD_W_SHORTCUT, second)
    offSecond()
    expect(handlers.has(CMD_W_SHORTCUT)).toBe(false)
  })

  it('the index wiring shape: every press is claimed, even with nothing to close', () => {
    // Mirrors src/client/index.tsx: the handler delegates to
    // claimCloseActiveTab, a throwing claim stays unclaimed (the shell's
    // default then runs), and a claim never returns false on its own.
    const { service } = mount()
    let handler: (() => boolean | undefined) | undefined
    const bridge: DesktopShellBridge = {
      onShortcut: (_name, fn) => {
        handler = fn
        return () => { handler = undefined }
      },
    }
    bridge.onShortcut(CMD_W_SHORTCUT, () => {
      try {
        return claimCloseActiveTab(makeCtx(undefined), service)
      } catch {
        return undefined
      }
    })
    expect(handler!()).toBe(true)
    expect(handler!()).toBe(true)
    expect(handler!()).toBe(true)
  })
})