/** Explicit, conversation-owned execution; rendering never starts a process. */
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import type { SidebarStore } from './state.ts'
import { api } from './api.ts'
import { t } from './locales.ts'
import { IconButton } from './ui/kit.tsx'
import { openWorkspaceTerminal, updateTerminalSession } from './workspace-terminals.ts'

const SHELL_LANGUAGES = new Set(['sh', 'shell', 'bash', 'zsh', 'shellscript'])

/** Console transcripts include prompts/output, not executable source. */
export function isRunnableShellBlock(lang: string | undefined, source: string, streaming: boolean): boolean {
  return !streaming && SHELL_LANGUAGES.has(lang?.trim().toLowerCase() ?? '')
    && source.trim().length > 0 && new TextEncoder().encode(source).length <= 32_768 && !source.includes('\0')
    && !/^(?:\s*[$>] |\s*% )/m.test(source)
}

export interface CodeBlockRunOwnerProps {
  source: string
  lang: string | undefined
  streaming: boolean
  sessionId: string
}

/** Captures the block's session, never the currently selected sidebar session. */
export function CodeBlockRunAction({ source, lang, streaming, sessionId, store, ctx }: CodeBlockRunOwnerProps & {
  store: SidebarStore
  ctx: Context
}) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => store.getSnapshot(), [store])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string>()
  const pending = useRef(false)
  // Retain the click identity across ambiguous network failures; retry asks
  // for the same process rather than repeating a potentially destructive command.
  const operation = useRef<{ sessionId: string; source: string; id: string }>()
  if (!isRunnableShellBlock(lang, source, streaming) || !sessionId || store.getSuspended()
    || snapshot.prefs.tabsEnabled.terminal === false) return null
  return <>
    <IconButton size="sm" icon={<IconPlayOutlineRegular size={14} />}
      label={starting ? t('codeBlockStarting') : t('codeBlockRun')}
      disabled={starting}
      onClick={() => {
        if (pending.current) return
        pending.current = true
        setStarting(true)
        setError(undefined)
        if (operation.current?.sessionId !== sessionId || operation.current.source !== source) {
          operation.current = { sessionId, source, id: `${Date.now()}:${crypto.randomUUID()}` }
        }
        void Promise.resolve().then(() => {
          // Registry presence is not ownership: unrelated providers must not
          // disable local workspaces. Resolve against the block's own session,
          // never the currently selected sidebar session. A throwing matcher
          // fails closed rather than risking execution on the wrong backend.
          const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
          const provider = ctx.betterSidebar.getTerminalProviders()
            .find(provider => provider.match(sessionId, cwd, 'terminal:workspace-management'))
          if (provider !== undefined) throw new Error(t('codeBlockProviderUnsupported', { name: provider.id }))
          return api.workspaceTerminalRun(sessionId, source, undefined, operation.current!.id)
        }).then(info => {
          operation.current = undefined
          openWorkspaceTerminal(store, sessionId, info)
          updateTerminalSession(store, sessionId, state => ({ ...state, workspaceTerminalError: undefined }))
        }).catch((reason: unknown) => {
          const message = reason instanceof Error ? reason.message : String(reason)
          // Do not log source: commands may contain credentials or other secrets.
          console.error('[dsh-better-sidebar] code-block Run failed:', { sessionId, message })
          setError(message)
          updateTerminalSession(store, sessionId, state => ({ ...state, workspaceTerminalError: message }))
        }).finally(() => { pending.current = false; setStarting(false) })
      }} />
    {error !== undefined && <span role="alert" title={error}>{error}</span>}
  </>
}
