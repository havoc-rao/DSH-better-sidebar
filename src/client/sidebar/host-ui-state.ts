/** Structural mirrors of the host's public, commit-driven UI snapshots. */
import type { Context } from '../../context-types.ts'

export interface UiSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface ConversationHeaderState {
  readonly sessionId: string | undefined
  readonly phase: string | undefined
  readonly chromeVisible: boolean
  readonly cornerAvailable: boolean
}

/** Older supported hosts do not expose this optional presentation feed. */
export function conversationHeaderSource(ctx: Context | undefined): UiSnapshot<ConversationHeaderState | undefined> | undefined {
  const conversation = ctx?.get('uiConversation') as {
    header?: UiSnapshot<ConversationHeaderState | undefined>
  } | undefined
  return conversation?.header
}
