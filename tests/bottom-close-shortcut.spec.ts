// @vitest-environment jsdom
/**
 * The DOM-level Cmd+W / Ctrl+W claim for the bottom workbench
 * (bottom-close-shortcut.ts) — the counterpart of the desktop-shell bridge
 * path for every environment where the press reaches the page (plain
 * browsers, shells without `window.dshDesktopShell`):
 *
 * 1. `installBottomCloseShortcut()` installs a window CAPTURE-phase keydown
 *    listener. While the FOCUSED element is inside the bottom workbench
 *    ([data-dsh-bottom-panel]), `primary`+KeyW (and `primary`+alt+KeyW, the
 *    host's web binding) closes the focused pane's active tab instead of
 *    letting the host's "close the app" fallback / the browser's tab close
 *    run: `preventDefault()` makes the host's bubble-phase shortcuts dispatch
 *    pass the press, `stopPropagation()` keeps it from the terminal/editor.
 * 2. The claim is scoped: focus anywhere else (composer, right sidebar…)
 *    leaves the press untouched; a closed workbench never claims; pure
 *    Ctrl+W (Windows/Linux) inside an `.xterm` is left to the shell's own
 *    chord; repeats are claimed but do not re-close.
 * 3. Close resolution is the SAME `closeBottomActiveTab` the desktop claim
 *    uses, now pane-scoped via the focused pane's `data-dsh-pane` id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBetterSidebarService } from '../src/client/service.ts'
import {
  createSidebarStore, allLeaves, splitPane, mapLeaf, toggleBottomPanel,
} from '../src/client/state.ts'
import { installBottomCloseShortcut } from '../src/client/bottom-close-shortcut.ts'
import { claimCloseActiveTab } from '../src/client/desktop-shortcuts.ts'

/**
 * One session id per mount: the store persists sessions to localStorage
 * (loadState/schedulePersist), so a later test's fresh store would otherwise
 * restore an earlier test's layout under the same id.
 */
let sessionCounter = 0

/** A mounted service bound to a fresh session with the terminal type registered. */
function mount(): {
  service: ReturnType<typeof createBetterSidebarService>
  store: ReturnType<typeof createSidebarStore>
  sessionId: string
} {
  const sessionId = `s${++sessionCounter}`
  const store = createSidebarStore()
  store.setSession(sessionId)
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'terminal', title: 'Terminal', component: () => null })
  return { store, service, sessionId }
}

/** The real pane ids of the current split tree. */
function paneIdsOf(service: ReturnType<typeof createBetterSidebarService>): string[] {
  return allLeaves(service.getSnapshot().state!.bottomSplits).map(leaf => leaf.id)
}

/** Open one terminal tab (explicit legacy identity — no host round-trip).
 *  Scoped to the service's own session. */
function openTerminal(
  service: ReturnType<typeof createBetterSidebarService>,
  id: string,
): void {
  const sessionId = service.getSnapshot().sessionId
  if (sessionId === undefined) throw new Error('no session mounted')
  service.openTab({ type: 'terminal', id, title: `Terminal ${id}` }, { sessionId })
}

/** Plant a tab DIRECTLY into a specific pane (service opens always land in
 *  the FIRST leaf — openTabInBottomPane), so tests can stage a split with
 *  tabs on both sides. */
function plantTab(
  service: ReturnType<typeof createBetterSidebarService>,
  store: ReturnType<typeof createSidebarStore>,
  paneId: string,
  id: string,
): void {
  store.reduce(s => ({
    ...s,
    activePane: paneId,
    bottomSplits: mapLeaf(s.bottomSplits, paneId, leaf => {
      leaf.tabs = [...leaf.tabs, { id, type: 'terminal', title: `Terminal ${id}` }]
      leaf.active = id
    }),
  }))
}

/** Build the DOM the shell renders: the bottom panel hosting one pane (or
 *  the given extra panes) plus an outside sibling and a focusable panel
 *  chrome seat (the toggle cluster area, outside every pane). */
function panelDom(service: ReturnType<typeof createBetterSidebarService>, panes: string[]): {
  panel: HTMLElement
  anchors: Map<string, HTMLElement>
  chrome: HTMLElement
  outside: HTMLElement
} {
  document.body.innerHTML = ''
  const panel = document.createElement('div')
  panel.setAttribute('data-dsh-bottom-panel', '')
  const anchors = new Map<string, HTMLElement>()
  for (const paneId of panes) {
    const pane = document.createElement('div')
    pane.setAttribute('data-dsh-pane', paneId)
    const input = document.createElement('input')
    input.type = 'text'
    input.id = `focus-${paneId}`
    pane.appendChild(input)
    // A second focusable host per pane: an xterm textarea.
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const textarea = document.createElement('textarea')
    textarea.id = `term-${paneId}`
    xterm.appendChild(textarea)
    pane.appendChild(xterm)
    panel.appendChild(pane)
    anchors.set(paneId, input)
  }
  const chrome = document.createElement('button')
  chrome.type = 'button'
  chrome.id = 'chrome'
  panel.appendChild(chrome)
  document.body.appendChild(panel)
  const outside = document.createElement('div')
  outside.id = 'outside'
  const outsideInput = document.createElement('input')
  outsideInput.type = 'text'
  outsideInput.id = 'outside-input'
  outside.appendChild(outsideInput)
  document.body.appendChild(outside)
  return { panel, anchors, chrome, outside }
}

/** A scriptable bubble-phase witness registered BEFORE the claim (as the
 *  host's window shortcuts dispatch would be): when the claim runs first,
 *  the witness must stay silent. */
function witness(): { seen: () => boolean; install: () => () => void } {
  let seen = false
  const onKeyDown = (): void => { seen = true }
  return {
    seen: () => seen,
    install: () => {
      window.addEventListener('keydown', onKeyDown, false)
      return () => { window.removeEventListener('keydown', onKeyDown, false) }
    },
  }
}

/** Fire a keydown through `window` with the given chord. */
function press(init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    code: 'KeyW', key: 'w', bubbles: true, cancelable: true, ...init,
  })
  window.dispatchEvent(event)
  return event
}

const disposers: Array<() => void> = []
function install(
  service: ReturnType<typeof createBetterSidebarService>,
  collapse = () => true,
): void {
  disposers.push(installBottomCloseShortcut(service, collapse))
}

beforeEach(() => {
  // The store persists sessions to localStorage; a fresh store would restore
  // a previous test's layout otherwise. (mount() also mints unique session
  // ids — clearing keeps the debounced persist timers from leaking writes.)
  try { localStorage.clear() } catch { /* storage unavailable: no-op */ }
  sessionCounter = 0
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.innerHTML = ''
})

describe('installBottomCloseShortcut: closes the focused pane\'s tab', () => {
  it('Cmd+W closes the active tab of the pane holding the focus', () => {
    const { service } = mount()
    openTerminal(service, 't1')
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    const focus = document.getElementById(`focus-${paneId}`)!
    focus.focus()
    const event = press({ metaKey: true })
    expect(event.defaultPrevented).toBe(true)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain('t1')
  })

  it('closes the FOCUSED pane in a split workbench, not activePane\'s', () => {
    const { service, store } = mount()
    openTerminal(service, 't1') // lands in the first pane
    store.reduce(s => splitPane(s, 'row')) // second pane, empty
    const [p1, p2] = [paneIdsOf(service)[0]!, paneIdsOf(service)[1]!]
    // Plant t2 in p2 and make p1 the store's activePane again.
    plantTab(service, store, p2, 't2')
    store.reduce(s => ({ ...s, activePane: p1 }))
    panelDom(service, [p1, p2])
    install(service)
    const second = document.getElementById(`focus-${p2}`)!
    second.focus()
    const event = press({ metaKey: true })
    expect(event.defaultPrevented).toBe(true)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain('t2')
    expect(tabs.map(tab => tab.id)).toContain('t1')
  })

  it('falls back to the active pane when the focus sits on panel chrome', () => {
    const { service, store } = mount()
    openTerminal(service, 't1')
    store.reduce(s => splitPane(s, 'row'))
    const [p1, p2] = [paneIdsOf(service)[0]!, paneIdsOf(service)[1]!]
    plantTab(service, store, p2, 't2')
    const { chrome } = panelDom(service, [p1, p2])
    install(service)
    // Focus on the panel's own chrome (the toggle cluster seat) — outside
    // every pane, so the activePane leaf resolves the close target.
    chrome.focus()
    const event = press({ metaKey: true })
    expect(event.defaultPrevented).toBe(true)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain('t2')
    expect(tabs.map(tab => tab.id)).toContain('t1')
  })

  it('closes via the same service path the + menu close uses (fires onClose)', () => {
    const { service } = mount()
    const onClose = vi.fn()
    service.registerTab({ id: 'custom', title: 'Custom', component: () => null, onClose })
    const sessionId = service.getSnapshot().sessionId!
    service.openTab({ type: 'custom', id: 'c1', title: 'Custom 1' }, { sessionId })
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    ;(document.getElementById(`focus-${paneId}`)!).focus()
    press({ metaKey: true })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('installBottomCloseShortcut: claim gating', () => {
  it('claims Cmd+Alt+W too (the host\'s web close chord)', () => {
    const { service } = mount()
    openTerminal(service, 't1')
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    ;(document.getElementById(`focus-${paneId}`)!).focus()
    const event = press({ metaKey: true, altKey: true })
    expect(event.defaultPrevented).toBe(true)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain('t1')
  })

  it('ignores Cmd+Shift+W', () => {
    const { service } = mount()
    openTerminal(service, 't1')
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    ;(document.getElementById(`focus-${paneId}`)!).focus()
    const event = press({ metaKey: true, shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).toContain('t1')
  })

  it('ignores other keys while focused in the panel', () => {
    const { service } = mount()
    openTerminal(service, 't1')
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    ;(document.getElementById(`focus-${paneId}`)!).focus()
    const event = press({ code: 'KeyQ', key: 'q', metaKey: true })
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves the press alone when focus is outside the workbench', () => {
    const { service } = mount()
    openTerminal(service, 't1')
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    const wire = witness()
    wire.install()
    ;(document.getElementById('outside-input')!).focus()
    const event = press({ metaKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(wire.seen()).toBe(true)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).toContain('t1')
  })

  it('never claims while the workbench is closed, even with focus inside', () => {
    const { service, store } = mount()
    openTerminal(service, 't1')
    store.reduce(toggleBottomPanel) // collapse
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    ;(document.getElementById(`focus-${paneId}`)!).focus()
    const event = press({ metaKey: true })
    expect(event.defaultPrevented).toBe(false)
  })

  it('collapses the workbench (nothing to close) and still claims the press', () => {
    const { service, store } = mount()
    store.reduce(s => ({ ...s, bottomOpen: true }))
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    const collapse = vi.fn((() => {
      store.reduce(toggleBottomPanel)
      return true
    }))
    install(service, collapse)
    ;(document.getElementById(`focus-${paneId}`)!).focus()
    const event = press({ metaKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(collapse).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot().state?.bottomOpen).toBe(false)
  })

  it('runs BEFORE host-style window listeners and stops the press cold', () => {
    const { service } = mount()
    openTerminal(service, 't1')
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    const wire = witness()
    wire.install()
    ;(document.getElementById(`focus-${paneId}`)!).focus()
    const event = press({ metaKey: true })
    // The witness (the host's shortcuts dispatch seat) never saw the press:
    // defaultPrevented made it pass and stopPropagation kept it local.
    expect(event.defaultPrevented).toBe(true)
    expect(wire.seen()).toBe(false)
  })
})

describe('installBottomCloseShortcut: Windows/Linux Ctrl+W', () => {
  it('claims plain Ctrl+W outside a terminal (closes the tab)', () => {
    const { service } = mount()
    openTerminal(service, 't1')
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    ;(document.getElementById(`focus-${paneId}`)!).focus()
    const event = press({ ctrlKey: true })
    expect(event.defaultPrevented).toBe(true)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain('t1')
  })

  it('leaves pure Ctrl+W inside an xterm to the shell (readline chord)', () => {
    const { service } = mount()
    openTerminal(service, 't1')
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    const wire = witness()
    wire.install()
    ;(document.getElementById(`term-${paneId}`)!).focus()
    const event = press({ ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(wire.seen()).toBe(true)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).toContain('t1')
  })

  it('claims Ctrl+Alt+W inside an xterm (the host\'s web binding does too)', () => {
    const { service } = mount()
    openTerminal(service, 't1')
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    ;(document.getElementById(`term-${paneId}`)!).focus()
    const event = press({ ctrlKey: true, altKey: true })
    expect(event.defaultPrevented).toBe(true)
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain('t1')
  })
})

describe('installBottomCloseShortcut: repeats', () => {
  it('claims repeats but closes only once (one press, one tab)', () => {
    const { service } = mount()
    openTerminal(service, 't0') // first tab; the second open leaves it inactive
    openTerminal(service, 't1') // the active one
    const paneId = paneIdsOf(service)[0]!
    panelDom(service, [paneId])
    install(service)
    ;(document.getElementById(`focus-${paneId}`)!).focus()
    const first = press({ metaKey: true })
    const repeat = press({ metaKey: true, repeat: true })
    expect(first.defaultPrevented).toBe(true)
    expect(repeat.defaultPrevented).toBe(true)
    // Only the first press closed: the repeat was claimed (the browser must
    // not pick up its own close) but did not re-run — t0 survives.
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain('t1')
    expect(tabs.map(tab => tab.id)).toContain('t0')
  })

  it('closes only the focused pane\'s tab (a split sibling stays)', () => {
    const { service, store } = mount()
    openTerminal(service, 't1')
    store.reduce(s => splitPane(s, 'row'))
    const [p1, p2] = [paneIdsOf(service)[0]!, paneIdsOf(service)[1]!]
    plantTab(service, store, p2, 't2')
    panelDom(service, [p1, p2])
    install(service)
    // Focus p1 which holds t1 — closing must not touch p2's t2.
    ;(document.getElementById(`focus-${p1}`)!).focus()
    press({ metaKey: true })
    const tabs = allLeaves(service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(tabs.map(tab => tab.id)).not.toContain('t1')
    expect(tabs.map(tab => tab.id)).toContain('t2')
  })
})

describe('coexistence with the desktop bridge semantics', () => {
  it('the DOM claim is the bottom-workbench half of the SAME close resolution', () => {
    // Both paths must resolve the same tab for the same snapshot: run the
    // desktop claim (no native controller → bottom workbench) and the DOM
    // claim against fresh mounts and compare survivors.
    const first = mount()
    openTerminal(first.service, 't1')
    const second = mount()
    openTerminal(second.service, 't1')
    const paneId = paneIdsOf(first.service)[0]!
    panelDom(first.service, [paneId])
    install(first.service)
    ;(document.getElementById(`focus-${paneId}`)!).focus()
    press({ metaKey: true })
    claimCloseActiveTab({ get: () => undefined }, second.service)
    const viaDom = allLeaves(first.service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    const viaBridge = allLeaves(second.service.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
    expect(viaDom.map(tab => tab.id)).toEqual(viaBridge.map(tab => tab.id))
  })
})