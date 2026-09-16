/**
 * The per-session tree-mutation undo/redo stack (src/client/undo.ts):
 * push/undo/redo discipline, the undo cap, redo invalidation on a new
 * mutation, failure compensation, and cross-instance keying by session+cwd.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  canRedoTreeOp, canUndoTreeOp, pushTreeOp, redoTreeOp, resetTreeUndoStacks,
  returnTreeOp, undoTreeOp, UNDO_LIMIT,
} from '../src/client/undo.ts'

const rename = (from: string, to: string) => ({ kind: 'rename' as const, from, to, isDir: false })

afterEach(() => {
  resetTreeUndoStacks()
})

describe('tree undo stack', () => {
  it('pops the newest entry for undoing and moves it onto the redo stack', () => {
    pushTreeOp('s1', '/ws', rename('/ws/a.ts', '/ws/b.ts'))
    const op = undoTreeOp('s1', '/ws')
    expect(op).toEqual(rename('/ws/a.ts', '/ws/b.ts'))
    expect(canUndoTreeOp('s1', '/ws')).toBe(false)
    expect(canRedoTreeOp('s1', '/ws')).toBe(true)
  })

  it('redoes by moving the entry back onto the undo stack', () => {
    pushTreeOp('s1', '/ws', rename('/ws/a.ts', '/ws/b.ts'))
    undoTreeOp('s1', '/ws')
    const op = redoTreeOp('s1', '/ws')
    expect(op).toEqual(rename('/ws/a.ts', '/ws/b.ts'))
    expect(canUndoTreeOp('s1', '/ws')).toBe(true)
    expect(canRedoTreeOp('s1', '/ws')).toBe(false)
  })

  it('undoes in LIFO order and redo replays in FIFO order', () => {
    pushTreeOp('s1', '/ws', rename('/ws/a', '/ws/a2'))
    pushTreeOp('s1', '/ws', rename('/ws/b', '/ws/b2'))
    expect(undoTreeOp('s1', '/ws')).toEqual(rename('/ws/b', '/ws/b2'))
    expect(undoTreeOp('s1', '/ws')).toEqual(rename('/ws/a', '/ws/a2'))
    expect(undoTreeOp('s1', '/ws')).toBeUndefined()
    expect(redoTreeOp('s1', '/ws')).toEqual(rename('/ws/a', '/ws/a2'))
    expect(redoTreeOp('s1', '/ws')).toEqual(rename('/ws/b', '/ws/b2'))
  })

  it('returns undefined on empty stacks', () => {
    expect(undoTreeOp('s1', '/ws')).toBeUndefined()
    expect(redoTreeOp('s1', '/ws')).toBeUndefined()
  })

  it('a new mutation clears the whole redo stack', () => {
    pushTreeOp('s1', '/ws', rename('/ws/a', '/ws/a2'))
    undoTreeOp('s1', '/ws')
    expect(canRedoTreeOp('s1', '/ws')).toBe(true)
    pushTreeOp('s1', '/ws', rename('/ws/c', '/ws/c2'))
    expect(canRedoTreeOp('s1', '/ws')).toBe(false)
    expect(canUndoTreeOp('s1', '/ws')).toBe(true)
  })

  it('a failed attempt returns the entry to its source stack (retryable)', () => {
    pushTreeOp('s1', '/ws', rename('/ws/a', '/ws/a2'))
    const op = undoTreeOp('s1', '/ws')
    // The wire failed: compensate — still undoable, nothing redoable.
    returnTreeOp('s1', '/ws', op!, 'undo')
    expect(canUndoTreeOp('s1', '/ws')).toBe(true)
    expect(canRedoTreeOp('s1', '/ws')).toBe(false)
    // And symmetrically for a failed redo.
    const again = undoTreeOp('s1', '/ws')
    const redoAttempt = redoTreeOp('s1', '/ws')
    returnTreeOp('s1', '/ws', redoAttempt!, 'redo')
    expect(again).toEqual(redoAttempt)
    expect(canRedoTreeOp('s1', '/ws')).toBe(true)
    expect(canUndoTreeOp('s1', '/ws')).toBe(false)
  })

  it('caps the undo depth at UNDO_LIMIT, dropping the oldest', () => {
    for (let i = 0; i < UNDO_LIMIT + 5; i += 1) {
      pushTreeOp('s1', '/ws', rename(`/ws/f${i}`, `/ws/f${i}.new`))
    }
    const oldest = undoTreeOp('s1', '/ws')!
    expect(oldest.from).toBe(`/ws/f${UNDO_LIMIT + 4}`)
    // Exactly UNDO_LIMIT entries remain after this pop.
    let rest = 0
    while (undoTreeOp('s1', '/ws') !== undefined) rest += 1
    expect(rest).toBe(UNDO_LIMIT - 1)
  })

  it('keys stacks by session AND cwd (same session, different workspaces)', () => {
    pushTreeOp('s1', '/ws', rename('/ws/a', '/ws/a2'))
    pushTreeOp('s2', '/ws', rename('/ws/b', '/ws/b2'))
    pushTreeOp('s1', '/other', rename('/other/c', '/other/c2'))
    expect(undoTreeOp('s1', '/ws')).toEqual(rename('/ws/a', '/ws/a2'))
    expect(undoTreeOp('s2', '/ws')).toEqual(rename('/ws/b', '/ws/b2'))
    expect(undoTreeOp('s1', '/other')).toEqual(rename('/other/c', '/other/c2'))
    expect(undoTreeOp('s1', '/ws')).toBeUndefined()
  })
})