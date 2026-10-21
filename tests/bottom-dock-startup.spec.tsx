// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { BottomDockEntry } from '../src/client/sidebar/BottomDockEntry.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { loadBootDecision } from '../src/client/prefs.ts'

setupReactAct()

describe('bottom entry startup', () => {
  it('shows before boot settings resolve and preserves an early toggle', async () => {
    const store = createSidebarStore()
    const listeners = new Set<() => void>()
    let selected = 'startup-a'
    const mounted = {
      getSnapshot: () => selected,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const header = {
      getSnapshot: () => ({ sessionId: selected, phase: 'blank', chromeVisible: false, cornerAvailable: true }),
      subscribe: () => () => {},
    }
    // Stable snapshots, just like the public host contract.
    let headerSnapshot = header.getSnapshot()
    header.getSnapshot = () => headerSnapshot
    const ctx = {
      get: (name: string) => name === 'sidebarRight' ? { mounted }
        : name === 'uiConversation' ? { header } : undefined,
      sessions: { list: { subscribe: () => () => {} } },
    }
    let resolveSettings!: (value: { value: object; externalDisable: boolean }) => void
    const settingsGet = vi.fn(() => new Promise<{ value: object; externalDisable: boolean }>(resolve => { resolveSettings = resolve }))
    const pendingBoot = loadBootDecision({ settingsGet } as never)
    const view = renderRoot(createElement(BottomDockEntry, { ctx: ctx as never, store }))
    try {
      const button = document.querySelector<HTMLButtonElement>('[data-dsh-bottom-toggle]')
      expect(button, 'entry must not wait for the settings RPC').not.toBeNull()
      expect(store.getSnapshot().sessionId).toBe('startup-a')
      act(() => { button!.click() })
      expect(store.getSnapshot().state?.bottomOpen).toBe(true)
      resolveSettings({ value: {}, externalDisable: false })
      const decision = await pendingBoot
      act(() => { store.setPrefs(decision.prefs) })
      expect(store.getSnapshot().state?.bottomOpen).toBe(true)
      act(() => {
        selected = 'startup-b'
        headerSnapshot = { ...headerSnapshot, sessionId: selected }
        for (const listener of listeners) listener()
      })
      expect(store.getSnapshot().sessionId).toBe('startup-b')
      expect(store.getSnapshot().state?.bottomOpen).toBe(false)
    } finally {
      view.unmount()
    }
    expect(listeners.size).toBe(0)
  })
})
