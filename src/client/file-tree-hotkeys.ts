import type { Context } from '../context-types.ts'

export const FILE_TREE_DELETE = 'betterSidebar.files.delete'
interface Owner { available(): boolean; run(): boolean }
interface Action {
  id: string; owner: string; zh: string; en: string; group: string
  defaultBinding: { mac: string; default: string }
  scope: 'focus'; element: HTMLElement
  available(): boolean; run(): boolean
}
interface Registry { version: 1; registerAction(action: Action): () => void }
const owners = new Map<HTMLElement, Owner>()
const listeners = new Set<() => void>()
function changed(): void { for (const listener of listeners) listener() }
/** Selection stays in the tree. No DOM selection inference or editor fallback. */
export function attachFileTreeHotkeys(element: HTMLElement, owner: Owner): () => void {
  owners.set(element, owner)
  changed()
  return () => { owners.delete(element); changed() }
}
function focused(): [HTMLElement, Owner] | undefined {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return
  return [...owners].find(([element]) => element.isConnected && element.contains(active))
}
/** One stable command ID, seated only on the actually focused tree instance. */
export function registerFileTreeHotkeys(registry: Registry): () => void {
  let element: HTMLElement | undefined
  let release: (() => void) | undefined
  const sync = () => {
    const next = focused()?.[0]
    if (next === element) return
    release?.(); release = undefined; element = next
    if (!next) return
    const available = () => focused()?.[0] === next && owners.get(next)?.available() === true
    release = registry.registerAction({
      id: FILE_TREE_DELETE, owner: 'dsh-better-sidebar', group: 'files',
      zh: '删除文件树选中项', en: 'Delete selected file tree entries',
      defaultBinding: { mac: 'meta+backspace', default: 'delete' },
      scope: 'focus', element: next, available,
      run: () => available() && owners.get(next)!.run(),
    })
  }
  listeners.add(sync)
  document.addEventListener('focusin', sync)
  try { sync() } catch (error) { listeners.delete(sync); document.removeEventListener('focusin', sync); throw error }
  return () => { listeners.delete(sync); document.removeEventListener('focusin', sync); release?.() }
}
export function installFileTreeHotkeys(ctx: Context): void {
  ctx.inject(['hotkey'], scope => {
    const registry = scope.get('hotkey') as Registry | undefined
    if (registry?.version !== 1 || typeof registry.registerAction !== 'function') return
    scope.effect(() => registerFileTreeHotkeys(registry), 'dsh-better-sidebar: file tree delete hotkey')
  })
}
