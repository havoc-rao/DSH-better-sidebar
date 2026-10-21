import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { IconInfoOutlineRegular, IconRefreshOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import type { WorkspaceTerminalInfo } from './api.ts'
import type { SidebarStore } from './state.ts'
import { terminalTabIcon } from './builtins/tab-icons.tsx'
import { openWorkspaceTerminal, refreshWorkspaceTerminalTabs, resolveWorkspaceTerminalBinding, terminalServiceOf, updateTerminalSession } from './workspace-terminals.ts'
import { t } from './locales.ts'
import { isTerminalAccessDenied } from './terminal-errors.ts'
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
  const service = terminalServiceOf(ctx)
  const [registry, bumpRegistry] = useReducer((n: number) => n + 1, 0)
  useEffect(() => service?.subscribe(bumpRegistry), [service])
  const cwd = summaries?.byId[sessionId]?.cwd
  const knownOwners = useRef(new Map<string, string>())
  const backend = useMemo(() => {
    try {
      const binding = resolveWorkspaceTerminalBinding(service, sessionId, cwd, knownOwners.current.get(sessionId))
      if (binding.providerId !== undefined) knownOwners.current.set(sessionId, binding.providerId)
      return { binding }
    } catch (error) { return { error } }
  }, [service, sessionId, cwd, registry])
  const [catalog, setCatalog] = useState<{ sessionId: string; store: SidebarStore; backend: typeof backend; items: WorkspaceTerminalInfo[] } | null>(null)
  const items = visible && catalog?.sessionId === sessionId && catalog.store === store && catalog.backend === backend ? catalog.items : []
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [subscriptionRevision, setSubscriptionRevision] = useState(0)
  const [pageHidden, setPageHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  const active = visible && !pageHidden
  const [cleanupResult, setCleanupResult] = useState<number | null>(null)
  useEffect(() => {
    const update = () => setPageHidden(document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
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
  const refreshRequested = useRef(false)
  const eventVersion = useRef(0)
  const accessDenied = useRef(false)
  const subscriptionFailed = useRef(false)
  const subscribed = backend.binding?.source.subscribe !== undefined
  const requestError = useCallback((error: unknown, sourceSession: string): void => {
    updateTerminalSession(store, sourceSession, state => ({ ...state,
      workspaceTerminalError: error instanceof Error ? error.message : String(error) }))
  }, [store])
  useEffect(() => {
    const current = ++scope.current
    setCatalog(null)
    pendingRef.current = null
    refreshRequested.current = false
    accessDenied.current = false
    subscriptionFailed.current = false
    setPending(null)
    setConfirmId(null)
    setCleanupResult(null)
    return () => { scope.current = current + 1 }
  }, [sessionId, store, visible, backend])
  useEffect(() => {
    if (!active || !backend.binding?.source.subscribe) return
    let disposed = false
    subscriptionFailed.current = false
    loadingRef.current = true
    setLoading(true)
    const settle = () => { loadingRef.current = false; setLoading(false) }
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = backend.binding.source.subscribe(({ terminals }) => {
        if (disposed) return
        subscriptionFailed.current = false
        eventVersion.current += 1
        updateTerminalSession(store, sessionId, state => ({ ...refreshWorkspaceTerminalTabs(state, terminals, backend.binding?.providerId), workspaceTerminalError: undefined }))
        setCatalog({ sessionId, store, backend, items: terminals })
        settle()
      }, error => {
        if (disposed) return
        subscriptionFailed.current = true
        requestError(error, sessionId)
        settle()
      })
    } catch (error) { subscriptionFailed.current = true; requestError(error, sessionId); settle() }
    return () => { disposed = true; unsubscribe?.(); loadingRef.current = false }
  }, [sessionId, store, active, backend, requestError, subscriptionRevision])
  useEffect(() => {
    const current = ++generation.current
    if (!active) { loadingRef.current = false; setLoading(false); return }
    // Subscribed sources own initial resync. Only explicit refresh/management
    // asks for a one-shot list; that must never replace a newer pushed event.
    const requested = refreshRequested.current
    refreshRequested.current = false
    if (subscribed && !requested) return
    const version = eventVersion.current
    const controller = new AbortController()
    loadingRef.current = true
    setLoading(true)
    let request: Promise<{ terminals: WorkspaceTerminalInfo[] }>
    try {
      if (backend.binding === undefined) throw backend.error
      request = backend.binding.source.list(controller.signal)
    } catch (error) { request = Promise.reject(error) }
    void request.then(({ terminals }) => {
      if (controller.signal.aborted || current !== generation.current || version !== eventVersion.current) return
      updateTerminalSession(store, sessionId, state => ({ ...refreshWorkspaceTerminalTabs(state, terminals, backend.binding?.providerId), workspaceTerminalError: undefined }))
      setCatalog({ sessionId, store, backend, items: terminals })
    }).catch(error => {
      if (!controller.signal.aborted && current === generation.current && version === eventVersion.current) {
        if (isTerminalAccessDenied(error)) accessDenied.current = true
        requestError(error, sessionId)
      }
    }).finally(() => {
      if (!controller.signal.aborted && current === generation.current) { loadingRef.current = false; setLoading(false) }
    })
    return () => { controller.abort(); generation.current = current + 1 }
  }, [sessionId, store, active, revision, requestError, backend, subscribed])
  useEffect(() => {
    if (!active || subscribed) return
    const timer = setInterval(() => {
      // A slow request must finish: interval ticks never abort or replace it.
      if (!accessDenied.current && !loadingRef.current && pendingRef.current === null) setRevision(value => value + 1)
    }, 10_000)
    return () => clearInterval(timer)
  }, [active, subscribed])
  const refresh = () => {
    accessDenied.current = false
    // A terminal policy refusal stops the source itself. Explicit user retry
    // must restart that subscription, not merely list once and leave it dead.
    if (subscribed && subscriptionFailed.current) {
      refreshRequested.current = false
      setSubscriptionRevision(value => value + 1)
    } else { refreshRequested.current = true; setRevision(value => value + 1) }
  }
  const manage = (id: string, operation: () => Promise<unknown>, removed?: boolean) => {
    if (pendingRef.current !== null || loadingRef.current || backend.binding === undefined) return
    const current = scope.current
    const sourceSession = sessionId
    pendingRef.current = id
    setPending(id)
    setConfirmId(null)
    setCleanupResult(null)
    void Promise.resolve().then(operation).then(result => {
      if (current !== scope.current) return
      if (removed) setCleanupResult((result as { removed: number }).removed)
      refresh()
    }).catch(error => requestError(error, sourceSession)).finally(() => {
      if (current === scope.current) { pendingRef.current = null; setPending(null) }
    })
  }
  const terminate = (info: WorkspaceTerminalInfo) => {
    if (pendingRef.current !== null || loadingRef.current || backend.binding === undefined) return
    const current = scope.current
    const sourceSession = sessionId
    pendingRef.current = info.terminalId
    setPending(info.terminalId)
    setConfirmId(null)
    void backend.binding.source.terminate(info.terminalId).then(() => {
      if (current === scope.current) refresh()
    }).catch(error => requestError(error, sourceSession)).finally(() => {
      if (current === scope.current) { pendingRef.current = null; setPending(null) }
    })
  }
  const activityOf = (info: WorkspaceTerminalInfo) => info.exited ? 'exited' : info.activity ?? 'unknown'
  const running = items.filter(info => activityOf(info) !== 'exited').length
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
        <span className={css.count}>{catalog?.sessionId === sessionId && catalog.store === store && catalog.backend === backend ? items.length : '—'}</span>
      </div>
      <div className={css.summary}>
        {running > 0 && <span><i className={css.statDot} aria-hidden="true" />{running} {t('workspaceTerminalRunning')}</span>}
        {exited > 0 && <span className={css.exitedStat}><i className={css.statDot} aria-hidden="true" />{exited} {t('workspaceTerminalExited')}</span>}
      </div>
      {backend.binding?.source.cleanup && <button type="button" disabled={busy} title={t('workspaceTerminalCleanupHint')}
        onClick={() => manage('cleanup', () => backend.binding!.source.cleanup!(), true)}>{t('workspaceTerminalCleanup')}</button>}
      <button className={css.refresh} type="button" aria-label={t('refresh')} title={t('refresh')} data-loading={loading} disabled={busy}
        onClick={() => { if (!loadingRef.current && pendingRef.current === null) { setConfirmId(null); refresh() } }}>
        <IconRefreshOutlineRegular size={16} />
      </button>
    </header>
    <p className={css.guidance}>{t('workspaceTerminalActivityHint')}</p>
    {cleanupResult !== null && <div role="status" className={css.feedback}>{t('workspaceTerminalCleaned', { count: cleanupResult })}</div>}
    {visible && error !== undefined && <div role="alert" className={css.error}>{error}</div>}
    <div className={css.list} role="list">
      {loading && items.length === 0 ? <div className={css.skeleton} role="status" aria-label={t('loading')}>
        {[0, 1, 2].map(key => <div className={css.skeletonRow} key={key}><span /><span /></div>)}
      </div> : items.length === 0 && error === undefined ? <div className={css.empty}><span className={css.emptyIcon} aria-hidden="true">{terminalTabIcon(18)}</span><strong>{t('workspaceTerminalEmpty')}</strong></div> : items.map(info => {
        const source = summaries?.byId[info.createdBySessionId]?.displayTitle?.trim() || info.createdBySessionId.slice(0, 8)
        const activity = activityOf(info)
        const status = `${t(activity === 'exited' ? 'workspaceTerminalExited' : activity === 'idle' ? 'workspaceTerminalIdle' : activity === 'busy' ? 'workspaceTerminalBusy' : 'workspaceTerminalUnknown')}${activity === 'exited' && info.exitCode != null ? ` (${info.exitCode})` : ''}`
        const lifecycleTime = (value: number | undefined): string | undefined => {
          if (value === undefined || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return undefined
          return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value))
        }
        const started = lifecycleTime(info.commandStartedAt)
        const finished = lifecycleTime(info.commandFinishedAt)
        const lifecycle = [
          started === undefined ? undefined : `▶ ${started}`,
          finished === undefined ? undefined : `■ ${finished}`,
          info.commandExitCode === undefined ? undefined : `exit: ${info.commandExitCode}`,
          info.commandDurationMs === undefined || !Number.isFinite(info.commandDurationMs) ? undefined
            : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(info.commandDurationMs / 1000)} s`,
        ].filter(Boolean).join(' · ')
        const statusTitle = [status, info.activityReason, lifecycle].filter(Boolean).join(' · ')
        const timestamps = [info.lastInputAt, info.lastOutputAt].filter((time): time is number => typeof time === 'number' && Number.isFinite(time) && Number.isFinite(new Date(time).getTime()))
        const lastActivity = timestamps.length ? new Date(Math.max(...timestamps)) : undefined
        return <div className={css.row} role="listitem" key={info.terminalId} data-terminal-id={info.terminalId} data-activity={activity} data-exited={activity === 'exited'} data-confirming={confirmId === info.terminalId} aria-busy={pending === info.terminalId}>
          <span className={css.glyph} aria-hidden="true">{terminalTabIcon(16)}<i className={css.dot} /></span>
          <div className={css.details}>
            <div className={css.titleLine}><strong className={css.title} title={info.title}>{info.title}</strong><span className={css.status} title={statusTitle}>{status}</span></div>
            <div className={css.metadata}><span className={css.cwd} title={info.cwd}>{info.cwd}</span><span className={css.sep} aria-hidden="true">·</span><span className={css.source} title={`${source} · ${info.createdBySessionId}`}>{source}</span></div>
          </div>
          <div className={css.activityMetadata}>
            <span>{t('workspaceTerminalConnections', { count: info.attachedViews ?? '—' })}</span>
            <span>{t('workspaceTerminalLastActivity')}: {lastActivity ? <time dateTime={lastActivity.toISOString()}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(lastActivity)}</time> : t('workspaceTerminalUnknownTime')}</span>
            {info.pinned && !backend.binding?.source.pin && <span title={t('workspaceTerminalPinHint')}>{t('workspaceTerminalPinned')}</span>}
          </div>
          <div className={css.actions}>
            {backend.binding?.source.pin && <button type="button" role="switch" aria-checked={info.pinned === true}
              aria-label={`${t('workspaceTerminalPinned')} · ${info.title}`} title={t('workspaceTerminalPinHint')} disabled={busy}
              onClick={() => manage(info.terminalId, () => backend.binding!.source.pin!(info.terminalId, !info.pinned))}>{t('workspaceTerminalPinned')}</button>}
            <button className={css.terminate} type="button" disabled={busy} aria-expanded={confirmId === info.terminalId}
              aria-controls={confirmId === info.terminalId ? confirmationId : undefined}
              aria-label={`${t('workspaceTerminalTerminate')} · ${info.title}`}
              onClick={event => {
                if (confirmId === info.terminalId) { dismissConfirmation(); return }
                terminateTrigger.current = event.currentTarget
                setConfirmId(info.terminalId)
              }}>{pending === info.terminalId ? t('loading') : t('workspaceTerminalTerminate')}</button>
            <button className={css.open} type="button" disabled={pending !== null} aria-label={`${t('workspaceTerminalOpen')} · ${info.title}`} onClick={() => { setConfirmId(null); openWorkspaceTerminal(store, sessionId, info, backend.binding?.providerId) }}>{t('workspaceTerminalOpen')}</button>
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