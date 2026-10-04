// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { registerCentralEditor } from '../src/client/CentralEditor.tsx'

vi.mock('../src/client/locales.ts', () => ({ t: (key: string) => key }))
vi.mock('../src/client/api.ts', () => ({ api: { fsRead: vi.fn(), fsWrite: vi.fn() } }))
vi.mock('../src/client/chunk-loader.ts', () => ({ loadChunk: vi.fn(async () => ({})) }))
const cacheProbe = vi.hoisted(() => ({ cleanups: new Map<string, ReturnType<typeof vi.fn<() => void>>>() }))
vi.mock('../src/client/lazy-chunk.tsx', () => ({
  lazyChunkComponent: () => function MockCentralCodeEditor(props: {
    documentKey: string; content: string; onChange(value: string): void; onSave(): void
    registerCacheCleanup(key: string, cleanup: () => void): void
  }) {
    useEffect(() => {
      const cleanup = cacheProbe.cleanups.get(props.documentKey) ?? vi.fn<() => void>()
      cacheProbe.cleanups.set(props.documentKey, cleanup)
      props.registerCacheCleanup(props.documentKey, cleanup)
    }, [props.documentKey])
    return createElement('textarea', {
      'data-test-central-code': '', 'data-document-key': props.documentKey, value: props.content,
      onChange: (event: { target: { value: string } }) => props.onChange(event.target.value),
      onKeyDown: (event: { key: string; ctrlKey: boolean; preventDefault(): void }) => {
        if (event.ctrlKey && event.key === 's') { event.preventDefault(); props.onSave() }
      },
    })
  },
}))

import { api } from '../src/client/api.ts'

type SessionStatus = { running: boolean | undefined; pendingInteraction?: unknown }
type SeatProps = {
  sessionId?: string
  useSessionStatus<T>(selector: (value: ReadonlyMap<string, SessionStatus>) => T): T
}
type SlotOptions = { name: string; priority?: number; children?: unknown }
type Entry = { id: number; options: SlotOptions; render(props: SeatProps): ReactElement }

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    set(next: T) { value = next; for (const fn of [...listeners]) fn() },
    get listenerCount() { return listeners.size },
  }
}

const fixtureDisposers = new Set<() => void>()

/** Declaration availability and service availability intentionally have independent lifecycles. */
function fixture() {
  const mounted = observable<string | undefined>(undefined)
  const sessions = observable({ byId: { s1: { id: 's1', cwd: '/work', displayTitle: 'First' }, s2: { id: 's2', cwd: '/other', displayTitle: 'Second' } } })
  const live = new Map<number, Entry>()
  const events: string[] = []
  let nextId = 1
  let declaration: (() => void | (() => void)) | undefined
  let offDeclaration: (() => void) | undefined
  let injection: ((scope: unknown) => unknown) | undefined
  let serviceActive = false
  const auxiliaryDeclarations = new Map<string, () => void | (() => void)>()
  const auxiliaryDisposers = new Map<string, () => void>()
  const effects = new Set<() => void>()
  const scope = {
    get: (name: string) => name === 'sidebarRight' ? { mounted } : undefined,
    effect(factory: () => () => void) {
      const off = factory()
      effects.add(off)
      return () => { if (effects.delete(off)) off() }
    },
  }
  const context = {
    slots: {
      inject: vi.fn((name: string, callback: () => void | (() => void)) => {
        if (name !== 'main.conversation') {
          auxiliaryDeclarations.set(name, callback)
          return () => {
            auxiliaryDisposers.get(name)?.()
            auxiliaryDisposers.delete(name)
            auxiliaryDeclarations.delete(name)
          }
        }
        declaration = callback
        return () => { offDeclaration?.(); offDeclaration = undefined; declaration = undefined }
      }),
      register: vi.fn((options: SlotOptions, render: Entry['render']) => {
        const id = nextId++
        events.push(`register:${id}`)
        live.set(id, { id, options, render })
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          events.push(`dispose:${id}`)
          live.delete(id)
        }
      }),
    },
    inject: vi.fn((names: string[], callback: (scope: unknown) => unknown) => {
      expect(names).toEqual(['sidebarRight'])
      injection = callback
      return { dispose: () => {
        for (const off of effects) off()
        effects.clear()
        injection = undefined
        serviceActive = false
      } }
    }),
    sessions: { list: sessions, open: vi.fn() },
  }
  const editor = registerCentralEditor(context as unknown as Context)
  fixtureDisposers.add(() => editor.dispose())
  return {
    editor, mounted, events, live, context,
    declare() {
      if (!offDeclaration) offDeclaration = declaration?.() || undefined
    },
    undeclare() { offDeclaration?.(); offDeclaration = undefined },
    provideSidebar() {
      if (!serviceActive) { serviceActive = true; injection?.(scope) }
    },
    declareAuxiliary(name: string) {
      const off = auxiliaryDeclarations.get(name)?.()
      if (off) auxiliaryDisposers.set(name, off)
    },
    currentEntry() { const entry = [...live.values()].find(item => item.options.name === 'main.conversation'); expect(entry).toBeDefined(); return entry! },
  }
}

const s1 = { sessionId: 's1', cwd: '/work' }
const s2 = { sessionId: 's2', cwd: '/other' }
let root: Root | undefined
let container: HTMLDivElement | undefined

beforeEach(() => {
  cacheProbe.cleanups.clear()
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  vi.mocked(api.fsRead).mockResolvedValue({ kind: 'text', content: 'disk content', truncated: false } as Awaited<ReturnType<typeof api.fsRead>>)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  for (const dispose of fixtureDisposers) dispose()
  fixtureDisposers.clear()
  if (root) act(() => root!.unmount())
  root = undefined
  container?.remove()
  container = undefined
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('registerCentralEditor main conversation surface', () => {
  it('refuses to open before slot declaration and before the requested session is mounted', () => {
    const f = fixture()
    f.provideSidebar()
    f.mounted.set('s1')
    expect(f.editor.openFile(s1, 'a.ts')).toBe(false)
    expect(window.alert).toHaveBeenCalledTimes(1)
    expect(f.events).toEqual([])
    f.declare()
    f.mounted.set(undefined)
    expect(f.editor.openFile(s1, 'a.ts')).toBe(false)
    f.mounted.set('s2')
    expect(f.editor.openFile(s1, 'a.ts')).toBe(false)
    expect(f.editor.isActive('s1')).toBe(false)
    expect(f.events).toEqual([])
    f.editor.dispose()
    expect(f.mounted.listenerCount).toBe(0)
  })

  it('registers exactly one priority -100 replacement without passing host children through', () => {
    const f = fixture()
    f.declare()
    // Declaration alone cannot stand in for the sidebar mounted observable.
    expect(f.editor.openFile(s1, 'a.ts')).toBe(false)
    f.provideSidebar()
    f.mounted.set('s1')
    expect(f.editor.openFile(s1, 'a.ts')).toBe(true)
    expect(f.currentEntry().options).toEqual({ name: 'main.conversation', priority: -100 })
    expect(f.currentEntry().options).not.toHaveProperty('children')
    expect(f.editor.isActive('s1')).toBe(true)
    expect(f.editor.openFile(s1, 'a.ts')).toBe(true)
    expect(f.editor.openFile(s1, 'b.ts')).toBe(true)
    f.mounted.set('s1')
    expect(f.events).toEqual(['register:1'])
    expect(f.live.size).toBe(1)
    const element = f.currentEntry().render({ sessionId: 's1', useSessionStatus: selector => selector(new Map()) })
    expect(element.props).not.toHaveProperty('children')
    f.editor.dispose()
    expect(f.events).toEqual(['register:1', 'dispose:1'])
  })

  it('rolls back visibility after a registration exception and permits a later successful retry', () => {
    const f = fixture()
    f.declare()
    f.provideSidebar()
    f.mounted.set('s1')
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    f.context.slots.register.mockImplementationOnce(options => {
      expect(options.name).toBe('main.conversation')
      throw new Error('slot registration unavailable')
    })
    expect(f.editor.openFile(s1, 'a.ts')).toBe(false)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(f.editor.isActive('s1')).toBe(false)
    expect(f.live.size).toBe(0)
    expect(f.events).toEqual([])
    // Returning from another session must not resurrect failed visibility.
    f.mounted.set('s2')
    f.mounted.set('s1')
    expect(f.editor.isActive('s1')).toBe(false)
    expect(f.live.size).toBe(0)
    expect(f.context.slots.register).toHaveBeenCalledTimes(1)
    expect(f.editor.openFile(s1, 'a.ts')).toBe(true)
    expect(f.editor.isActive('s1')).toBe(true)
    expect(f.live.size).toBe(1)
    expect(f.events).toEqual(['register:1'])
    expect(f.editor.openFile(s1, 'a.ts')).toBe(true)
    expect(f.context.slots.register).toHaveBeenCalledTimes(2)
    f.editor.dispose()
    expect(f.live.size).toBe(0)
    expect(f.events).toEqual(['register:1', 'dispose:1'])
  })

  it('releases takeover in an unedited session and restores it when returning to the original session', () => {
    const f = fixture()
    f.provideSidebar()
    f.declare()
    f.mounted.set('s1')
    f.editor.openFile(s1, 'a.ts')
    f.mounted.set('s2')
    expect(f.editor.isActive('s1')).toBe(false)
    expect(f.editor.isActive('s2')).toBe(false)
    expect(f.live.size).toBe(0)
    expect(f.events).toEqual(['register:1', 'dispose:1'])
    f.mounted.set('s1')
    expect(f.editor.isActive('s1')).toBe(true)
    expect(f.events).toEqual(['register:1', 'dispose:1', 'register:2'])
    f.mounted.set(undefined)
    expect(f.live.size).toBe(0)
    f.mounted.set('s1')
    expect(f.events).toEqual(['register:1', 'dispose:1', 'register:2', 'dispose:2', 'register:3'])
    f.editor.dispose()
    expect(f.live.size).toBe(0)
  })

  it('releases entries on declaration removal and cannot open while the declaration is absent', () => {
    const f = fixture()
    f.provideSidebar()
    f.mounted.set('s1')
    f.declare()
    f.editor.openFile(s1, '/work/a.ts')
    f.undeclare()
    expect(f.live.size).toBe(0)
    expect(f.editor.openFile(s1, 'b.ts')).toBe(false)
    expect(f.events).toEqual(['register:1', 'dispose:1'])
    f.declare()
    expect(f.events).toEqual(['register:1', 'dispose:1', 'register:2'])
    f.editor.dispose()
    expect(f.live.size).toBe(0)
  })

  it('disposes all declaration, service and view lifetimes without later resurrection', () => {
    const f = fixture()
    f.declare()
    f.provideSidebar()
    f.mounted.set('s1')
    f.editor.openFile(s1, 'a.ts')
    expect(f.mounted.listenerCount).toBe(1)
    f.declareAuxiliary('conversation.session.header.utilities')
    expect(f.live.size).toBe(2)
    f.editor.dispose()
    f.editor.dispose()
    expect(f.mounted.listenerCount).toBe(0)
    expect(f.live.size).toBe(0)
    expect(f.events).toEqual(['register:1', 'register:2', 'dispose:2', 'dispose:1'])
    f.mounted.set('s2')
    f.mounted.set('s1')
    f.declare()
    f.provideSidebar()
    expect(f.editor.openFile(s1, 'again.ts')).toBe(false)
    expect(f.editor.openFile(s2, 'again.ts')).toBe(false)
    expect(f.events).toEqual(['register:1', 'register:2', 'dispose:2', 'dispose:1'])
  })

  it('keeps writes pending across remounts, refuses pending close, and preserves typing after submission', async () => {
    const f = fixture()
    f.declare()
    f.provideSidebar()
    f.mounted.set('s1')
    f.editor.openFile(s1, 'a.ts')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const props: SeatProps = { sessionId: 's1', useSessionStatus: selector => selector(new Map()) }
    await act(async () => { root!.render(f.currentEntry().render(props)) })
    const type = (value: string) => act(() => {
      const input = container!.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const saveShortcut = () => act(() => {
      container!.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    })
    const clickClose = () => act(() => {
      container!.querySelector<HTMLButtonElement>('button[aria-label="close a.ts"]')!.click()
    })
    let resolveWrite!: () => void
    vi.mocked(api.fsWrite).mockReturnValueOnce(new Promise<{ ok: true }>(resolve => { resolveWrite = () => resolve({ ok: true }) }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const originalKey = container.querySelector('textarea')!.dataset.documentKey!
    const cleanup = cacheProbe.cleanups.get(originalKey)!
    type('submitted text')
    saveShortcut()
    expect(api.fsWrite).toHaveBeenCalledTimes(1)
    expect(api.fsWrite).toHaveBeenLastCalledWith({ sessionId: 's1', cwd: '/work' }, '/work/a.ts', 'submitted text', 'disk content')
    clickClose()
    expect(container.querySelector('[role="tab"]')).not.toBeNull()
    expect(confirm).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    act(() => {
      [...container!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'centralEditorReturn')!.click()
    })
    expect(f.editor.isActive('s1')).toBe(false)
    act(() => root!.unmount())
    root = createRoot(container)
    await act(async () => {
      f.editor.openFile(s1, 'a.ts')
      root!.render(f.currentEntry().render(props))
    })
    expect(container.querySelector('textarea')!.dataset.documentKey).toBe(originalKey)
    saveShortcut()
    expect(api.fsWrite).toHaveBeenCalledTimes(1)
    clickClose()
    expect(container.querySelector('[role="tab"]')).not.toBeNull()
    type('new input during pending save')
    await act(async () => { resolveWrite() })
    expect(container.querySelector('textarea')!.value).toBe('new input during pending save')
    expect(container.textContent).toContain('unsaved')
    expect(cleanup).not.toHaveBeenCalled()
    // Closing after settlement synchronously forgets exactly this generation.
    clickClose()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="tab"]')).toBeNull()
    act(() => root!.unmount())
    root = createRoot(container)
    await act(async () => {
      f.editor.openFile(s1, 'a.ts')
      root!.render(f.currentEntry().render(props))
    })
    const reopenedKey = container.querySelector('textarea')!.dataset.documentKey!
    expect(reopenedKey).not.toBe(originalKey)
    expect(JSON.parse(reopenedKey).slice(0, 3)).toEqual(JSON.parse(originalKey).slice(0, 3))
    expect(cacheProbe.cleanups.get(reopenedKey)).not.toHaveBeenCalled()
    await act(async () => {
      f.editor.openFile(s1, 'b.ts')
      root!.render(f.currentEntry().render(props))
    })
    const otherKey = container.querySelector('textarea')!.dataset.documentKey!
    const otherCleanup = cacheProbe.cleanups.get(otherKey)!
    expect(otherKey).not.toBe(reopenedKey)
    expect(otherCleanup).not.toHaveBeenCalled()
    f.editor.dispose()
    expect(cacheProbe.cleanups.get(reopenedKey)).toHaveBeenCalledTimes(1)
    expect(otherCleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(f.live.size).toBe(0)
  })

  it('returns to host chat for pending interaction and preserves the edited draft when reopened', async () => {
    const f = fixture()
    f.declare()
    f.provideSidebar()
    f.mounted.set('s1')
    f.editor.openFile(s1, 'a.ts')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    let statuses = new Map<string, SessionStatus>([['s1', { running: false }]])
    const props: SeatProps = { sessionId: 's1', useSessionStatus: selector => selector(statuses) }
    await act(async () => { root!.render(f.currentEntry().render(props)) })
    const input = container.querySelector('textarea')!
    expect(input.value).toBe('disk content')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(input, 'private unsaved draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('private unsaved draft')
    expect(container.textContent).toContain('unsaved')
    statuses = new Map([['s1', { running: true, pendingInteraction: { kind: 'approval' } }]])
    await act(async () => { root!.render(f.currentEntry().render(props)) })
    expect(f.editor.isActive('s1')).toBe(false)
    expect(f.live.size).toBe(0)
    expect(f.events).toEqual(['register:1', 'dispose:1'])
    // Hiding for approval must not disable the browser's dirty-draft guard.
    const hiddenUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(hiddenUnload)
    expect(hiddenUnload.defaultPrevented).toBe(true)
    act(() => f.mounted.set('s2'))
    const backgroundUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(backgroundUnload)
    expect(backgroundUnload.defaultPrevented).toBe(true)
    act(() => f.mounted.set('s1'))
    act(() => root!.unmount())
    root = createRoot(container)
    statuses = new Map([['s1', { running: false }]])
    await act(async () => {
      expect(f.editor.openFile(s1, 'a.ts')).toBe(true)
      root!.render(f.currentEntry().render(props))
    })
    expect(container.querySelector('textarea')!.value).toBe('private unsaved draft')
    expect(container.textContent).toContain('unsaved')
    expect(api.fsRead).toHaveBeenCalledTimes(1)
    expect(api.fsWrite).not.toHaveBeenCalled()
    expect(f.events).toEqual(['register:1', 'dispose:1', 'register:2'])
    f.editor.dispose()
    expect(f.live.size).toBe(0)
    const disposedUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(disposedUnload)
    expect(disposedUnload.defaultPrevented).toBe(false)
  })
})
