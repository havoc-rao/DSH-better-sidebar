// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
import { TabBar } from '../src/client/TabBar.tsx'

setupReactAct()

describe('workbench tab icon alignment', () => {
  it('centres wrapped SVG icons without inline descender space or empty icon slots', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      act(() => {
        root.render(createElement(TabBar, {
          paneId: 'p1', active: 'terminal',
          tabs: [
            { id: 'terminal', type: 'terminal', title: 'zsh' },
            { id: 'plain', type: 'plain', title: 'Plain' },
          ],
          onActivate: () => {}, onClose: () => {}, onNewTab: () => {},
          onDropTab: () => {}, newTabOptions: [],
          getTabIcon: tab => tab.id === 'terminal'
            ? createElement('span', null, createElement('svg', { width: 14, height: 14 }))
            : null,
        }))
      })
      const tabs = host.querySelectorAll('[role="tab"]')
      const icon = tabs[0]!.querySelector('[class*="tabIcon"]')
      expect(icon?.querySelector('span > svg')).not.toBeNull()
      expect(icon?.getAttribute('aria-hidden')).toBe('true')
      expect(tabs[1]!.querySelector('[class*="tabIcon"]')).toBeNull()
      // jsdom has no layout engine: pin the line-box fix on the rendered class.
      const css = readFileSync(resolve('src/client/sidebar.module.css'), 'utf8')
      const rule = css.match(/\.tabIcon\s*\{([^}]+)\}/)?.[1] ?? ''
      expect(rule).toMatch(/display:\s*inline-flex\s*;/)
      expect(rule).toMatch(/align-items:\s*center\s*;/)
      expect(rule).toMatch(/line-height:\s*0\s*;/)
    } finally {
      act(() => { root.unmount() })
      host.remove()
    }
  })
})
