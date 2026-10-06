import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { referenceInChat } from '../src/client/reference-in-chat.ts'

function fixture({ structured = true, focusAvailable = true, scopeAvailable = true } = {}) {
  let draft = ''
  let draftRev = 0
  const events: string[] = []
  const focus = vi.fn(() => { events.push('focus') })
  const input = {
    state: { getSnapshot: () => ({ draft, draftRev }) },
    setDraft: (text: string) => { draft = text; draftRev += 1; events.push('text') },
    ...(focusAvailable ? { focus } : {}),
  }
  const scope = {
    emit: (_name: string, payload: { reference: { ref: string } }) => {
      if (!structured) return
      draft = payload.reference.ref
      draftRev += 1
      events.push('reference')
    },
  }
  const ctx = {
    sessions: { scope: () => scopeAvailable ? scope : undefined },
    get: () => ({ input: { for: () => input } }),
  } as unknown as Context
  return { ctx, focus, events, draft: () => draft }
}

describe('referenceInChat focus', () => {
  it('focuses the host composer after inserting a structured file chip', () => {
    const f = fixture()
    referenceInChat(f.ctx, 's1', '/workspace', '/workspace/src/main.ts', false)
    expect(f.draft()).toBe('@src/main.ts')
    expect(f.events).toEqual(['reference', 'focus'])
  })

  it('focuses after inserting a folder mention', () => {
    const f = fixture()
    referenceInChat(f.ctx, 's1', '/workspace', '/workspace/src', true)
    expect(f.draft()).toBe('@src/')
    expect(f.events).toEqual(['text', 'focus'])
  })

  it('focuses after the plain-text file fallback succeeds', () => {
    const f = fixture({ structured: false })
    referenceInChat(f.ctx, 's1', '/workspace', '/workspace/main.ts', false)
    expect(f.events).toEqual(['text', 'focus'])
  })

  it('does not steal focus when insertion fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const f = fixture({ scopeAvailable: false })
      referenceInChat(f.ctx, 's1', '/workspace', '/workspace/main.ts', false)
      expect(f.focus).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  it('keeps insertion working when the host has no focus method', () => {
    const f = fixture({ focusAvailable: false })
    expect(() => referenceInChat(f.ctx, 's1', '/workspace', '/workspace/main.ts', false)).not.toThrow()
    expect(f.events).toEqual(['reference'])
  })
})
