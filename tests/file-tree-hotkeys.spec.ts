// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { attachFileTreeHotkeys, registerFileTreeHotkeys, FILE_TREE_DELETE } from '../src/client/file-tree-hotkeys.ts'

describe('file tree hotkey focus ownership', () => {
  it('keeps one command across two trees, rejects stale owners, and releases on unload', () => {
    type Action = Parameters<Parameters<typeof registerFileTreeHotkeys>[0]['registerAction']>[0]
    const actions = new Map<string, Action>()
    const release = registerFileTreeHotkeys({ version: 1, registerAction(action) {
      expect(actions.size).toBe(0)
      actions.set(action.id, action)
      return () => { actions.delete(action.id) }
    } })
    const a = document.createElement('div'), b = document.createElement('div')
    a.tabIndex = b.tabIndex = 0
    document.body.append(a, b)
    let countA = 0, countB = 0, visibleB = true
    const detachA = attachFileTreeHotkeys(a, { available: () => true, run: () => { countA++; return true } })
    const detachB = attachFileTreeHotkeys(b, { available: () => visibleB, run: () => { countB++; return true } })
    try {
      a.focus()
      const old = actions.get(FILE_TREE_DELETE)!
      expect(old.run()).toBe(true)
      b.focus()
      expect(old.run()).toBe(false)
      expect(actions.get(FILE_TREE_DELETE)!.run()).toBe(true)
      visibleB = false
      expect(actions.get(FILE_TREE_DELETE)!.run()).toBe(false)
      detachB()
      expect(actions.size).toBe(0)
      expect([countA, countB]).toEqual([1, 1])
      a.focus()
      expect(actions.size).toBe(1)
      release()
      expect(actions.size).toBe(0)
    } finally { release(); detachA(); detachB(); a.remove(); b.remove() }
  })
})
