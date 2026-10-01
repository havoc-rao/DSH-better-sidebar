import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { IconInfoOutlineRegular, IconRefreshOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, type WorkspaceTerminalInfo } from './api.ts'
import type { SidebarStore } from './state.ts'
import { terminalTabIcon } from './builtins/tab-icons.tsx'
import { openWorkspaceTerminal, refreshWorkspaceTerminalTabs, updateTerminalSession } from './workspace-terminals.ts'
import { t } from './locales.ts'
import css from './WorkspaceTerminals.module.css'

/** On-demand catalog. Requests and mutations stay bound to their source session. */
export function WorkspaceTerminals({ sessionId, store, visible = true, ctx }: { sessionId: string; store: SidebarStore; visible?: boolean; ctx?: Context }) {
  const error = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    useCallback(() => {
      const snapshot = store.getSnapshot()
      return (snapshot.sessionId === sessionId ? snapshot.state : store.getSessionStates().get(sessionId))?.workspaceTerminalError
    }, [store, sessionId]),
  )
  const sessions = ctx?.sessions?.list
  const summaries = useSyncExternalStore(
    useCallback((listener: () => void) => sessions?.subscribe(listener) ?? (() => {}), [sessions]),
    useCallback(() => sessions?.getSnapshot(), [sessions]),
  )
  const [catalog, setCatalog] = useState<{ sessionId: string; store: SidebarStore; items: WorkspaceTerminalInfo[] } | null>(null)
  const items = visible && catalog?.sessionId === sessionId && catalog.store === store ? catalog.items : []
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const confirmationId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const terminateTrigger = useRef<HTMLButtonElement | null>(null)
  const dismissConfirmation = () => {
    setConfirmId(null)
    terminateTrigger.current?.focus()
  }
  useEffect(() => {
    if (confirmId !== null) cancelRef.current?.focus()
  }, [confirmId])
  const generation = useRef(0)
  const scope = useRef(0)
  const pendingRef = useRef<string | null>(null)
  const loadingRef = useRef(false)
  const requestError = useCallback((error: unknown, sourceSession: string): void => {
    updateTerminalSession(store, sourceSession, state => ({ ...state,
      workspaceTerminalError: error instanceof Error ? error.message : String(error) }))
  }, [store])
  useEffect(() => {
    const current = ++scope.current
    setCatalog(null)
    pendingRef.current = null
    setPending(null)
    setConfirmId(null)
    return () => { scope.current = current + 1 }
  }, [sessionId, store, visible])
  useEffect(() => {
    const current = ++generation.current
    if (!visible) { loadingRef.current = false; setLoading(false); return }
    const controller = new AbortController()
    loadingRef.current = true
    setLoading(true)
    void api.workspaceTerminalList(sessionId, controller.signal).then(({ terminals }) => {
      if (controller.signal.aborted || current !== generation.current) return
      updateTerminalSession(store, sessionId, state => ({ ...refreshWorkspaceTerminalTabs(state, terminals), workspaceTerminalError: undefined }))
      setCatalog({ sessionId, store, items: terminals })
    }).catch(error => {
      if (!controller.signal.aborted && current === generation.current) requestError(error, sessionId)
    }).finally(() => {
      if (!controller.signal.aborted && current === generation.current) { loadingRef.current = false; setLoading(false) }
    })
    return () => { controller.abort(); generation.current = current + 1 }
  }, [sessionId, store, visible, revision, requestError])
  const terminate = (info: WorkspaceTerminalInfo) => {
    if (pendingRef.current !== null || loadingRef.current) return
    const current = scope.current
    const sourceSession = sessionId
    pendingRef.current = info.terminalId
    setPending(info.terminalId)
    setConfirmId(null)
    void api.workspaceTerminalTerminate(sourceSession, info.terminalId).then(() => {
      if (current === scope.current) setRevision(value => value + 1)
    }).catch(error => requestError(error, sourceSession)).finally(() => {
      if (current === scope.current) { pendingRef.current = null; setPending(null) }
    })
  }
  const running = items.filter(info => !info.exited).length
  const exited = items.length - running
  const busy = loading || pending !== null
  return <section className={css.catalog} aria-label={t('workspaceTerminals')} aria-busy={busy}
    onKeyDown={event => { if (event.key === 'Escape' && confirmId !== null) { event.preventDefault(); dismissConfirmation() } }}>
    <header className={css.toolbar}>
      <div className={css.heading}>
        <span className={css.headingGlyph} aria-hidden="true">{terminalTabIcon(14)}</span>
        <strong>{t('workspaceTerminals')}</strong>
        <Tooltip label={t('workspaceTerminalDetachHint')} side="bottom">
          <button className={css.hintIcon} type="button" aria-label={t('workspaceTerminalDetachHint')}>
            <IconInfoOutlineRegular size={14} />
          </button>
        </Tooltip>
        <span className={css.count}>{catalog?.sessionId === sessionId && catalog.store === store ? items.length : '—'}</span>
      </div>
      <div className={css.summary}>
        {running > 0 && <span><i className={css.statDot} aria-hidden="true" />{running} {t('workspaceTerminalRunning')}</span>}
        {exited > 0 && <span className={css.exitedStat}><i className={css.statDot} aria-hidden="true" />{exited} {t('workspaceTerminalExited')}</span>}
      </div>
      <button className={css.refresh} type="button" aria-label={t('refresh')} title={t('refresh')} data-loading={loading} disabled={busy}
        onClick={() => { if (!loadingRef.current && pendingRef.current === null) { setConfirmId(null); setRevision(value => value + 1) } }}>
        <IconRefreshOutlineRegular size={16} />
      </button>
    </header>
    {visible && error !== undefined && <div role="alert" className={css.error}>{error}</div>}
    <div className={css.list} role="list">
      {loading && items.length === 0 ? <div className={css.skeleton} role="status" aria-label={t('loading')}>
        {[0, 1, 2].map(key => <div className={css.skeletonRow} key={key}><span /><span /></div>)}
      </div> : items.length === 0 && error === undefined ? <div className={css.empty}><span className={css.emptyIcon} aria-hidden="true">{terminalTabIcon(18)}</span><strong>{t('workspaceTerminalEmpty')}</strong></div> : items.map(info => {
        const source = summaries?.byId[info.createdBySessionId]?.displayTitle?.trim() || info.createdBySessionId.slice(0, 8)
        const status = `${info.exited ? t('workspaceTerminalExited') : t('workspaceTerminalRunning')}${info.exited && info.exitCode !== undefined ? ` (${info.exitCode})` : ''}`
        return <div className={css.row} role="listitem" key={info.terminalId} data-terminal-id={info.terminalId} data-exited={info.exited} data-confirming={confirmId === info.terminalId} aria-busy={pending === info.terminalId}>
          <span className={css.glyph} aria-hidden="true">{terminalTabIcon(16)}<i className={css.dot} /></span>
          <div className={css.details}>
            <div className={css.titleLine}><strong className={css.title} title={info.title}>{info.title}</strong><span className={css.status} title={status}>{status}</span></div>
            <div className={css.metadata}><span className={css.cwd} title={info.cwd}>{info.cwd}</span><span className={css.sep} aria-hidden="true">·</span><span className={css.source} title={`${source} · ${info.createdBySessionId}`}>{source}</span></div>
          </div>
          <div className={css.actions}>
            <button className={css.terminate} type="button" disabled={busy} aria-expanded={confirmId === info.terminalId}
              aria-controls={confirmId === info.terminalId ? confirmationId : undefined}
              aria-label={`${t('workspaceTerminalTerminate')} · ${info.title}`}
              onClick={event => {
                if (confirmId === info.terminalId) { dismissConfirmation(); return }
                terminateTrigger.current = event.currentTarget
                setConfirmId(info.terminalId)
              }}>{pending === info.terminalId ? t('loading') : t('workspaceTerminalTerminate')}</button>
            <button className={css.open} type="button" disabled={pending !== null} aria-label={`${t('workspaceTerminalOpen')} · ${info.title}`} onClick={() => { setConfirmId(null); openWorkspaceTerminal(store, sessionId, info) }}>{t('workspaceTerminalOpen')}</button>
          </div>
          {confirmId === info.terminalId && <div id={confirmationId} className={css.confirmation} role="group" aria-label={t('workspaceTerminalTerminate')}>
            <div className={css.confirmText}><strong>{t('workspaceTerminalTerminate')} · {info.title}</strong><span>{t('workspaceTerminalTerminateConfirm')}</span></div>
            <div className={css.confirmActions}>
              <button className={css.confirmButton} type="button" disabled={busy} onClick={() => terminate(info)}>{t('workspaceTerminalTerminate')}</button>
              <button ref={cancelRef} type="button" disabled={pending !== null} onClick={dismissConfirmation}>{t('cancel')}</button>
            </div>
          </div>}
        </div>
      })}
    </div>
  </section>
}