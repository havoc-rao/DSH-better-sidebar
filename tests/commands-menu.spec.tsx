/**
 * Menu-contribution integration (v0.16.0+): plugin commands appear in the
 * FileTree row context menu (file / dir / root rows), and picking one runs
 * it through executeCommand with the row payload. Without registered
 * commands the menu keeps its exact built-in rows (regression).
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { FileTree } from '../src/client/FileTree.tsx'
import { api, type FsEntry } from '../src/client/api.ts'
import type { CommandRunPayload } from '../src/client/commands.ts'
import type { Context } from '../src/context-types.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const file = (name: string, path: string): FsEntry =>
  ({ name, path, isDir: false, hidden: false, isSymlink: false, broken: false })
const dir = (name: string, path: string): FsEntry =>
  ({ name, path, isDir: true, hidden: false, isSymlink: false, broken: false })

function Harness(props: { ctx?: Context }): ReactNode {
  const { ctx } = props
  const [expanded, setExpanded] = useState<string[]>([])
  return createElement(FileTree, {
    sessionId: 's',
    cwd: '/repo',
    ctx,
    expanded,
    onToggle: (path: string) => {
      setExpanded(current => current.includes(path) ? current.filter(p => p !== path) : [...current, path])
    },
    onOpenFile: () => {},
    onReferenceFile: () => {},
    refreshTick: 0,
  })
}

/** Find a tree row by its explorer-name text ('a.ts', 'src', 'repo'…).
 *  The ROOT row carries no `role="button"` (only file/dir rows do), so the
 *  match scans any div whose DIRECT child is the explorer-name span — the
 *  per-entry wrapper div nests the row, so `:scope >` keeps it out. */
function rowOf(container: HTMLDivElement, name: string): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>('div')]
    .find(row => row.querySelector(':scope > [class*="explorerName"]')?.textContent === name) ?? null
}

/** Wait for the row, open its context menu, return the rendered menu items. */
async function openRowMenu(container: HTMLDivElement, name: string): Promise<HTMLElement[]> {
  await vi.waitFor(() => expect(rowOf(container, name)).not.toBeNull())
  const row = rowOf(container, name)!
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }))
  })
  await vi.waitFor(() => expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0))
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function mountTree(ctx?: Context): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(Harness, { ctx })) })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** The copied-label cleanup (the copy action briefly swaps the row label). */
async function pick(items: HTMLElement[], label: string): Promise<HTMLElement | undefined> {
  const item = items.find(candidate => (candidate.textContent ?? '').includes(label))
  if (item !== undefined) act(() => { item.click() })
  return item
}

describe('FileTree command menu contributions', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('appends plugin commands to the file-row menu and runs them with the row payload', async () => {
    vi.spyOn(api, 'fsTree').mockImplementation(async (_scope, path) => {
      if (path === '/repo') {
        return { path, entries: [file('a.ts', '/repo/a.ts'), dir('src', '/repo/src')], truncated: false }
      }
      return { path, entries: [], truncated: false }
    })
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const payloads: CommandRunPayload[] = []
    service.registerCommand({
      id: 'my:format',
      title: () => 'Format file',
      icon: (size: number) => createElement('i', { 'data-size': size, 'data-icon': 'fmt' }),
      menus: [{ where: 'file-row', order: 10 }],
      run: (payload) => { payloads.push(payload) },
    })
    const ctx = { betterSidebar: service } as unknown as Context

    const { container, unmount } = mountTree(ctx)
    try {
      const items = await openRowMenu(container, 'a.ts')
      const labels = items.map(item => item.textContent ?? '')
      // The plugin row is appended after the built-ins (not in the menu
      // otherwise); it carries its icon at the 14px row size.
      expect(labels).toContain('Format file')
      const row = items.find(item => (item.textContent ?? '').includes('Format file'))!
      expect(row.querySelector('[data-size="14"]')).not.toBeNull()
      expect(labels.indexOf('Format file')).toBeGreaterThan(labels.indexOf('Download'))

      await pick(items, 'Format file')
      expect(payloads).toHaveLength(1)
      expect(payloads[0]).toEqual({ where: 'file-row', path: '/repo/a.ts', isDir: false, isRoot: false })
    } finally {
      unmount()
      document.querySelectorAll('[role="menuitem"]').forEach(node => node.remove())
    }
  })

  it('targets dir rows and the root row separately (dir-row vs root-row)', async () => {
    vi.spyOn(api, 'fsTree').mockImplementation(async (_scope, path) => {
      if (path === '/repo') {
        return { path, entries: [file('a.ts', '/repo/a.ts'), dir('src', '/repo/src')], truncated: false }
      }
      return { path, entries: [], truncated: false }
    })
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const payloads: CommandRunPayload[] = []
    service.registerCommand({
      id: 'my:tree',
      title: () => 'Treeify',
      menus: [{ where: 'dir-row' }, { where: 'root-row' }],
      run: (payload) => { payloads.push(payload) },
    })
    const ctx = { betterSidebar: service } as unknown as Context

    const { container, unmount } = mountTree(ctx)
    try {
      // A plain dir row gets where='dir-row'.
      const dirItems = await openRowMenu(container, 'src')
      expect(await pick(dirItems, 'Treeify')).toBeDefined()
      expect(payloads.slice(-1)[0]).toEqual({ where: 'dir-row', path: '/repo/src', isDir: true, isRoot: false })

      // The ROOT row (the cwd itself) gets where='root-row'.
      const rootItems = await openRowMenu(container, 'repo')
      expect(await pick(rootItems, 'Treeify')).toBeDefined()
      expect(payloads.slice(-1)[0]).toEqual({ where: 'root-row', path: '/repo', isDir: true, isRoot: true })
    } finally {
      unmount()
      document.querySelectorAll('[role="menuitem"]').forEach(node => node.remove())
    }
  })

  it('with no commands registered the row menu keeps its exact built-in rows (regression)', async () => {
    vi.spyOn(api, 'fsTree').mockImplementation(async (_scope, path) => {
      if (path === '/repo') return { path, entries: [file('a.ts', '/repo/a.ts')], truncated: false }
      return { path, entries: [], truncated: false }
    })
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const ctx = { betterSidebar: service } as unknown as Context
    const { container, unmount } = mountTree(ctx)
    try {
      const items = await openRowMenu(container, 'a.ts')
      expect(items.map(item => item.textContent ?? '').sort()).toEqual([
        'Copy absolute path',
        'Copy relative path',
        'Download',
      ])
    } finally {
      unmount()
      document.querySelectorAll('[role="menuitem"]').forEach(node => node.remove())
    }
  })
})