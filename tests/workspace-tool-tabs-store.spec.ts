/**
 * Tool membership is browser/workspace state, not session state: undefined is
 * uninitialized, [] is explicitly closed, and stale seeds must never reopen it.
 * Per-kind writes merge concurrent stores; external notifications never echo.
 * This pure store has no DOM, storage globals, timers, or unbounded read cache.
 */
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceToolTabsStore } from '../src/client/workspace-tool-tabs-store'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
  }
}

function storageEvents() {
  const listeners = new Set<() => void>()
  const unsubscribe = vi.fn()
  return {
    unsubscribe,
    subscribeStorage(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener); unsubscribe() }
    },
    emit() { for (const listener of [...listeners]) listener() },
  }
}

describe('workspace tool tabs store', () => {
  it('distinguishes absent state from explicitly closed membership', () => {
    const storage = memoryStorage()
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'profile' })
    expect(store.read('workspace')).toBeUndefined()
    store.set('workspace', 'files', false)
    expect(store.read('workspace')).toEqual([])
    expect(createWorkspaceToolTabsStore({ storage, namespace: 'profile' }).read('workspace')).toEqual([])
  })

  it('persists each kind separately and returns deterministic files/git order', () => {
    const storage = memoryStorage()
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'profile' })
    store.set('workspace', 'git', true)
    store.set('workspace', 'files', true)
    expect(store.read('workspace')).toEqual(['files', 'git'])
    expect(storage.data.size).toBe(2)
    expect([...storage.data.values()].map(value => JSON.parse(value))).toEqual([
      { version: 1, open: true }, { version: 1, open: true },
    ])
    store.set('workspace', 'files', false)
    expect(store.read('workspace')).toEqual(['git'])
    expect(createWorkspaceToolTabsStore({ storage, namespace: 'profile' }).read('workspace')).toEqual(['git'])
  })

  it('merges interleaved different-kind edits without overwriting the other kind', () => {
    const storage = memoryStorage()
    const a = createWorkspaceToolTabsStore({ storage, namespace: 'profile' })
    const b = createWorkspaceToolTabsStore({ storage, namespace: 'profile' })
    a.seed('w', [])
    expect(b.read('w')).toEqual([])
    a.set('w', 'files', true)
    b.set('w', 'git', true)
    expect(a.read('w')).toEqual(['files', 'git'])
    a.set('w', 'files', false)
    b.set('w', 'git', false)
    expect(a.read('w')).toEqual([])
    expect(b.read('w')).toEqual([])
  })

  it('isolates workspaces and namespaces, including delimiter and Unicode keys', () => {
    const storage = memoryStorage()
    const a = createWorkspaceToolTabsStore({ storage, namespace: 'a:b' })
    const b = createWorkspaceToolTabsStore({ storage, namespace: 'a' })
    a.set('c', 'files', true)
    b.set('b:c', 'git', true)
    const awkward = '\u0000"\\/中文😀\ud800'
    a.set(awkward, 'git', true)
    const c = createWorkspaceToolTabsStore({ storage, namespace: awkward })
    c.set('', 'files', false)
    expect(a.read('c')).toEqual(['files'])
    expect(b.read('b:c')).toEqual(['git'])
    expect(a.read(awkward)).toEqual(['git'])
    expect(c.read('')).toEqual([])
    expect(a.read('other')).toBeUndefined()
    expect(storage.data.size).toBe(4)
  })

  it('seeds both kind records once, coalescing notification and ignoring later seeds', () => {
    const storage = memoryStorage()
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'profile' })
    const listener = vi.fn()
    store.subscribe(listener)
    store.seed('w', ['git', 'git'])
    expect(store.read('w')).toEqual(['git'])
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(1)
    store.seed('w', ['files'])
    expect(store.read('w')).toEqual(['git'])
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('initializes empty seeds as two closed records so stale sessions cannot resurrect tools', () => {
    const storage = memoryStorage()
    createWorkspaceToolTabsStore({ storage, namespace: 'p' }).seed('w', [])
    expect(storage.data.size).toBe(2)
    expect([...storage.data.values()].every(value => JSON.parse(value).open === false)).toBe(true)
    const stale = createWorkspaceToolTabsStore({ storage, namespace: 'p' })
    stale.seed('w', ['files', 'git'])
    expect(stale.read('w')).toEqual([])
    expect(storage.setItem).toHaveBeenCalledTimes(2)
  })

  it('does not seed over a partially initialized explicit close', () => {
    const storage = memoryStorage()
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'p' })
    store.set('w', 'files', false)
    store.seed('w', ['files', 'git'])
    expect(store.read('w')).toEqual([])
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it('writes and notifies only when a kind changes, including initialization to false', () => {
    const storage = memoryStorage()
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'p' })
    const listener = vi.fn()
    store.subscribe(listener)
    store.set('w', 'files', false)
    store.set('w', 'files', false)
    store.set('w', 'files', true)
    store.set('w', 'files', true)
    expect(storage.setItem).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it.each(['oops', 'null', '[]', 'true', '{}', '{"version":2,"open":true}', '{"version":1,"open":"true"}', '{"open":true}'])(
    'treats malformed or unsupported record %s as absent', raw => {
      const storage = memoryStorage()
      const store = createWorkspaceToolTabsStore({ storage, namespace: 'p' })
      store.seed('w', [])
      for (const key of storage.data.keys()) storage.data.set(key, raw)
      expect(store.read('w')).toBeUndefined()
      store.seed('w', ['files'])
      expect(store.read('w')).toEqual(['files'])
    },
  )

  it('retains valid kind membership if the other record is corrupt', () => {
    const storage = memoryStorage()
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'p' })
    store.set('w', 'files', true)
    store.set('w', 'git', true)
    storage.data.set([...storage.data.keys()][1]!, '{"version":2,"open":true}')
    expect(store.read('w')).toEqual(['files'])
  })

  it('rereads disk without an event and observes deletions rather than caching stale state', () => {
    const storage = memoryStorage()
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'p' })
    store.seed('w', ['files'])
    expect(store.read('w')).toEqual(['files'])
    storage.data.clear()
    expect(store.read('w')).toBeUndefined()
  })

  it('forwards external events without an echo write and subscribers read fresh disk', () => {
    const storage = memoryStorage()
    const events = storageEvents()
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'p', subscribeStorage: events.subscribeStorage })
    const states: unknown[] = []
    store.subscribe(() => states.push(store.read('w')))
    const other = createWorkspaceToolTabsStore({ storage, namespace: 'p' })
    other.set('w', 'git', true)
    storage.setItem.mockClear()
    events.emit()
    expect(states).toEqual([['git']])
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('unsubscribes listeners and disposes its external subscription exactly once', () => {
    const events = storageEvents()
    const store = createWorkspaceToolTabsStore({ namespace: 'p', subscribeStorage: events.subscribeStorage })
    const listener = vi.fn()
    const stop = store.subscribe(listener)
    stop()
    events.emit()
    expect(listener).not.toHaveBeenCalled()
    store.subscribe(listener)
    store.dispose()
    store.dispose()
    store.subscribe(listener)
    events.emit()
    store.set('w', 'files', true)
    expect(listener).not.toHaveBeenCalled()
    expect(events.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('supports storage-less pure page-memory operation', () => {
    const store = createWorkspaceToolTabsStore({ namespace: 'p' })
    store.seed('w', ['git'])
    store.set('w', 'files', true)
    expect(store.read('w')).toEqual(['files', 'git'])
    store.set('w', 'git', false)
    expect(store.read('w')).toEqual(['files'])
    expect(createWorkspaceToolTabsStore({ namespace: 'p' }).read('w')).toBeUndefined()
  })

  it('falls back gracefully when both storage reads and writes are denied', () => {
    const storage = {
      getItem: vi.fn((): string | null => { throw new Error('denied') }),
      setItem: vi.fn(() => { throw new Error('denied') }),
    }
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'p' })
    expect(store.read('w')).toBeUndefined()
    store.seed('w', [])
    store.seed('w', ['files', 'git'])
    expect(store.read('w')).toEqual([])
    store.set('w', 'git', true)
    expect(store.read('w')).toEqual(['git'])
    store.set('w', 'git', true)
    expect(storage.setItem).toHaveBeenCalledTimes(3)
  })

  it('retains local edits when reads are denied independently of successful writes', () => {
    const storage = {
      getItem: vi.fn((): string | null => { throw new Error('read denied') }),
      setItem: vi.fn(),
    }
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'p' })
    store.seed('w', ['files'])
    expect(store.read('w')).toEqual(['files'])
    store.set('w', 'git', true)
    expect(store.read('w')).toEqual(['files', 'git'])
  })

  it('retains failed writes over readable stale disk and retries on the next changed write', () => {
    const storage = memoryStorage()
    const store = createWorkspaceToolTabsStore({ storage, namespace: 'p' })
    store.seed('w', ['files'])
    storage.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    store.set('w', 'files', false)
    expect(store.read('w')).toEqual([])
    store.seed('w', ['files'])
    expect(store.read('w')).toEqual([])
    store.set('w', 'files', true)
    expect(store.read('w')).toEqual(['files'])
    expect(createWorkspaceToolTabsStore({ storage, namespace: 'p' }).read('w')).toEqual(['files'])
  })

  it('bounds memory fallback to 64 workspaces, retaining both kind records together', () => {
    const store = createWorkspaceToolTabsStore({ namespace: 'p' })
    for (let index = 0; index < 65; index++) store.seed(`w${index}`, ['files', 'git'])
    expect(store.read('w0')).toBeUndefined()
    expect(store.read('w1')).toEqual(['files', 'git'])
    expect(store.read('w64')).toEqual(['files', 'git'])
  })
})
