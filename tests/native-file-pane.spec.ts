/** Existing docked split placement: source-relative, session isolated, no
 * splitting or private layout writes; the native resource registry owns claims.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { openFileInOtherPane } from '../src/client/native/file-pane.ts'

function setup(markup: string, mounted = 's') {
  document.body.innerHTML = markup
  const openResource = vi.fn()
  const api = { openResource, mounted: { getSnapshot: () => mounted } }
  const ctx = {
    get: (key: string) => key === 'sidebarRight' ? api : undefined,
    sessions: { list: { getSnapshot: () => ({ byId: { s: { cwd: '/repo' } } }) } },
  } as unknown as Context
  const open = () => openFileInOtherPane(ctx, 's', document.getElementById('root'), '/worktree', '/worktree/a.drawio')
  return { openResource, open }
}

afterEach(() => { document.body.replaceChildren() })

describe('Files opens in the other existing pane', () => {
  it.each(['left', 'right'])('opens opposite the %s source, not opposite the active pane', source => {
    const { open, openResource } = setup(`<div data-sidebar-right-session="s">
      <div data-dockkit-pane="left" data-dockkit-pane-active>${source === 'left' ? '<div id="root"></div>' : ''}</div>
      <div data-dockkit-pane="right">${source === 'right' ? '<div id="root"></div>' : ''}</div>
    </div>`)
    expect(open()).toBe(true)
    expect(openResource).toHaveBeenCalledExactlyOnceWith(
      'dsh-resource://file/session/s//worktree/a.drawio',
      { paneId: source === 'left' ? 'right' : 'left' },
    )
  })

  it.each([
    '<div data-sidebar-right-session="s"><div data-dockkit-pane="one"><div id="root"></div></div><div data-dockkit-float="float"></div></div>',
    '<div data-sidebar-right-session="s"><div data-dockkit-float="float"><div id="root"></div></div><div data-dockkit-pane="one"></div><div data-dockkit-pane="two"></div></div>',
    '<div data-sidebar-right-session="s"><div data-dockkit-pane="one"><div id="root"></div></div></div><div data-sidebar-right-session="other"><div data-dockkit-pane="two"></div></div>',
    '<div id="root"></div>',
  ])('leaves single-pane, floating and non-native windows untouched (%#)', markup => {
    const { open, openResource } = setup(markup)
    expect(open()).toBe(false)
    expect(openResource).not.toHaveBeenCalled()
  })

  it('does not open into the mounted session from a parked session body', () => {
    const { open, openResource } = setup('<div data-sidebar-right-session="s"><div data-dockkit-pane="one"><div id="root"></div></div><div data-dockkit-pane="two"></div></div>', 'other')
    expect(open()).toBe(false)
    expect(openResource).not.toHaveBeenCalled()
  })

  it('targets the other group even when its docked host is hidden/inert in compact mode', () => {
    const { open, openResource } = setup(`<div data-sidebar-right-session="s">
      <div data-dockkit-host="dock"><div data-dockkit-pane="files"><div id="root"></div></div></div>
      <div data-dockkit-host="dock" hidden><div data-dockkit-pane="preview" inert aria-hidden="true"></div></div>
    </div>`)
    expect(open()).toBe(true)
    // Do not filter hidden panes: opening with paneId asks the host to select
    // the other group. No plugin layout mutation or visibility override.
    expect(openResource).toHaveBeenCalledExactlyOnceWith(
      'dsh-resource://file/session/s//worktree/a.drawio', { paneId: 'preview' },
    )
  })

  it('resolves the source again after the kept body moves', () => {
    const { open, openResource } = setup('<div data-sidebar-right-session="s"><div data-dockkit-pane="one"><div id="root"></div></div><div data-dockkit-pane="two"></div></div>')
    open()
    document.querySelector('[data-dockkit-pane="two"]')!.append(document.getElementById('root')!)
    open()
    expect(openResource.mock.calls.map(call => call[1])).toEqual([{ paneId: 'two' }, { paneId: 'one' }])
  })
})
