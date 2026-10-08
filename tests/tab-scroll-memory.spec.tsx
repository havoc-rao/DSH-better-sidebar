// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TabScrollMemory, tabScrollKey } from '../src/client/TabScrollMemory.tsx'
import { setupReactAct } from './test-utils.ts'
setupReactAct()
const roots = new Set<Root>()
let count = 0
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
})
afterEach(() => {
  act(() => { for (const root of roots) root.unmount() })
  roots.clear()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})
async function mount(session: string, options: { managed?: boolean; short?: boolean } = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.add(root)
  let visible = true
  let height = options.short ? 100 : 2000
  const render = () => root.render(createElement(TabScrollMemory, {
    scope: { sessionId: session, cwd: '/repo' }, tab: { id: `git-${count++}`, type: 'git', title: '变动' }, visible, surface: 'workbench',
    children: createElement('div', { style: { overflow: 'auto' }, 'data-dsh-scroll-key': 'list',
      ...(options.managed ? { 'data-dsh-scroll-managed': '' } : {}),
      ref: (el: HTMLDivElement | null) => {
        if (el === null) return
        let top = el.scrollTop
        Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top,
          set: (next: number) => { top = Math.max(0, Math.min(next, height - 100)) } })
      },
    }, createElement('div', null, '内容')),
  }))
  await act(async () => { render() })
  const body = container.querySelector<HTMLElement>('[data-dsh-scroll-key]')!
  return {
    body,
    scroll(top: number, left = 0) { body.scrollTop = top; body.scrollLeft = left; act(() => { body.dispatchEvent(new Event('scroll')) }) },
    async show(next: boolean) { visible = next; await act(async () => { render() }) },
    setHeight(next: number) { height = next },
    async load() { height = 2000; await act(async () => {
      body.append(document.createElement('span'))
      await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
    }) },
    close() { act(() => root.unmount()); roots.delete(root); container.remove() },
  }
}
describe('标签页通用 DOM 滚动记忆', () => {
  it('以资源身份恢复重新打开的单例 tab，保留横向与纵向位置', async () => {
    const session = `scroll-${count++}`
    const first = await mount(session)
    first.scroll(650, 42)
    first.close()
    const reopened = await mount(session)
    expect(reopened.body.scrollTop).toBe(650)
    expect(reopened.body.scrollLeft).toBe(42)
    reopened.scroll(0)
    reopened.close()
    expect((await mount(session)).body.scrollTop).toBe(0)
  })
  it('等待异步正文撑开滚动范围，不被占位高度覆盖', async () => {
    const session = `scroll-${count++}`
    const first = await mount(session)
    first.scroll(850)
    first.close()
    const reopened = await mount(session, { short: true })
    reopened.scroll(0)
    await reopened.load()
    expect(reopened.body.scrollTop).toBe(850)
    reopened.scroll(300)
    await reopened.load()
    expect(reopened.body.scrollTop).toBe(300)
  })
  it('占位正文替换后继续观察新正文的尺寸变化', async () => {
    const observers: { callback: () => void; observe: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('ResizeObserver', class {
      callback: () => void
      observe = vi.fn()
      constructor(callback: () => void) { this.callback = callback; observers.push(this) }
      disconnect() {}
    })
    try {
      const session = `resize-${count++}`
      const first = await mount(session)
      first.scroll(800)
      first.close()
      const reopened = await mount(session, { short: true })
      const child = document.createElement('div')
      await act(async () => {
        reopened.body.replaceChildren(child)
        await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
      })
      const observer = observers.at(-1)!
      expect(observer.observe).toHaveBeenCalledWith(child)
      reopened.setHeight(2000)
      await act(async () => {
        observer.callback()
        await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
      })
      expect(reopened.body.scrollTop).toBe(800)
    } finally { vi.unstubAllGlobals() }
  })
  it('用户交互取消待恢复的位置，不在加载后强制拉回', async () => {
    const session = `scroll-${count++}`
    const first = await mount(session)
    first.scroll(850)
    first.close()
    const reopened = await mount(session, { short: true })
    reopened.body.dispatchEvent(new Event('wheel', { bubbles: true }))
    reopened.scroll(0)
    await reopened.load()
    expect(reopened.body.scrollTop).toBe(0)
  })
  it('隐藏页的滚动事件不覆盖可见时的位置', async () => {
    const tree = await mount(`scroll-${count++}`)
    tree.scroll(720)
    await tree.show(false)
    tree.scroll(0)
    await tree.show(true)
    expect(tree.body.scrollTop).toBe(720)
  })
  it('尊重自有滚动管理区域', async () => {
    const session = `scroll-${count++}`
    const first = await mount(session, { managed: true })
    first.scroll(700)
    first.close()
    expect((await mount(session, { managed: true })).body.scrollTop).toBe(0)
  })
  it('同一提议 diff 更新正文和标题不会更换记忆身份', () => {
    const scope = { sessionId: 's', cwd: '/repo' }
    const tab = { id: 'diff', type: 'diff', title: '差异', diff: {
      kind: 'proposed' as const, id: 'patch-1', title: '旧标题', patch: '旧正文',
    } }
    const key = tabScrollKey(scope, tab, 'native')
    expect(tabScrollKey(scope, { ...tab, diff: { ...tab.diff, title: '新标题', patch: '新正文' } }, 'native')).toBe(key)
    expect(tabScrollKey(scope, { ...tab, diff: { ...tab.diff, id: 'patch-2' } }, 'native')).not.toBe(key)
  })
  it('会话、工作目录、承载面和文件路径不会串位', () => {
    const tab = { id: 'editor', type: 'editor', title: '文件', path: '/repo/a.ts' }
    const key = tabScrollKey({ sessionId: 's', cwd: '/repo' }, tab, 'native')
    expect(tabScrollKey({ sessionId: 'other', cwd: '/repo' }, tab, 'native')).not.toBe(key)
    expect(tabScrollKey({ sessionId: 's', cwd: '/other' }, tab, 'native')).not.toBe(key)
    expect(tabScrollKey({ sessionId: 's', cwd: '/repo' }, tab, 'workbench')).not.toBe(key)
    expect(tabScrollKey({ sessionId: 's', cwd: '/repo' }, { ...tab, path: '/repo/b.ts' }, 'native')).not.toBe(key)
  })
})
