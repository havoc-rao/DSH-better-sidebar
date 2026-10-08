// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

const { fsTrees } = vi.hoisted(() => ({ fsTrees: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({
  api: { fsTrees, gitStatus: async () => ({ isRepo: false, entries: [] }) },
  downloadUrl: () => '/sidebar/file',
}))

const roots = new Set<Root>()
let sequence = 0
beforeEach(() => {
  // jsdom has no layout. A loaded listing supplies the scrollable geometry.
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
  fsTrees.mockImplementation(async (_scope: unknown, paths: string[]) => listing(paths))
})
afterEach(() => {
  act(() => { for (const root of roots) root.unmount() })
  roots.clear()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  fsTrees.mockReset()
})
function listing(paths: string[]) {
  return { levels: paths.map(path => ({ path, entries: [
    { name: 'file.ts', path: `${path}/file.ts`, isDir: false },
  ], truncated: false })) }
}
async function mount(sessionId: string, cwd = '/workspace', expanded: string[] = []) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.add(root)
  const render = (visible: boolean, hidden = false) => root.render(createElement(FileTree, {
    sessionId, cwd, expanded, revealed: [], onToggle: () => {}, onOpenFile: () => {},
    onReferenceFile: () => {}, refreshTick: 0, onUploadRequest: () => {}, busy: false,
    visible, hidden,
  }))
  await act(async () => { render(true) })
  const body = container.querySelector<HTMLDivElement>('[data-dsh-file-tree]')!
  return {
    body,
    async show(visible: boolean, hidden = false) { await act(async () => { render(visible, hidden) }) },
    scroll(top: number) {
      body.scrollTop = top
      act(() => { body.dispatchEvent(new Event('scroll', { bubbles: true })) })
    },
    close() { act(() => { root.unmount() }); roots.delete(root); container.remove() },
  }
}

describe('Files scroll position across body remounts', () => {
  it('restores the position when Files is closed and opened again', async () => {
    const session = `scroll-${sequence++}`
    const first = await mount(session)
    first.scroll(640)
    first.close()
    const reopened = await mount(session)
    expect(reopened.body.scrollTop).toBe(640)
    reopened.scroll(0)
    reopened.close()
    expect((await mount(session)).body.scrollTop).toBe(0)
  })

  it('waits for the expanded listings and ignores loading-time scroll resets', async () => {
    const session = `scroll-${sequence++}`
    const first = await mount(session, '/workspace', ['/workspace/src'])
    first.scroll(900)
    first.close()
    let resolve!: (value: ReturnType<typeof listing>) => void
    fsTrees.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const reopened = await mount(session, '/workspace', ['/workspace/src'])
    reopened.scroll(0)
    expect(reopened.body.scrollTop).toBe(0)
    await act(async () => { resolve(listing(['/workspace', '/workspace/src'])) })
    expect(reopened.body.scrollTop).toBe(900)
  })

  it('restores a parked tab or search-hidden tree without recording its zero', async () => {
    const tree = await mount(`scroll-${sequence++}`)
    tree.scroll(720)
    await tree.show(false)
    tree.scroll(0)
    await tree.show(true)
    expect(tree.body.scrollTop).toBe(720)
    await tree.show(true, true)
    tree.scroll(0)
    await tree.show(true)
    expect(tree.body.scrollTop).toBe(720)
  })

  it('does not share positions across sessions or working directories', async () => {
    const session = `scroll-${sequence++}`
    const first = await mount(session)
    first.scroll(450)
    first.close()
    expect((await mount(`${session}-other`)).body.scrollTop).toBe(0)
    expect((await mount(session, '/other')).body.scrollTop).toBe(0)
    expect((await mount(session)).body.scrollTop).toBe(450)
  })
})
