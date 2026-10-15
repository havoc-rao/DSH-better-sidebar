// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { useNativeSidebarOpen } from '../src/client/sidebar/use-native-column.ts'

setupReactAct()

describe('native sidebar public snapshot subscription', () => {
  it('reads initial state, reacts synchronously, and unsubscribes on unmount', () => {
    let expanded = true
    const listeners = new Set<() => void>()
    const source = {
      getSnapshot: () => expanded,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const ctx = { get: () => ({ expanded: source }) }
    function Probe() {
      const open = useNativeSidebarOpen(ctx as never)
      return createElement('span', { 'data-open': String(open) })
    }
    const view = renderRoot(createElement(Probe))
    try {
      expect(document.querySelector('[data-open]')?.getAttribute('data-open')).toBe('true')
      expect(listeners.size).toBe(1)
      act(() => {
        expanded = false
        for (const listener of listeners) listener()
      })
      expect(document.querySelector('[data-open]')?.getAttribute('data-open')).toBe('false')
    } finally {
      view.unmount()
    }
    expect(listeners.size).toBe(0)
  })
})
