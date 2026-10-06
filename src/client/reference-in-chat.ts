/**
 * The explorer's `@`-reference button: insert one file or folder reference
 * into the conversation draft of a session.
 *
 * Directories append the folder mention (`@dir/`) as plain text so DSH's
 * folder decoration and completion keep working; files insert a structured
 * chip like the native `@` picker, so the whole reference stays one link
 * instead of decorating only the leading folder. The session-scope context and
 * the conversation input service are resolved at click time; a missing service
 * or scope degrades to a logged no-op, never a crash.
 *
 * Shared by the plugin's own panel and the native right-Sidebar tab body, so
 * both surfaces behave identically.
 */
import type { Context, SidebarConversation } from '../context-types.ts'
import { appendToDraft, insertFileReference } from './conversation-draft.ts'
import { relativeTo } from './paths.ts'

/**
 * Reference one path in the session's conversation draft.
 * @param ctx - the client context.
 * @param sessionId - the session whose draft receives the reference.
 * @param cwd - that session's workspace root (for the relative spelling).
 * @param path - the absolute or workspace-relative path to reference.
 * @param isDir - whether the path is a directory (folder mention vs file chip).
 */
export function referenceInChat(
  ctx: Context,
  sessionId: string,
  cwd: string | undefined,
  path: string,
  isDir: boolean,
): void {
  const rel = relativeTo(cwd ?? '', path)
  const inserted = isDir
    ? appendToDraft(ctx, sessionId, `@${rel === '.' ? './' : `${rel}/`}`)
    : insertFileReference(ctx, sessionId, rel) || appendToDraft(ctx, sessionId, `@${rel}`)
  if (!inserted) return

  // Let the host editor restore its retained selection (DOM focus alone can
  // reset Lexical's caret). Keep this click-only: other draft writers must not
  // unexpectedly take keyboard focus from their own surfaces.
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    conversation?.input.for(actx).focus?.()
  } catch (error) {
    console.warn('[dsh-better-sidebar] composer focus failed:', error)
  }
}
