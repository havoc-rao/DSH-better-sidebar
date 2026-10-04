// @vitest-environment jsdom
import { StrictMode, useEffect } from 'react'
import type { ComponentType } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { GitActionSlotBridge, GitActionSlotHost } from '../src/client/changes/git-action-slot.tsx'
import type { GitActionSlotProps, GitActionSlotRenderProps } from '../src/client/changes/git-action-slot.tsx'
import { registerBottomToggle } from '../src/client/sidebar/bottom-toggle.tsx'
import type { Context } from '../src/context-types.ts'
import type { SidebarStore } from '../src/client/state.ts'

vi.mock('../src/client/Sidebar.tsx', () => ({ BottomDockToggle: () => <button>dock</button> }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const roots: Root[] = []
function root() {
  const node = document.createElement('div')
  document.body.append(node)
  const instance = createRoot(node)
  roots.push(instance)
  return { node, instance }
}
function unmount(instance: Root) {
  act(() => instance.unmount())
  roots.splice(roots.indexOf(instance), 1)
}
afterEach(() => {
  act(() => { for (const instance of roots.splice(0)) instance.unmount() })
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
function owner(scope = 'lens-session'): GitActionSlotProps {
  return {
    scope: { sessionId: scope, cwd: '/repo' },
    status: { isRepo: true, entries: [] },
    staged: [],
    commitMessage: 'initial', setCommitMessage: vi.fn(), busy: false,
    runAction: async action => { await action() }, refresh: vi.fn(async () => {}), close: vi.fn(),
  } as GitActionSlotProps
}
// Test dispatchers implement this one concrete key; the host type is generic
// across SlotMap keys, whose conditional owner type TS cannot reduce in mocks.
function dispatcher(fn: (name: 'betterSidebar.git.actions', owner: GitActionSlotProps) => React.ReactNode): GitActionSlotRenderProps['renderSlot'] {
  return fn as GitActionSlotRenderProps['renderSlot']
}
const renderSlot = dispatcher((_name, props) =>
  <button disabled={props.busy} onClick={() => props.setCommitMessage('edited')}>{props.commitMessage}</button>)

describe('Git action slot DOM bridge', () => {
  it('portals into independent createRoot seats and updates live owner without remounting controls', () => {
    const header = root(), workbench = root()
    const mounted = vi.fn(), cleaned = vi.fn()
    function Action(props: GitActionSlotProps) {
      useEffect(() => { mounted(); return cleaned }, [])
      return <button onClick={() => props.setCommitMessage('edited')}>{props.commitMessage}:{props.scope.sessionId}</button>
    }
    const dispatch = dispatcher((name, props) => {
      expect(name).toBe('betterSidebar.git.actions')
      return <Action {...props} />
    })
    const initial = owner()
    act(() => {
      header.instance.render(<GitActionSlotBridge renderSlot={dispatch} />)
      workbench.instance.render(<GitActionSlotHost owner={initial} />)
    })
    expect(workbench.node.textContent).toBe('initial:lens-session')
    expect(header.node.textContent).toBe('')
    const updated = { ...initial, commitMessage: 'live', busy: true }
    act(() => workbench.instance.render(<GitActionSlotHost owner={updated} />))
    expect(workbench.node.textContent).toBe('live:lens-session')
    act(() => workbench.node.querySelector('button')!.click())
    expect(updated.setCommitMessage).toHaveBeenCalledWith('edited')
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(cleaned).not.toHaveBeenCalled()
    unmount(workbench.instance)
    expect(cleaned).toHaveBeenCalledTimes(1)
  })

  it('removes portals on bridge disposal and restores retained seats on reload', () => {
    const header = root(), workbench = root()
    act(() => {
      workbench.instance.render(<GitActionSlotHost owner={owner()} />)
      header.instance.render(<GitActionSlotBridge renderSlot={renderSlot} />)
    })
    expect(workbench.node.textContent).toBe('initial')
    unmount(header.instance)
    expect(workbench.node.textContent).toBe('')
    const replacement = root()
    act(() => replacement.instance.render(<GitActionSlotBridge renderSlot={renderSlot} />))
    expect(workbench.node.textContent).toBe('initial')
    unmount(workbench.instance)
    const fresh = root()
    act(() => fresh.instance.render(<GitActionSlotHost owner={owner('replacement')} />))
    expect(fresh.node.querySelectorAll('button')).toHaveLength(1)
    expect(workbench.node.textContent).toBe('')
  })

  it('elects one bridge across retained headers and hands over on disposal', () => {
    const first = root(), second = root(), workbench = root()
    act(() => {
      first.instance.render(<GitActionSlotBridge renderSlot={renderSlot} />)
      second.instance.render(<GitActionSlotBridge renderSlot={renderSlot} />)
      workbench.instance.render(<GitActionSlotHost owner={owner()} />)
    })
    expect(workbench.node.querySelectorAll('button')).toHaveLength(1)
    unmount(first.instance)
    expect(workbench.node.querySelectorAll('button')).toHaveLength(1)
    unmount(second.instance)
    expect(workbench.node.querySelectorAll('button')).toHaveLength(0)
  })

  it('survives StrictMode setup/cleanup replay without losing seats', () => {
    const header = root(), workbench = root()
    act(() => {
      header.instance.render(<StrictMode><GitActionSlotBridge renderSlot={renderSlot} /></StrictMode>)
      workbench.instance.render(<StrictMode><GitActionSlotHost owner={owner()} /></StrictMode>)
    })
    expect(workbench.node.querySelectorAll('button')).toHaveLength(1)
    unmount(workbench.instance)
    const next = root()
    act(() => next.instance.render(<GitActionSlotHost owner={owner()} />))
    expect(next.node.querySelectorAll('button')).toHaveLength(1)
  })

  it('contains synchronous dispatch errors independently for each seat', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const suppressExpectedError = (event: ErrorEvent) => { event.preventDefault() }
    window.addEventListener('error', suppressExpectedError)
    const header = root(), broken = root(), healthy = root()
    const dispatch = dispatcher((name, props) => {
      if (props.commitMessage === 'broken') throw new Error('stale authorization / consumer crash')
      return renderSlot(name, props)
    })
    act(() => {
      header.instance.render(<GitActionSlotBridge renderSlot={dispatch} />)
      broken.instance.render(<GitActionSlotHost owner={{ ...owner(), commitMessage: 'broken' }} />)
      healthy.instance.render(<GitActionSlotHost owner={owner()} />)
    })
    expect(broken.node.textContent).toBe('')
    expect(healthy.node.textContent).toBe('initial')
    window.removeEventListener('error', suppressExpectedError)
  })

  it('declares one real DSH root/list child and cascades disposal/redeclaration without orphan entries', () => {
    const core = new SlotCore()
    const registerShell = core.register.bind(core) as unknown as Context['slots']['register']
    const shellDispose = registerShell({ name: 'root', children: {
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    } }, (_props: unknown) => null)
    const ctx = { slots: {
      inject: (_name: string, callback: () => () => void) => callback(),
      // Production Context has a structural face; the real core proves child
      // declaration uniqueness and cascade semantics, not a hand-written Map.
      register: core.register.bind(core),
    } } as unknown as Context
    const header = root(), workbench = root()
    const mount = () => {
      const dispose = registerBottomToggle(ctx, {} as SidebarStore)
      const entry = core.entries('conversation.session.header.utilities')[0]!
      const Entry = entry.component as ComponentType<GitActionSlotRenderProps>
      act(() => header.instance.render(<Entry renderSlot={renderSlot} />))
      return dispose
    }
    const dispose = mount()
    expect(core.spec('betterSidebar.git.actions')).toEqual({ kind: 'list', scope: 'root' })
    const actionDispose = core.register({ name: 'betterSidebar.git.actions', id: 'consumer' }, () => null)
    act(() => workbench.instance.render(<><GitActionSlotHost owner={owner('one')} /><GitActionSlotHost owner={owner('two')} /></>))
    expect(core.entries('conversation.session.header.utilities')).toHaveLength(1)
    expect(workbench.node.querySelectorAll('button')).toHaveLength(2)
    act(() => { dispose(); header.instance.render(null) })
    expect(core.spec('betterSidebar.git.actions')).toBeUndefined()
    expect(core.entries('betterSidebar.git.actions')).toHaveLength(0)
    expect(workbench.node.textContent).toBe('')
    actionDispose() // stale consumer cleanup is harmless after cascade
    const reloadDispose = mount()
    expect(workbench.node.querySelectorAll('button')).toHaveLength(2)
    act(() => { reloadDispose(); header.instance.render(null) })
    shellDispose()
  })
})
