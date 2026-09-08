/**
 * Append text to the current session's composer draft through the
 * conversation service — the shared path behind the explorer's @-reference
 * button, the terminal/selection "add to conversation" pills and the
 * viewer selection popup. The service is resolved lazily through `ctx.get`
 * (the inject-free read the app's own plugins use); a missing service or
 * scope degrades to a logged no-op, never a crash.
 *
 * v0.21.0: a successful insert also FOCUSES the host composer (the
 * @-mention gesture — the user's next keystrokes continue in the
 * composer). The focus is a read-only DOM touch on the harness's own
 * external-hook marker (`data-composer-card` on the composer card, see
 * `focusComposerAfterInsert`) — no host change required.
 */
import type { Context, SidebarConversation } from '../context-types.ts'

/**
 * Focus the host composer after an external draft insert (v0.21.0): the
 * insert flows put text into the composer, and the user's next keystrokes
 * should continue right there (the GitHub @-mention gesture). The
 * harness's composer card always carries `data-composer-card` (and its
 * textarea `data-phase`) — a stable, read-only external hook, so this
 * needs no host change. Runs post-commit (requestAnimationFrame; falls
 * back to a macrotask where rAF is missing): the controlled textarea then
 * already holds the new draft, and the caret lands at the end (the append
 * position). Strict no-op guards — a missing or disabled composer is
 * never forced; a display-hidden composer is a browser-level no-op
 * (focus() on a hidden element does nothing). A covered composer still
 * takes focus: the keystrokes land in the draft, exactly what the user
 * asked for.
 */
function focusComposerAfterInsert(): void {
  const schedule = (cb: () => void): void => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => cb())
    } else {
      window.setTimeout(cb, 0)
    }
  }
  schedule(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-composer-card] textarea')
    if (textarea === null || textarea.disabled) return
    textarea.focus()
    try {
      const end = textarea.value.length
      textarea.setSelectionRange(end, end)
    } catch {
      // Not a real textarea (selection API unavailable) — focus only.
    }
  })
}

/**
 * Append `text` to the session's composer draft (space-separated, like the
 * @-mentions). On success, also focuses the host composer (v0.21.0, see
 * `focusComposerAfterInsert`). Returns false when the conversation service
 * or the session scope is unavailable (silent no-op); a throwing service
 * call also returns false and logs a console.warn.
 */
export function appendToDraft(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft.trim() === '' ? text : `${draft} ${text}`)
    focusComposerAfterInsert()
    return true
  } catch (error) {
    console.warn('[dsh-better-sidebar] draft insert failed:', error)
    return false
  }
}
