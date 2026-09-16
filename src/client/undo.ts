/**
 * Per-session undo/redo stacks for file-tree mutations (rename/move/copy).
 *
 * The stacks live OUTSIDE React state, at module scope, keyed by
 * `session|cwd` — so the history survives the files tab closing, panel
 * switches, and component remounts during the session's life (a page reload
 * forgets it, like the tree's one-shot expanded/revealed state).
 *
 * Delete is deliberately NOT recorded: the host has no trash and the tree's
 * delete stays permanent by user decision, so there is nothing to undo.
 *
 * Stack discipline (standard editor semantics): an entry is the mutation
 * that WAS performed; undo pops it onto the redo stack and the caller runs
 * the INVERSE; redo pops it back and replays the FORWARD mutation. Pushing a
 * fresh mutation clears the whole redo stack. If an undo/redo attempt fails
 * on the wire, {@link returnTreeOp} puts the entry back where it came from
 * so the user can retry.
 */

/** One performed tree mutation, remembered for undo/redo. `isDir` tells the
 *  caller whether tab retargeting must cover the whole subtree (only ever
 *  true for rename/move — a copy retargets nothing). */
export type TreeMutationOp =
  | { kind: 'rename'; from: string; to: string; isDir: boolean }
  | { kind: 'move'; from: string; to: string; isDir: boolean }
  | { kind: 'copy'; from: string; to: string }

interface TreeUndoState {
  undo: TreeMutationOp[]
  redo: TreeMutationOp[]
}

/** Cap on remembered operations (the oldest entries drop off the undo end). */
export const UNDO_LIMIT = 100

const stacks = new Map<string, TreeUndoState>()

function stackOf(sessionId: string, cwd: string): TreeUndoState {
  const key = `${sessionId}|${cwd}`
  let stack = stacks.get(key)
  if (stack === undefined) {
    stack = { undo: [], redo: [] }
    stacks.set(key, stack)
  }
  return stack
}

/** Record a performed mutation: pushed onto undo, redo cleared (a new edit
 *  invalidates every redo). */
export function pushTreeOp(sessionId: string, cwd: string, op: TreeMutationOp): void {
  const stack = stackOf(sessionId, cwd)
  stack.undo.push(op)
  if (stack.undo.length > UNDO_LIMIT) stack.undo.shift()
  stack.redo = []
}

/** Whether the tree currently has anything to undo. */
export function canUndoTreeOp(sessionId: string, cwd: string): boolean {
  return stackOf(sessionId, cwd).undo.length > 0
}

/** Whether the tree currently has anything to redo. */
export function canRedoTreeOp(sessionId: string, cwd: string): boolean {
  return stackOf(sessionId, cwd).redo.length > 0
}

/** Pop the newest entry for undoing (moved onto the redo stack). */
export function undoTreeOp(sessionId: string, cwd: string): TreeMutationOp | undefined {
  const stack = stackOf(sessionId, cwd)
  const op = stack.undo.pop()
  if (op !== undefined) stack.redo.push(op)
  return op
}

/** Pop the newest entry for redoing (moved back onto the undo stack). */
export function redoTreeOp(sessionId: string, cwd: string): TreeMutationOp | undefined {
  const stack = stackOf(sessionId, cwd)
  const op = stack.redo.pop()
  if (op !== undefined) stack.undo.push(op)
  return op
}

/** Put an entry back after a failed attempt (undoTreeOp/redoTreeOp already
 *  moved it; the wire error must not count as a completed history step). */
export function returnTreeOp(sessionId: string, cwd: string, op: TreeMutationOp, to: 'undo' | 'redo'): void {
  const stack = stackOf(sessionId, cwd)
  if (to === 'undo') {
    const index = stack.redo.lastIndexOf(op)
    if (index !== -1) stack.redo.splice(index, 1)
    stack.undo.push(op)
  } else {
    const index = stack.undo.lastIndexOf(op)
    if (index !== -1) stack.undo.splice(index, 1)
    stack.redo.push(op)
  }
}

/** Test hook: forget every stack (module-level state must not leak between
 *  specs). */
export function resetTreeUndoStacks(): void {
  stacks.clear()
}