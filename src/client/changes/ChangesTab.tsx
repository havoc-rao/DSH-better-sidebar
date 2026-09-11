/**
 * The unified changes tab: one tab, two lenses on "what changed?" — Git
 * (repository truth: staged/unstaged files, commit box, history) and the
 * session round (agent truth: every file the model read, wrote, or edited).
 * Both lenses preview their selections in a shared resizable bottom pane
 * ({@link DiffPane}); git targets expand into the dedicated diff tab docked
 * in the workbench's diff pane. The active lens and the pane height persist
 * in the tab's meta, so the tab
 * reopens exactly where it was left.
 *
 * The commit-message draft is owned HERE (not in the Git lens) so a lens
 * switch — which unmounts the lens — cannot evaporate what the user was
 * typing, and is mirrored to a per-session durable slot: the tab's own
 * `meta` in the bottom workbench (the per-session persisted layout), or the
 * git card's `pluginSettings` blob keyed by session for native right-Sidebar
 * tabs (whose records are memory-only — see {@link isBottomTab}).
 *
 * The session events ride the host's `changes.ops` route (the client
 * runtime exposes no event-log face): the tab pulls the delta past its
 * cursor while visible, folds it into ops, and publishes the op count to a
 * module-level cache the tab-strip badge reads.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SidebarSessionEvent } from '../../context-types.ts'
import type { TabComponentProps } from '../service.ts'
import { t } from '../locales.ts'
import { api } from '../api.ts'
import { usePolling } from '../use-polling.ts'
import { updatePluginSettings } from '../plugin-settings.ts'
import { allLeaves, leafWithTab, patchTab, type SidebarDiffRef, type SidebarStore, type SidebarTab } from '../state.ts'
import { GitLens } from './GitLens.tsx'
import { SessionLens } from './SessionLens.tsx'
import { DiffPane, diffTabOf, type ChangesPreview } from './DiffPane.tsx'
import { extractFileOps, knownContentBefore, type FileOp } from './ops.ts'
import css from './changes.module.css'

/** The default preview pane height (px) before the first drag. */
const PANE_HEIGHT_DEFAULT = 300

/** Cap on accumulated events: the lens shows the recent window, not eternity
 *  (the host enforces the same bound per response). */
const EVENTS_CAP = 4000

/** Live op count per session: the tab's poller writes, the badge reads (a
 *  badge cannot fetch — it must resolve synchronously during render). */
const opCounts = new Map<string, number>()

/** The session's traced-op count as of the last poll (undefined before the
 *  tab has ever pulled; 0 hides the badge pill). */
export function opCountOf(sessionId: string): number | undefined {
  return opCounts.get(sessionId)
}

type Lens = 'git' | 'session'

/** The persisted tab meta (JSON-serializable; rides the layout). */
interface ChangesMeta {
  lens?: Lens
  previewH?: number
  /** The commit-message draft (the bottom-workbench world's mirror). */
  commitMsg?: string
}

/** The git card's pluginSettings key holding per-session commit drafts (the
 *  native right-Sidebar world's mirror — its tab records are memory-only). */
const COMMIT_DRAFTS_KEY = 'commitDrafts'

/** Cap on remembered per-session drafts: insertion order doubles as recency
 *  order (a re-write deletes-then-re-appends its key), and stale sessions
 *  beyond the cap are pruned so the settings doc stays tidy. */
const COMMIT_DRAFTS_CAP = 16

/** The tab's persisted meta object (a malformed meta reads as empty — the
 *  same rule EditorHost's metaOf applies). */
function metaOfTab(tab: SidebarTab): Record<string, unknown> {
  const meta = tab.meta
  return meta !== null && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : {}
}

/** The per-session commit drafts recorded in the git card's settings blob. */
function commitDraftsOf(blob: Record<string, unknown>): Record<string, string> {
  const drafts = blob[COMMIT_DRAFTS_KEY]
  return drafts !== null && typeof drafts === 'object' && !Array.isArray(drafts)
    ? drafts as Record<string, string>
    : {}
}

/** The persisted commit draft for one session: the tab's own meta first (the
 *  bottom-workbench world, where the meta rides the per-session layout),
 *  then the git card's settings draft (the native-right world, whose records
 *  are memory-only). */
function commitDraftOf(tab: SidebarTab, sessionId: string, pluginSettings: Record<string, Record<string, unknown>>): string {
  const meta = metaOfTab(tab).commitMsg
  if (typeof meta === 'string') return meta
  const draft = commitDraftsOf(pluginSettings['git'] ?? {})[sessionId]
  return typeof draft === 'string' ? draft : ''
}

/** Whether this tab object IS one of the active session's bottom-workbench
 *  tabs — by reference identity, not id: a native right-Sidebar record with
 *  the same id ('git' is single-instance in both surfaces) is a DIFFERENT
 *  object, and only the bottom tab is the store-persisted one. Called at
 *  tab-capture time (the tab is on screen, its session is the active one). */
function isBottomTab(store: SidebarStore, tab: SidebarTab): boolean {
  const state = store.getSnapshot().state
  return state !== undefined && allLeaves(state.bottomSplits).some(leaf => leaf.tabs.includes(tab))
}

export function ChangesTab({ ctx, store, scope, tab, visible, onOpenFile, onOpenDiff }: TabComponentProps) {
  const meta = (tab.meta ?? {}) as ChangesMeta
  const [lens, setLens] = useState<Lens>(meta.lens === 'session' ? 'session' : 'git')
  const [preview, setPreview] = useState<ChangesPreview | null>(null)
  const [paneHeight, setPaneHeight] = useState<number>(
    typeof meta.previewH === 'number' && meta.previewH >= 140 ? meta.previewH : PANE_HEIGHT_DEFAULT,
  )

  // ── Commit-message draft (owned here, not in the Git lens: a lens switch
  //    unmounts the lens, and lens-local state would evaporate the typing).
  //    Seeded from the persisted mirrors, written back debounced (400ms),
  //    flushed immediately on unmount / a real tab swap, and cleared right
  //    after a successful commit. ──────────────────────────────────────────
  const [commitMsg, setCommitMsg] = useState<string>(
    () => commitDraftOf(tab, scope.sessionId, store.getPrefs().pluginSettings),
  )
  /** The tab + displayed session the current draft belongs to, read by the
   *  flush paths (a session switch right after typing must not drop the
   *  last keystrokes — the debounce may never fire). NEVER assigned during
   *  render: the session-sync effect below reads them as the PREVIOUS
   *  identity and a render-time assignment would capture the new one and
   *  skip the flush. */
  const draftTabRef = useRef<SidebarTab>(tab)
  const draftSessionRef = useRef<string>(scope.sessionId)
  /** The world the captured tab lives in — captured at tab-capture time (the
   *  identity check is only valid while the tab is the displayed one). */
  const draftBottomRef = useRef<boolean>(isBottomTab(store, tab))
  const draftRef = useRef(commitMsg)
  draftRef.current = commitMsg
  const draftTimer = useRef<number | undefined>(undefined)
  /** Write the draft into the durable mirror of the CAPTURED tab's world:
   *  the bottom workbench's per-session layout (patchTab by id, targeted at
   *  the draft's session — never the active-session updateTab route, whose
   *  write would land a post-switch flush in the WRONG session's layout), or
   *  the git card's pluginSettings blob keyed by the tab's session (the
   *  native-right records are memory-only, so the settings doc is the only
   *  durable slot the plugin owns there). */
  const writeDraft = useCallback((sessionId: string, target: SidebarTab, draft: string, bottom: boolean): void => {
    if (bottom) {
      store.reduceFor(sessionId, state => {
        // Merge into the CURRENT persisted meta, not the captured tab's: a
        // stale capture must not clobber concurrent meta writes (lens,
        // pane height) that landed since this draft was scheduled.
        const current = leafWithTab(state.bottomSplits, target.id)?.tabs.find(entry => entry.id === target.id)
        return patchTab(state, target.id, {
          meta: { ...(current !== undefined ? metaOfTab(current) : metaOfTab(target)), commitMsg: draft },
        })
      })
    } else {
      updatePluginSettings(store, 'git', blob => {
        const drafts = commitDraftsOf(blob)
        delete drafts[sessionId]
        drafts[sessionId] = draft
        const keys = Object.keys(drafts)
        for (const stale of keys.slice(0, Math.max(0, keys.length - COMMIT_DRAFTS_CAP))) delete drafts[stale]
        return { ...blob, [COMMIT_DRAFTS_KEY]: drafts }
      })
    }
  }, [store])
  /** Schedule a debounced draft write; unchanged text never writes. The
   *  captured tab/session keep the write valid even after a session switch
   *  (the timer closure outlives the component). */
  const persistDraft = (draft: string): void => {
    const target = draftTabRef.current
    const sessionId = draftSessionRef.current
    if (draft === commitDraftOf(target, sessionId, store.getPrefs().pluginSettings)) return
    window.clearTimeout(draftTimer.current)
    draftTimer.current = window.setTimeout(() => {
      writeDraft(sessionId, target, draft, draftBottomRef.current)
    }, 400)
  }
  /** The single typing path: set the owned state AND schedule the write. */
  const onCommitMsgChange = (next: string): void => {
    setCommitMsg(next)
    persistDraft(next)
  }
  /** A successful commit: clear the owned state and the persisted mirrors
   *  immediately — not via the debounce — so a committed message never
   *  resurrects when the tab reopens. */
  const onCommitMsgCommitted = (): void => {
    setCommitMsg('')
    window.clearTimeout(draftTimer.current)
    writeDraft(draftSessionRef.current, draftTabRef.current, '', draftBottomRef.current)
  }
  /** A real tab swap — the displayed session changed, or the pane handed us
   *  a different logical tab (id/type) — flushes the pending draft into the
   *  PREVIOUS session immediately (the debounce may never fire) and re-seeds
   *  from the new tab. Identity-only churn within the SAME session (an
   *  unrelated store notify re-renders the pane with fresh tab objects)
   *  never flushes or re-seeds: the in-flight draft survives the re-render. */
  useEffect(() => {
    const previous = draftTabRef.current
    const previousSession = draftSessionRef.current
    const previousBottom = draftBottomRef.current
    const logicalSwap = previous.id !== tab.id || previous.type !== tab.type
    if (previousSession !== scope.sessionId || logicalSwap) {
      if (draftRef.current !== commitDraftOf(previous, previousSession, store.getPrefs().pluginSettings)) {
        writeDraft(previousSession, previous, draftRef.current, previousBottom)
      }
      window.clearTimeout(draftTimer.current)
      setCommitMsg(commitDraftOf(tab, scope.sessionId, store.getPrefs().pluginSettings))
    }
    draftTabRef.current = tab
    draftSessionRef.current = scope.sessionId
    draftBottomRef.current = isBottomTab(store, tab)
  }, [tab, scope.sessionId, store, writeDraft])
  /** Unmount flush: a session switch right after typing must not lose the
   *  pending keystrokes (the debounce may never fire). */
  useEffect(() => () => {
    window.clearTimeout(draftTimer.current)
    const target = draftTabRef.current
    const sessionId = draftSessionRef.current
    if (draftRef.current !== commitDraftOf(target, sessionId, store.getPrefs().pluginSettings)) {
      writeDraft(sessionId, target, draftRef.current, draftBottomRef.current)
    }
  }, [store, writeDraft])

  // ── Session-event accumulation: one pull on mount, then a 2.5s delta
  //    poll while visible (paused otherwise; the next visible tick catches
  //    up). The cursor is the last delivered seq, so each poll ships only
  //    what the accumulator lacks. ────────────────────────────────────────
  const eventsRef = useRef<readonly SidebarSessionEvent[]>([])
  // The fold of eventsRef as of the last poll. extractFileOps parses every
  // accumulated tool/call (up to EVENTS_CAP events); running it once per
  // poll and REUSING the result across renders (the render used to re-fold
  // the whole window, twice per tick, and the fresh array defeated the
  // downstream memo on every poll) keeps the 2.5s tick at one fold.
  const opsRef = useRef<readonly FileOp[]>([])
  const seqRef = useRef(0)
  const pollGen = useRef(0)
  const [opsError, setOpsError] = useState(false)
  const [tick, setTick] = useState(0)
  const pull = useCallback(async (): Promise<void> => {
    const generation = pollGen.current
    try {
      const { events, lastSeq } = await api.changesOps(scope, seqRef.current)
      if (generation !== pollGen.current) return
      if (events.length > 0) {
        const merged = [...eventsRef.current, ...events]
        eventsRef.current = merged.length > EVENTS_CAP ? merged.slice(merged.length - EVENTS_CAP) : merged
      }
      if (lastSeq > seqRef.current) seqRef.current = lastSeq
      const folded = extractFileOps(eventsRef.current)
      opsRef.current = folded
      opCounts.set(scope.sessionId, folded.length)
      setOpsError(false)
      setTick(value => value + 1)
    } catch {
      // Offline / route unavailable: keep the last fold; surface it inline
      // only while nothing has ever loaded.
      if (generation === pollGen.current) setOpsError(true)
    }
    // Granular scope fields: the scope object's identity churns, only its
    // sessionId / cwd fields gate the poll target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.sessionId, scope.cwd])
  useEffect(() => {
    pollGen.current += 1
    eventsRef.current = []
    opsRef.current = []
    seqRef.current = 0
    setOpsError(false)
  }, [scope.sessionId])
  // One pull on every input change — mount, scope change, and visibility
  // flip all re-pull (a hidden tab still catches up on the flip); only the
  // poll CADENCE below is gated by visibility.
  useEffect(() => { void pull() }, [visible, pull])
  usePolling(visible, pull, { intervalMs: 2_500 })
  // tick only forces the re-render; the fold reads the ref directly.
  void tick
  const ops = opsRef.current

  /** Persist a meta patch onto the tab (lens choice, pane height). */
  const patchMeta = (patch: ChangesMeta): void => {
    ctx.get('betterSidebar')?.updateTab(tab.id, {
      meta: { ...(tab.meta as ChangesMeta | undefined ?? {}), ...patch },
    })
  }

  const chooseLens = (next: Lens): void => {
    if (next === lens) return
    setLens(next)
    patchMeta({ lens: next })
  }

  /** Preview one git change (worktree file or commit) from the Git lens. */
  const previewGit = (ref: SidebarDiffRef): void => {
    setPreview({ kind: 'git', ref })
  }

  /** Preview one session op (with its best-effort prior content snapshot). */
  const previewOp = (path: string, op: FileOp): void => {
    setPreview({ kind: 'op', path, op, prior: knownContentBefore(ops, path, op) })
  }

  /** Expand the current git preview into the dedicated diff tab, docked
   *  into the workbench's diff pane. */
  const expandPreview = (): void => {
    if (preview?.kind !== 'git') return
    onOpenDiff?.(diffTabOf(preview.ref))
  }

  const previewKey = (target: ChangesPreview): string => target.kind === 'git'
    ? (target.ref.kind === 'worktree'
        ? `git:w:${target.ref.path}:${target.ref.staged ? 's' : 'u'}`
        : `git:c:${target.ref.hashFull}`)
    : `op:${target.op.callId}`

  return (
    <div className={css.root}>
      <div className={css.lensBar}>
        <div className={css.lensSwitch} role="group" aria-label={t('changes')}>
          <button
            type="button"
            className={css.lensButton}
            data-active={lens === 'git' ? 'true' : undefined}
            aria-pressed={lens === 'git'}
            onClick={() => { chooseLens('git') }}
          >
            {t('changesGitLens')}
          </button>
          <button
            type="button"
            className={css.lensButton}
            data-active={lens === 'session' ? 'true' : undefined}
            aria-pressed={lens === 'session'}
            onClick={() => { chooseLens('session') }}
          >
            {t('changesSessionLens')}
          </button>
        </div>
      </div>
      {lens === 'git'
        ? (
          <GitLens
            scope={scope}
            store={store}
            commitMsg={commitMsg}
            onCommitMsgChange={onCommitMsgChange}
            onCommitMsgCommitted={onCommitMsgCommitted}
            visible={visible}
            onOpenFile={onOpenFile ?? (() => { /* no-op */ })}
            onPreview={previewGit}
            selectedRef={preview !== null && preview.kind === 'git' ? preview.ref : null}
          />
        )
        : (
          <SessionLens
            ops={ops}
            loadError={opsError && ops.length === 0}
            onPreview={previewOp}
            selectedCallId={preview !== null && preview.kind === 'op' ? preview.op.callId : null}
          />
        )}
      {preview !== null && (
        <DiffPane
          key={previewKey(preview)}
          target={preview}
          scope={scope}
          height={paneHeight}
          onHeightCommit={(height) => { setPaneHeight(height); patchMeta({ previewH: height }) }}
          onClose={() => { setPreview(null) }}
          onExpand={expandPreview}
        />
      )}
    </div>
  )
}
