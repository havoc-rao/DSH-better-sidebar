import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { SessionScope } from './api.ts'
import type { SidebarDiffRef, SidebarTab } from './state.ts'
import css from './sidebar.module.css'

type Position = { top: number; left: number }
const memory = new Map<string, Map<string, Position>>()
const MAX_TABS = 100
const MAX_CONTAINERS = 64

export function diffScrollIdentity(diff: SidebarDiffRef): unknown[] {
  return [diff.kind, diff.repoRoot, diff.worktree,
    ...(diff.kind === 'worktree' ? [diff.path, diff.staged]
      : diff.kind === 'commit' ? [diff.hashFull] : [diff.id])]
}

/** Resource identity, not the native tab's ephemeral id (closing/reopening survives). */
export function tabScrollKey(scope: SessionScope, tab: SidebarTab, surface: string): string {
  const meta = tab.meta as { threadId?: string; terminalId?: string } | undefined
  return JSON.stringify([surface, scope.sessionId, scope.cwd, tab.type,
    tab.path ?? (tab.diff === undefined ? undefined : diffScrollIdentity(tab.diff)) ?? meta?.threadId ?? meta?.terminalId ??
    (['git', 'subagent', 'workspace-terminals', 'editor'].includes(tab.type) ? tab.type : tab.id)])
}

/** Common DOM scroll memory for native and workbench plugin tabs. Specialized
 * tree/editor/terminal scrollers opt out and retain their own semantics. */
export function TabScrollMemory({ scope, tab, visible, surface, children }: {
  scope: SessionScope; tab: SidebarTab; visible: boolean; surface: string; children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const key = tabScrollKey(scope, tab, surface)
  useLayoutEffect(() => {
    const host = ref.current
    if (host === null || !visible) return
    const saved = memory.get(key) ?? new Map<string, Position>()
    const restored = new WeakMap<HTMLElement, string>()
    const observed = new WeakSet<HTMLElement>()
    let restoring = false
    let sizes: ResizeObserver | undefined
    const ignored = (el: HTMLElement) => el.closest(
      '[data-dsh-file-tree], [data-dsh-scroll-managed], .cm-editor, .xterm',
    ) !== null
    // Class names distinguish independent lists/lenses; structural segments
    // distinguish two same-class scrollers without depending on row content.
    const locator = (el: HTMLElement): string => {
      const parts: string[] = []
      for (let node: HTMLElement | null = el; node !== null && node !== host; node = node.parentElement) {
        const siblings = node.parentElement?.children
        const index = siblings === undefined ? 0 : [...siblings].filter(sibling =>
          sibling.tagName === node!.tagName && sibling.className === node!.className,
        ).indexOf(node)
        const explicit = node.getAttribute('data-dsh-scroll-key')
        parts.push(explicit === null ? `${node.tagName}.${node.className}:${index}` : `key:${explicit}`)
        if (explicit !== null) break
      }
      return parts.reverse().join('/')
    }
    const usable = (el: HTMLElement) => !ignored(el) && el.clientHeight > 0 &&
      /auto|scroll/.test(`${getComputedStyle(el).overflowY} ${getComputedStyle(el).overflowX} ${getComputedStyle(el).overflow}`)
    const restore = () => {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_ELEMENT, {
        acceptNode: node => ignored(node as HTMLElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      })
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const el = node as HTMLElement
        const id = locator(el)
        if (restored.get(el) === id || !usable(el)) continue
        if (!observed.has(el)) {
          observed.add(el)
          sizes?.observe(el)
        }
        // Async rendering replaces placeholder children while the scroller's
        // fixed viewport stays the same size. Observe each new content child.
        for (const child of el.children) {
          if (child instanceof HTMLElement && !observed.has(child)) {
            observed.add(child)
            sizes?.observe(child)
          }
        }
        const position = saved.get(locator(el))
        if (position === undefined) continue
        // Keep the target pending while an async placeholder is too short.
        restoring = true
        el.scrollTop = position.top
        el.scrollLeft = position.left
        if (el.scrollTop === position.top && el.scrollLeft === position.left) {
          restored.set(el, locator(el))
          el.dispatchEvent(new Event('scroll'))
        }
        restoring = false
      }
    }
    const onScroll = (event: Event) => {
      const el = event.target
      if (restoring || !(el instanceof HTMLElement) || !usable(el)) return
      const id = locator(el)
      if (saved.has(id) && restored.get(el) !== id) return
      saved.set(id, { top: el.scrollTop, left: el.scrollLeft })
      if (saved.size > MAX_CONTAINERS) saved.delete(saved.keys().next().value!)
      memory.delete(key)
      memory.set(key, saved)
      if (memory.size > MAX_TABS) memory.delete(memory.keys().next().value!)
      restored.set(el, locator(el))
    }
    const cancelPending = (event: Event) => {
      for (let el = event.target instanceof HTMLElement ? event.target : null; el !== null && el !== host; el = el.parentElement) {
        if (usable(el)) restored.set(el, locator(el))
      }
    }
    host.addEventListener('scroll', onScroll, true)
    host.addEventListener('wheel', cancelPending, true)
    host.addEventListener('pointerdown', cancelPending, true)
    host.addEventListener('keydown', cancelPending, true)
    let frame: number | undefined
    const scheduleRestore = () => {
      if (frame !== undefined) return
      frame = window.requestAnimationFrame(() => { frame = undefined; restore() })
    }
    const mutations = new MutationObserver(scheduleRestore)
    mutations.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-dsh-scroll-key'] })
    sizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleRestore)
    sizes?.observe(host)
    restore()
    return () => {
      host.removeEventListener('scroll', onScroll, true)
      host.removeEventListener('wheel', cancelPending, true)
      host.removeEventListener('pointerdown', cancelPending, true)
      host.removeEventListener('keydown', cancelPending, true)
      mutations.disconnect()
      sizes?.disconnect()
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [key, visible])
  return <div ref={ref} className={css.nativeTabHost} data-dsh-tab-scroll-memory="">{children}</div>
}
