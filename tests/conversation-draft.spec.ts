/**
 * The composer insert path (appendToDraft): appends `text` (space-
 * separated) to the session's composer draft through the conversation
 * service, and — v0.21.0 — focuses the host composer afterwards (the
 * @-mention gesture: after the explorer's @-reference pill / an
 * "add to conversation" insert the user's next keystrokes continue in the
 * composer). The composer is reached through the harness's own external-
 * hook marker (`data-composer-card` on the card, its textarea child) —
 * read-only DOM, no host change. Guards: a missing / disabled composer is
 * never forced; a missing service or scope degrades to a logged no-op.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { appendToDraft } from '../src/client/conversation-draft.ts'
import type { Context } from '../src/context-types.ts'

/**
 * Mount the harness composer card in the test document (the card always
 * carries `data-composer-card`; a plain in-body element gets a non-null
 * offsetParent in jsdom). Returns the textarea.
 */
function mountComposer(): HTMLTextAreaElement {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', 'true')
  const textarea = document.createElement('textarea')
  card.appendChild(textarea)
  document.body.appendChild(card)
  return textarea
}

/** A conversation-service stub: setDraft records into a mutable draft
 *  the input's getSnapshot re-reads (real controlled-input semantics). */
function makeCtx(initial = ''): {
  ctx: Context
  setDraft: Mock<(text: string) => void>
  draftOf: () => string
} {
  let current = initial
  const setDraft = vi.fn((text: string) => { current = text })
  const input = { state: { getSnapshot: () => ({ draft: current }) }, setDraft }
  const ctx = {
    sessions: { scope: () => ({}) },
    get: (key: string) => (key === 'conversation' ? { input: { for: () => input } } : undefined),
  } as unknown as Context
  return { ctx, setDraft, draftOf: () => current }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('appendToDraft', () => {
  it('appends space-separated to the session draft (empty draft = bare text)', () => {
    const { ctx, setDraft, draftOf } = makeCtx()
    expect(appendToDraft(ctx, 's1', '@src/a.ts')).toBe(true)
    expect(draftOf()).toBe('@src/a.ts')
    expect(appendToDraft(ctx, 's1', '@src/b.ts')).toBe(true)
    expect(setDraft).toHaveBeenLastCalledWith('@src/a.ts @src/b.ts')
  })

  it('FOCUSES the host composer after a successful insert and puts the caret at the end (v0.21.0)', async () => {
    const textarea = mountComposer()
    const { ctx } = makeCtx()
    appendToDraft(ctx, 's1', '@src/a.ts')
    // The real flow: setDraft → React commits the new value into the same
    // textarea node (identity preserved) → the post-commit focus step runs.
    textarea.value = '@src/a.ts'
    await new Promise((resolve) => setTimeout(resolve, 30)) // let rAF fire
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(textarea.value.length)
    expect(textarea.selectionEnd).toBe(textarea.value.length)
  })

  it('a missing composer card does not break the insert (focus is a strict no-op)', async () => {
    const { ctx } = makeCtx()
    const before = document.activeElement
    expect(appendToDraft(ctx, 's1', '@x')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(document.activeElement).toBe(before)
  })

  it('a DISABLED composer is never forced: the insert still lands, the focus does not', async () => {
    const textarea = mountComposer()
    textarea.disabled = true
    const { ctx } = makeCtx()
    const before = document.activeElement
    expect(appendToDraft(ctx, 's1', '@x')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(document.activeElement).toBe(before)
    expect(before).not.toBe(textarea)
  })

  it('degrades to a no-op without the conversation service or the session scope (silent false)', () => {
    const noService = { sessions: { scope: () => ({}) }, get: () => undefined } as unknown as Context
    expect(appendToDraft(noService, 's1', '@x')).toBe(false)
    const noScope = { sessions: { scope: () => undefined }, get: () => ({}) } as unknown as Context
    expect(appendToDraft(noScope, 's1', '@x')).toBe(false)
  })

  it('a THROWING conversation service returns false and logs a console.warn (never crashes)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = {
        sessions: { scope: () => ({}) },
        get: () => ({ input: { for: () => ({ state: { getSnapshot: () => { throw new Error('boom') } } }) } }),
      } as unknown as Context
      expect(appendToDraft(ctx, 's1', '@x')).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})