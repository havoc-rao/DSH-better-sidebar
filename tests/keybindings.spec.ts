// @vitest-environment jsdom
/**
 * Keybinding registry tests (v0.14.0+): the spec parser, the pure matcher,
 * the runtime dispatch (priority / when / opt-out / consumption / disposal),
 * and the transient UI markers the sidebar components publish. The native
 * document-capture path is exercised by the panel-hotkey spec on top of this
 * same runtime; here the dispatch is driven with bare event-like objects.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KeybindingRuntime,
  focusSidebarSearchInput,
  isPlusMenuOpen,
  isSearchActive,
  matchKeySpec,
  parseKeySpec,
  setPlusMenuOpen,
  setSearchActive,
  setSearchInputElement,
  type KeybindingDescriptor,
  type KeybindingEventLike,
  type SidebarKeybindingContext,
} from '../src/client/keybindings.ts'

function like(overrides: Partial<KeybindingEventLike> = {}): KeybindingEventLike {
  return {
    code: '',
    key: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    ...overrides,
  }
}

function baseContext(overrides: Partial<SidebarKeybindingContext> = {}): SidebarKeybindingContext {
  return {
    state: null,
    narrow: false,
    focusInSidebar: false,
    textEditing: false,
    plusMenuOpen: false,
    searchActive: false,
    activeTab: null,
    activeTabType: '',
    activePaneTabs: [],
    ...overrides,
  }
}

/** A runtime whose context can be mutated between dispatches. */
function runtimeWith(context: SidebarKeybindingContext): { runtime: KeybindingRuntime; context: SidebarKeybindingContext } {
  const state = { current: context }
  const runtime = new KeybindingRuntime(() => state.current)
  return { runtime, context: state.current }
}

describe('parseKeySpec — the spec grammar', () => {
  it('Cmd+Shift+P parses to KeyP with the command modifier + shift', () => {
    const spec = parseKeySpec('Cmd+Shift+P')
    expect(spec.code).toBe('KeyP')
    expect(spec.mod).toBe('cmd')
    expect(spec.alt).toBe(false)
    expect(spec.shift).toBe(true)
  })

  it('Ctrl+F is the LITERAL physical Ctrl (not the platform command key)', () => {
    const spec = parseKeySpec('Ctrl+F')
    expect(spec.code).toBe('KeyF')
    expect(spec.mod).toBe('ctrl')
  })

  it('Alt+1 / digits / F-keys / arrows / punctuation map to physical codes', () => {
    expect(parseKeySpec('Alt+1').code).toBe('Digit1')
    expect(parseKeySpec('F5').code).toBe('F5')
    expect(parseKeySpec('ArrowUp').code).toBe('ArrowUp')
    expect(parseKeySpec('/').code).toBe('Slash')
    expect(parseKeySpec('Numpad4').code).toBe('Numpad4')
    expect(parseKeySpec('KeyB').code).toBe('KeyB')
  })

  it('bare keys carry no command modifier', () => {
    expect(parseKeySpec('Space').mod).toBe('none')
  })

  it('throws on empty, multi-key, or unknown specs (fail at registration, not silently)', () => {
    expect(() => parseKeySpec('')).toThrow()
    expect(() => parseKeySpec('Cmd+P+Q')).toThrow()
    expect(() => parseKeySpec('Cmd+')).toThrow()
    expect(() => parseKeySpec('Cmd+Bogus+Q')).toThrow()
  })
})

describe('matchKeySpec — the pure modifier/code match', () => {
  it('Cmd matches EITHER the meta key or Ctrl (platform command key)', () => {
    const spec = parseKeySpec('Cmd+J')
    expect(matchKeySpec(spec, like({ code: 'KeyJ', metaKey: true }))).toBe(true)
    expect(matchKeySpec(spec, like({ code: 'KeyJ', ctrlKey: true }))).toBe(true)
    expect(matchKeySpec(spec, like({ code: 'KeyJ' }))).toBe(false)
  })

  it('explicit Ctrl requires the physical Ctrl key and rejects meta', () => {
    const spec = parseKeySpec('Ctrl+J')
    expect(matchKeySpec(spec, like({ code: 'KeyJ', ctrlKey: true }))).toBe(true)
    expect(matchKeySpec(spec, like({ code: 'KeyJ', metaKey: true }))).toBe(false)
    expect(matchKeySpec(spec, like({ code: 'KeyJ', ctrlKey: true, metaKey: true }))).toBe(false)
  })

  it('bare keys reject any command modifier', () => {
    const spec = parseKeySpec('Space')
    expect(matchKeySpec(spec, like({ code: 'Space' }))).toBe(true)
    expect(matchKeySpec(spec, like({ code: 'Space', metaKey: true }))).toBe(false)
    expect(matchKeySpec(spec, like({ code: 'Space', ctrlKey: true }))).toBe(false)
  })

  it('alt/shift must match exactly', () => {
    const spec = parseKeySpec('Cmd+Alt+B')
    expect(matchKeySpec(spec, like({ code: 'KeyB', metaKey: true, altKey: true }))).toBe(true)
    expect(matchKeySpec(spec, like({ code: 'KeyB', metaKey: true }))).toBe(false)
    expect(matchKeySpec(spec, like({ code: 'KeyB', metaKey: true, altKey: true, shiftKey: true }))).toBe(false)
  })

  it('the code decides the key — matching never reads the layout-dependent key value', () => {
    const spec = parseKeySpec('Cmd+B')
    expect(matchKeySpec(spec, like({ code: 'KeyB', key: '∫', metaKey: true }))).toBe(true)
  })
})

describe('KeybindingRuntime — dispatch semantics', () => {
  it('runs the first matching binding and consumes by default', () => {
    const { runtime } = runtimeWith(baseContext())
    const run = vi.fn(() => undefined)
    runtime.register({ id: 'a', title: 'A', key: 'Cmd+P', run })
    expect(runtime.dispatch(like({ code: 'KeyP', key: 'p', metaKey: true }))).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('higher priority wins when several bindings match the same key', () => {
    const { runtime } = runtimeWith(baseContext())
    const order: string[] = []
    runtime.register({ id: 'low', title: 'Low', key: 'Cmd+P', priority: 0, run: () => { order.push('low') } })
    runtime.register({ id: 'high', title: 'High', key: 'Cmd+P', priority: 10, run: () => { order.push('high') } })
    runtime.dispatch(like({ code: 'KeyP', key: 'p', metaKey: true }))
    expect(order).toEqual(['high'])
  })

  it('when-gating skips a matching key whose context predicate fails', () => {
    const { runtime } = runtimeWith(baseContext())
    const run = vi.fn()
    runtime.register({ id: 'a', title: 'A', key: 'Cmd+P', when: c => c.focusInSidebar, run })
    expect(runtime.dispatch(like({ code: 'KeyP', key: 'p', metaKey: true }))).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('a run returning false explicitly yields to the next matching binding', () => {
    const { runtime } = runtimeWith(baseContext())
    const calls: string[] = []
    runtime.register({ id: 'first', title: 'First', key: 'Cmd+P', run: () => { calls.push('first'); return false } })
    runtime.register({ id: 'second', title: 'Second', key: 'Cmd+P', run: () => { calls.push('second') } })
    expect(runtime.dispatch(like({ code: 'KeyP', key: 'p', metaKey: true }))).toBe(true)
    expect(calls).toEqual(['first', 'second'])
  })

  it('passes the assembled context to run', () => {
    const { runtime } = runtimeWith(baseContext({ focusInSidebar: true }))
    const seen: SidebarKeybindingContext[] = []
    runtime.register({ id: 'a', title: 'A', key: 'Cmd+Tab', run: (_event, context) => { seen.push(context) } })
    runtime.dispatch(like({ code: 'Tab', key: 'Tab', metaKey: true }))
    expect(seen[0]?.focusInSidebar).toBe(true)
  })

  it('duplicate ids throw; the disposer unregisters', () => {
    const { runtime } = runtimeWith(baseContext())
    const dispose = runtime.register({ id: 'a', title: 'A', key: 'Cmd+P', run: () => {} })
    expect(() => runtime.register({ id: 'a', title: 'B', key: 'Cmd+F', run: () => {} })).toThrow(/already registered/)
    dispose()
    expect(runtime.list()).toHaveLength(0)
  })

  it('returns the bindings in dispatch order (priority desc)', () => {
    const { runtime } = runtimeWith(baseContext())
    runtime.register({ id: 'a', title: 'A', key: 'F1', priority: 1, run: () => {} })
    runtime.register({ id: 'b', title: 'B', key: 'F2', priority: 5, run: () => {} })
    runtime.register({ id: 'c', title: 'C', key: 'F3', run: () => {} })
    expect(runtime.list().map(b => b.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('KeybindingRuntime — global guards', () => {
  it('ignores IME composition (isComposing / keyCode 229)', () => {
    const { runtime } = runtimeWith(baseContext())
    const run = vi.fn()
    runtime.register({ id: 'a', title: 'A', key: 'Cmd+P', run })
    expect(runtime.dispatch(like({ code: 'KeyP', key: 'p', metaKey: true, isComposing: true }))).toBe(false)
    expect(runtime.dispatch(like({ code: 'KeyP', key: 'p', metaKey: true, keyCode: 229 }))).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('ignores key auto-repeat unless the binding opts in via allowRepeat', () => {
    const { runtime } = runtimeWith(baseContext())
    const plain = vi.fn()
    const repeatable = vi.fn()
    runtime.register({ id: 'plain', title: 'Plain', key: 'ArrowDown', run: plain })
    runtime.register({ id: 'repeat', title: 'Repeat', key: 'ArrowUp', allowRepeat: true, run: repeatable })
    expect(runtime.dispatch(like({ code: 'ArrowDown', key: 'ArrowDown', repeat: true }))).toBe(false)
    expect(plain).not.toHaveBeenCalled()
    expect(runtime.dispatch(like({ code: 'ArrowUp', key: 'ArrowUp', repeat: true }))).toBe(true)
    expect(repeatable).toHaveBeenCalledTimes(1)
  })

  it('ignores AltGraph chords (Windows AltGr reports ctrl+alt)', () => {
    const { runtime } = runtimeWith(baseContext())
    const run = vi.fn()
    runtime.register({ id: 'a', title: 'A', key: 'Ctrl+Alt+B', run })
    const altGraph = like({
      code: 'KeyB', key: 'b', ctrlKey: true, altKey: true,
      getModifierState: name => name === 'AltGraph',
    })
    expect(runtime.dispatch(altGraph)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('transient UI markers', () => {
  afterEach(() => {
    setPlusMenuOpen(false)
    setSearchActive(false)
    setSearchInputElement(null)
  })

  it('the + menu and search markers round-trip', () => {
    setPlusMenuOpen(true)
    expect(isPlusMenuOpen()).toBe(true)
    setPlusMenuOpen(false)
    expect(isPlusMenuOpen()).toBe(false)
    setSearchActive(true)
    expect(isSearchActive()).toBe(true)
  })

  it('focusSidebarSearchInput focuses and selects a registered input', () => {
    const input = document.createElement('input')
    input.value = 'app.ts'
    document.body.appendChild(input)
    setSearchInputElement(input)
    expect(focusSidebarSearchInput()).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    setSearchInputElement(null)
    expect(focusSidebarSearchInput()).toBe(false)
    input.remove()
  })
})

/** Keep the descriptor type surface compiled in tests too. */
const _descriptorCheck: KeybindingDescriptor = {
  id: 'my-plugin:open-notes',
  title: () => 'Open notes',
  key: ['Cmd+Alt+N', 'Ctrl+Alt+N'],
  when: context => context.state !== null,
  priority: 5,
  run: (_event, context) => { void context; return true },
}
void _descriptorCheck