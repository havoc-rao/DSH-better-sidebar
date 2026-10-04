import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '../context-types.ts'
import { api, type SessionScope } from './api.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import type { CentralCodeEditorProps } from './CentralCodeEditor.tsx'
import { CentralEditorStore } from './central-editor-state.ts'
import { t } from './locales.ts'
import { resolveSidebarPath } from './paths.ts'
import css from './CentralEditor.module.css'

// Writes outlive view mounts, so reopening cannot submit a second stale baseline.
const pendingWrites = new WeakMap<CentralEditorStore, Set<string>>()
const cacheCleanups = new WeakMap<CentralEditorStore, Map<string, () => void>>()
const activationIds = new WeakMap<CentralEditorStore, string>()
const documentKey = (store: CentralEditorStore, sessionId: string | undefined, path: string | undefined, generation: number | undefined) => JSON.stringify([activationIds.get(store), sessionId, path, generation])
const LazyCodeEditor = lazyChunkComponent<CentralCodeEditorProps>('editor', mod => mod.CentralCodeEditor as ComponentType<CentralCodeEditorProps> | undefined)

/** Only selected while editing: releasing our single-slot entry restores the host. */
export function registerCentralEditor(ctx: Context) {
  const store = new CentralEditorStore()
  activationIds.set(store, crypto.randomUUID())
  cacheCleanups.set(store, new Map())
  let offView: (() => void) | undefined
  let declared = false
  let disposed = false
  const sync = () => {
    const visible = declared && store.getSnapshot().visible
    if (visible && offView === undefined) {
      try {
        offView = ctx.slots.register({ name: 'main.conversation', priority: -100 },
          ({ sessionId, useSessionStatus }: CentralSeatProps) => <CentralEditor ctx={ctx} store={store} sessionId={sessionId} useSessionStatus={useSessionStatus} />)
      } catch (error) {
        store.setVisible(false)
        console.error('[dsh-better-sidebar] central editor registration failed', error)
        window.alert(t('centralEditorUnavailable'))
      }
    } else if (!visible && offView !== undefined) {
      const off = offView
      offView = undefined
      off()
    }
  }
  const offState = store.subscribe(sync)
  const offResume = ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'dsh-better-sidebar:central-editor', order: 11,
  }, ({ sessionId }: { sessionId: string }) => {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
    if (state.sessionId !== sessionId || state.documents.length === 0) return null
    return <button type="button" onClick={() => store.setVisible(true)}>{t('centralEditorTitle')}</button>
  }))
  const preventDraftLoss = (event: BeforeUnloadEvent) => {
    if (!store.hasDirtyDocuments()) return
    event.preventDefault()
    event.returnValue = ''
  }
  window.addEventListener('beforeunload', preventDraftLoss)
  const offSlot = ctx.slots.inject('main.conversation', () => {
    declared = true
    sync()
    return () => { declared = false; offView?.(); offView = undefined }
  })
  const offMounted = ctx.inject(['sidebarRight'], scope => {
    const mounted = (scope.get('sidebarRight') as unknown as { mounted?: { getSnapshot(): string | undefined; subscribe(fn: () => void): () => void } })?.mounted
    if (!mounted) return
    const follow = () => store.setSession(mounted.getSnapshot())
    follow()
    scope.effect(() => mounted.subscribe(follow))
  })
  return {
    openFile(scope: SessionScope, path: string): boolean {
      if (!declared || disposed) { window.alert(t('centralEditorUnavailable')); return false }
      // Central mode is deliberately session-local, never a global panel navigation.
      if (store.getSnapshot().sessionId !== scope.sessionId) return false
      store.openFile(resolveSidebarPath(scope.cwd, path))
      return store.getSnapshot().visible && offView !== undefined
    },
    isActive(sessionId: string) { const state = store.getSnapshot(); return state.sessionId === sessionId && state.visible },
    dispose() { disposed = true; window.removeEventListener('beforeunload', preventDraftLoss); offResume(); offState(); offMounted.dispose(); offSlot(); offView?.(); offView = undefined; for (const clean of cacheCleanups.get(store)?.values() ?? []) clean(); cacheCleanups.delete(store) },
  }
}

interface CentralSessionStatus { running: boolean | undefined; pendingInteraction?: unknown; completionUnread?: boolean }
interface CentralSeatProps {
  sessionId?: string
  useSessionStatus<T>(selector: (value: ReadonlyMap<string, CentralSessionStatus>) => T): T
}
function CentralEditor({ ctx, store, sessionId, useSessionStatus }: CentralSeatProps & { ctx: Context; store: CentralEditorStore }) {
  const status = useSessionStatus(value => sessionId === undefined ? undefined : value.get(sessionId))
  // Host approvals/questions belong to its composer. Never strand them behind editing.
  useEffect(() => {
    if (status?.pendingInteraction != null) store.setVisible(false, sessionId)
  }, [status?.pendingInteraction, store, sessionId])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const sessions = useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot)
  const current = sessionId === undefined ? undefined : sessions.byId[sessionId]
  const doc = state.documents.find(item => item.path === state.activePath)
  const scope = useMemo(() => sessionId === undefined ? undefined : { sessionId, cwd: current?.cwd }, [sessionId, current?.cwd])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [details, setDetails] = useState(false)
  const savingRef = useRef(false)
  const activeKey = documentKey(store, sessionId, doc?.path, doc?.generation)
  const latestKey = useRef(activeKey)
  latestKey.current = activeKey
  const loaded = doc?.savedContent !== undefined
  useEffect(() => {
    setError(null)
    if (!scope || !doc || loaded) return
    const abort = new AbortController()
    api.fsRead(scope, doc.path, abort.signal).then(result => {
      if (result.kind !== 'text') throw new Error(t('centralEditorBinary'))
      if (result.truncated) throw new Error(t('centralEditorTruncated'))
      if (!abort.signal.aborted && store.getSessionSnapshot(scope.sessionId)?.documents.find(item => item.path === doc.path)?.generation === doc.generation) {
        store.initializeContent(doc.path, result.content, scope.sessionId)
      }
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => abort.abort()
    // Identity/loaded state drives IO; draft keystrokes must not abort a read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, loaded])

  const save = useCallback(() => {
    if (!scope || !doc || doc.savedContent === undefined || savingRef.current) return
    const writes = pendingWrites.get(store) ?? new Set<string>()
    pendingWrites.set(store, writes)
    if (writes.has(activeKey)) return
    const submitted = doc.draft ?? doc.savedContent
    const key = activeKey
    writes.add(key)
    savingRef.current = true
    setSaving(true)
    setError(null)
    api.fsWrite(scope, doc.path, submitted, doc.savedContent).then(() => {
      if (store.getSessionSnapshot(scope.sessionId)?.documents.find(item => item.path === doc.path)?.generation === doc.generation) {
        store.markSaved(doc.path, submitted, scope.sessionId)
      }
    }).catch((reason: unknown) => {
      if (latestKey.current === key) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { writes.delete(key); savingRef.current = false; setSaving(false) })
  }, [doc, scope, activeKey, store])

  const close = (path: string) => {
    const closingDoc = state.documents.find(item => item.path === path)
    const key = documentKey(store, sessionId, path, closingDoc?.generation)
    // Do not let an old save completion retarget a newly reopened document.
    if (pendingWrites.get(store)?.has(key)) return
    const closed = store.closeFile(path) || (window.confirm(t('centralEditorDiscardConfirm')) && store.closeFile(path, { force: true }))
    if (closed) {
      cacheCleanups.get(store)?.get(key)?.()
      cacheCleanups.get(store)?.delete(key)
    }
  }
  const returnToChat = () => store.setVisible(false)
  return <section className={css.root} data-dsh-central-editor="" aria-label={t('centralEditorTitle')}>
    <header className={css.header}>
      <strong>{t('centralEditorTitle')}</strong>
      <span className={css.sessionTitle}>{current?.displayTitle ?? sessionId}</span>
      <button type="button" onClick={returnToChat}>{t('centralEditorReturn')}</button>
    </header>
    <div className={css.tabs} role="tablist" aria-label={t('centralEditorFiles')}>
      {state.documents.map(item => <div key={item.path} className={css.tab} data-active={item.path === state.activePath ? '' : undefined}>
        <button type="button" role="tab" aria-selected={item.path === state.activePath} title={item.path} onClick={() => store.setActivePath(item.path)}>{item.title}{item.dirty ? ' ●' : ''}</button>
        <button type="button" aria-label={`${t('close')} ${item.title}`} onClick={() => close(item.path)}>×</button>
      </div>)}
    </div>
    <div className={css.toolbar}>
      <span className={css.path} title={doc?.path}>{doc?.path ?? t('centralEditorEmpty')}</span>
      <button type="button" disabled={!loaded || saving || !doc?.dirty} onClick={save}>{saving ? t('loading') : t('save')}</button>
    </div>
    {error !== null && <div className={css.error} role="alert">{error}</div>}
    <div className={css.editor}>
      {doc && loaded && scope ? <LazyCodeEditor key={activeKey} documentKey={activeKey} path={doc.path} content={doc.draft ?? doc.savedContent!}
        onChange={text => store.updateDraft(doc.path, text, scope.sessionId)} onSave={save}
        registerCacheCleanup={(key, cleanup) => cacheCleanups.get(store)?.set(key, cleanup)}
        onCursor={(line, column) => setCursor({ line, column })} />
        : <div className={css.empty}>{doc ? (error === null ? t('loading') : t('centralEditorUnavailable')) : t('centralEditorEmpty')}</div>}
    </div>
    <footer className={css.footer}>
      <span>{t('centralEditorCursor', { line: cursor.line, column: cursor.column })}</span>
      <span>{doc?.dirty ? t('unsaved') : t('saved')}</span>
    </footer>
    <aside className={css.statusSeat} aria-label={t('centralEditorSessionStatus')}>
      {details && <div className={css.statusDetails}>
        <strong>{t('centralEditorSessionStatus')}</strong>
        {Object.values(sessions.byId).filter(item => item.running === true).map(item => <button type="button" key={item.id} onClick={() => { returnToChat(); ctx.sessions.open?.(item.id) }}>{item.displayTitle} · {t('centralEditorRunning')}</button>)}
        <p>{t('centralEditorStatusHint')}</p>
      </div>}
      <div className={css.statusFloat}>
        <button type="button" aria-expanded={details} onClick={() => setDetails(value => !value)}>{current?.running === true ? '● ' : '○ '}{current?.running === true ? t('centralEditorRunning') : t('centralEditorIdle')}</button>
        <span className={css.sessionTitle}>{current?.displayTitle}</span>
        <button type="button" onClick={returnToChat}>{t('centralEditorReturn')} ↗</button>
      </div>
    </aside>
  </section>
}
