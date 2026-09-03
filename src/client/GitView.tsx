/**
 * The source-control panel: status list (staged vs unstaged), stage/unstage,
 * commit with a message box, branch switch, and a VSCode-like history — rows
 * carry branch decorations, author and relative time. Clicking a changed
 * file or a history row opens a dedicated diff TAB (see {@link DiffTab}),
 * placed below the git pane on first use. File rows and history rows open a
 * right-click context menu with advanced operations (open in editor, discard,
 * revert, cherry-pick, copy paths/hashes). Refresh is manual + on mount/
 * focus. While visible it polls lightweight porcelain state so model-authored
 * file changes appear without a manual refresh.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Button, IconBranchOutline16, IconChevronDownOutline14, IconCodeOutline16, IconCopyOutline16,
  IconDownloadOutline16, IconLoadingOutline16, IconRefreshOutline16,
  IconSparkle16, IconTrashOutline16, Input, Menu, Modal, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { VscStarFull } from 'react-icons/vsc'
import type { GitBranchStatus, GitBranchTip, GitGraphEntry, GitStatusEntry, GitStatusResult, GitWorktree, SessionScope } from './api.ts'
import { api, SidebarApiError } from './api.ts'
import { notifyGitStatusChanged, subscribeGitStatusChanged } from './git-status.ts'
import { GitGraphSvg } from './GitGraph.tsx'
import { computeGraphRows } from './git-graph.ts'
import { isWithinWorkspace, relativeTo } from './paths.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../prefs-shared.ts'
import { resolveSidebarPath } from './produced-files.ts'
import { relativeTime, t } from './locales.ts'
import { updatePluginSettings } from './plugin-settings.ts'
import type { SidebarStore, SidebarTab } from './state.ts'
import {
  GIT_COMMIT_SETTING_KEYS,
  WATCHED_BRANCHES_KEY,
  WATCHED_BRANCHES_MAX,
  commitCustomTemplateOf,
  commitHistoryRefsOf,
  commitLlmModelOf,
  commitLlmProviderOf,
  commitTemplateOf,
  watchedBranchesOf,
} from '../commit-draft-shared.ts'
import css from './sidebar.module.css'

/** The XY status letters a row badge shows (X = index, Y = worktree). */
function badgeOf(entry: GitStatusEntry): string {
  const index = entry.xy[0]
  const worktree = entry.xy[1]
  if (index !== undefined && index !== ' ' && index !== '?') return index
  if (worktree !== undefined && worktree !== ' ' && worktree !== '?') return worktree
  return '?'
}

/** Whether the entry carries STAGED (index) changes — the X letter is set. */
function isStagedEntry(entry: GitStatusEntry): boolean {
  const index = entry.xy[0]
  return index !== undefined && index !== ' ' && index !== '?'
}

/** Whether the entry carries UNSTAGED (worktree) changes — the Y letter is set
 *  (untracked `??` counts as unstaged: it is a worktree-only change). A file
 *  with both letters set ('MM') lands in BOTH sections. */
function isUnstagedEntry(entry: GitStatusEntry): boolean {
  if (entry.xy === '??') return true
  const worktree = entry.xy[1]
  return worktree !== undefined && worktree !== ' ' && worktree !== '?'
}

/** Whether the entry is untracked (`??`): git diff never includes it. */
function isUntracked(entry: GitStatusEntry): boolean {
  return badgeOf(entry) === '?'
}

/** The last path segment (tab title for a file's diff). */
function baseName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** One history-row ref chip: display name + kind (drives the local/remote colors). */
export interface GitRefChip {
  name: string
  kind: 'branch' | 'remote' | 'tag' | 'other'
}

/**
 * Parse one log row's full `%D` decorations (`--decorate=full`) into display
 * chips. Full names make the classification unambiguous: short decorations
 * cannot tell a local branch `feature/foo` from a remote-tracking ref of a
 * remote named `feature`. Detached `HEAD` (no arrow target) renders nothing.
 */
export function refChips(refs: string): GitRefChip[] {
  const chips: GitRefChip[] = []
  for (const raw of refs.split(',')) {
    const ref = raw.trim()
    if (ref === '' || ref === 'HEAD') continue
    if (ref.startsWith('HEAD -> ')) {
      chips.push(chipOf(ref.slice('HEAD -> '.length)))
    } else {
      chips.push(chipOf(ref.startsWith('tag: ') ? ref.slice('tag: '.length) : ref))
    }
  }
  return chips
}

/** One full ref name → its display name + kind (by the refs/* prefix). */
function chipOf(full: string): GitRefChip {
  if (full.startsWith('refs/heads/')) return { name: full.slice('refs/heads/'.length), kind: 'branch' }
  if (full.startsWith('refs/remotes/')) return { name: full.slice('refs/remotes/'.length), kind: 'remote' }
  if (full.startsWith('refs/tags/')) return { name: full.slice('refs/tags/'.length), kind: 'tag' }
  return { name: full, kind: 'other' }
}

/** The pending destructive action (discard / revert / cherry-pick), gated by a confirm modal. */
interface ConfirmState {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
}

/** History batch size: the log loads lazily in pages so a long history never
 *  floods the panel at once (the end of the log is reached by paging). */
const LOG_BATCH = 20

/** Reveal cap for a watched tip below the loaded page: page down up to this
 *  many batches (160 commits) before giving up and leaving the bubble. */
const REVEAL_PAGE_CAP = 8

/** One history page for the given scope. The graph route now also
 *  accepts the selected linked worktree (resolveWorktree enforces the
 *  allowlist on the host), so we route BOTH branches through it and keep
 *  parents on every row — without parents the lane layout collapses to a
 *  single column, exactly the symptom we saw when an MR review toggled the
 *  worktree selector onto a dirty linked checkout. */
const historyPage = async (
  scope: SessionScope,
  count: number,
  skip: number,
  worktree: string | undefined,
): Promise<GitGraphEntry[]> =>
  api.gitLogGraph(scope, count, skip, worktree).catch(() => [] as GitGraphEntry[])

export function GitView(props: {
  scope: SessionScope
  /** Optional (v0.17.0): absent → static prefs (isolated tests / previewers). */
  store?: SidebarStore
  onOpenFile: (path: string) => void
  /** Open a diff tab (the shell places it below the git pane on first use). */
  onOpenDiff: (tab: SidebarTab) => void
  /** Poll only while the tab is actually visible. */
  visible?: boolean
}) {
const { scope, store, onOpenFile, onOpenDiff, visible } = props
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [selectedWorktree, setSelectedWorktree] = useState<string | undefined>()
  const [repoRoot, setRepoRoot] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branchNames, setBranchNames] = useState<string[]>([])
  /** The current branch's upstream relationship (ahead/behind/gone/no upstream). */
  const [branchStatus, setBranchStatus] = useState<GitBranchStatus | null>(null)
  /** Whether a fetch is in flight (the button shows a spinner + disables). */
  const [fetching, setFetching] = useState(false)
  const [logEntries, setLogEntries] = useState<GitGraphEntry[]>([])
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  /** Whether the history was fully paged (a batch shorter than LOG_BATCH). */
  const [logEnded, setLogEnded] = useState(false)
  const [logLoadingMore, setLogLoadingMore] = useState(false)
  /** Whether an AI commit draft is streaming right now. */
  const [drafting, setDrafting] = useState(false)
  /** The live side-card prefs (the AI draft reads the git tab's own blob).
   *  `store.subscribe` is an unbound class method — React calls the
   *  subscribe function as a bare function (strict mode → `this` is
   *  undefined), so it MUST be wrapped; a raw method reference would crash
   *  reading `this.listeners` (regression: "reading 'listeners'"). */
  const prefs = useSyncExternalStore(
    useCallback((callback: () => void) => store?.subscribe(callback) ?? (() => { /* no store: static prefs */ }), [store]),
    useCallback(() => store?.getSnapshot().prefs ?? SIDEBAR_PREFS_DEFAULTS, [store]),
  )

  /** The watched (重点关注) branches — user-picked local branches whose tips
   *  get divergence markers in the history (row rings + top/bottom bubbles).
   *  Persisted in the git tab's own pluginSettings blob; the local state is
   *  the optimistic mirror, re-synced whenever the persisted blob changes. */
  const [watched, setWatched] = useState<string[]>(() => watchedBranchesOf(prefs.pluginSettings['git']))
  useEffect(() => {
    setWatched(next => {
      const synced = watchedBranchesOf(prefs.pluginSettings['git'])
      return next.join('\u0000') === synced.join('\u0000') ? next : synced
    })
  }, [prefs])
  /** Each watched branch's tip relative to the checkout HEAD. */
  const [tips, setTips] = useState<GitBranchTip[]>([])
  /** A bottom-bubble reveal (page down to a watched tip) is in flight. */
  const [revealing, setRevealing] = useState(false)

  /** The open file-row context menu (cursor position for the portaled Menu). */
  const [fileMenu, setFileMenu] = useState<{ entry: GitStatusEntry; staged: boolean; x: number; y: number } | null>(null)
  /** The open history-row context menu. */
  const [historyMenu, setHistoryMenu] = useState<{ entry: GitGraphEntry; x: number; y: number } | null>(null)
  /** The open fetch menu (the "fetch --prune" option, anchored at the chevron). */
  const [fetchMenu, setFetchMenu] = useState<{ x: number; y: number } | null>(null)
  /** The pending destructive action awaiting confirmation. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const refreshInFlight = useRef(false)
  /** A refresh issued while another is still resolving is QUEUED and replayed
   *  from the settled state instead of being dropped. Without this, a
   *  stage/commit/discard/checkout dispatched during a slow poll would
   *  silently never repaint — the mutation lands on disk, but the panel keeps
   *  the pre-mutation rows until the NEXT poll cycle. */
  const pendingRefreshRef = useRef<{ silent: boolean } | null>(null)
  /** Suppresses the panel's OWN bus broadcast: refreshTarget notifies the
   *  explorer only after committing this panel's state, so the GitView bus
   *  subscription below must not re-refresh on that same notification (the
   *  broadcast is synchronous — the flag is consumed by the very listener
   *  run it guards). */
  const ownBroadcastRef = useRef(false)
  /** Monotonic request id: a manual worktree switch invalidates any older poll
   *  before it can publish state from the previous checkout. */
  const refreshGeneration = useRef(0)
  const worktreeChosenByUser = useRef(false)
  /** selectedWorktree read inside refresh without re-creating the callback:
   *  avoids a spurious full refresh on every auto-select (the very state
   *  change refresh writes back via setSelectedWorktree would recreate the
   *  callback and re-trigger the mount effect — an N→N+1 fetch loop). */
  const selectedRef = useRef<string | undefined>(undefined)
  useEffect(() => { selectedRef.current = selectedWorktree }, [selectedWorktree])
  /** The watch list read inside refreshTarget's stable callback (a stale
   *  closure would keep fetching tips for a removed watch entry). */
  const watchedRef = useRef(watched)
  useEffect(() => { watchedRef.current = watched }, [watched])

  const gitScope: SessionScope = repoRoot === undefined ? scope : { ...scope, repoRoot }

  /** The watched branches' tips for one checkout ([] when nothing is
   *  watched — no network round-trip). Failures degrade to []: markers are
   *  decoration, never an error surface. */
  const fetchTipsFor = async (target: string | undefined): Promise<GitBranchTip[]> => {
    const names = watchedRef.current
    if (names.length === 0) return []
    return api.gitBranchTips(gitScope, names, target)
      .then(result => result.tips, () => [])
  }

  /** Publish a complete checkout-derived view. Status, branch choices and
   *  history are one consistency unit: never mix rows from two worktrees. */
  const refreshTarget = useCallback(async (
    target: string | undefined,
    options: { loading: boolean; generation: number },
  ): Promise<void> => {
    if (options.loading) setLoading(true)
    setError(null)
    try {
      const [statusResult, branchResult, logResult, upstreamResult, tipsResult] = await Promise.all([
        api.gitStatus(gitScope, target),
        api.gitBranch(gitScope, target).catch(() => ({ current: '', names: [] as string[] })),
        // The first history page only; the rest arrives via "load more". The
        // graph flavor carries parent hashes (topo-ordered) for the lane layout.
        historyPage(gitScope, LOG_BATCH, 0, target),
        // The upstream/ahead-behind relationship; a failure (e.g. no git
        // branch config) never hides the rest of the panel.
        api.gitBranchStatus(gitScope, target).catch(() => null),
        // The watched tips ride the same consistency unit as the rows they
        // mark: never mix markers from one checkout into another's graph.
        fetchTipsFor(target),
      ])
      if (options.generation !== refreshGeneration.current) return
      setStatus(statusResult)
      if (statusResult.root !== undefined && statusResult.root !== repoRoot) setRepoRoot(statusResult.root)
      setBranchNames(branchResult.names)
      setLogEntries(logResult)
      setBranchStatus(upstreamResult)
      setTips(tipsResult)
      setLogEnded(logResult.length < LOG_BATCH)
      // The explorer's tree decorations ride the same status snapshot —
      // every successful refresh (mount, focus, stage, commit, discard…)
      // recolors the tree rows too. This panel's own subscription consumes
      // the broadcast (ownBroadcastRef) so it never re-refreshes itself.
      ownBroadcastRef.current = true
      notifyGitStatusChanged()
    } catch (reason) {
      if (options.generation === refreshGeneration.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (options.loading && options.generation === refreshGeneration.current) setLoading(false)
    }
  }, [scope.sessionId, scope.cwd, repoRoot])

  const refresh = useCallback(async (silent = false): Promise<void> => {
    if (refreshInFlight.current) {
      // A poll or mutation refresh is still resolving — queue this request
      // instead of swallowing it; the settled refresh replays it (see
      // pendingRefreshRef). Multiple requests collapse into one replay, which
      // is fine: a refresh is an idempotent fresh pull of git status.
      pendingRefreshRef.current = { silent }
      return
    }
    refreshInFlight.current = true
    let generation = refreshGeneration.current
    try {
      const listed = await api.gitWorktrees(scope)
      if (generation !== refreshGeneration.current) return
      setWorktrees(listed)
      const selectedStillExists = listed.some(entry => entry.path === selectedRef.current)
      let target = selectedStillExists ? selectedRef.current : listed.find(entry => entry.current)?.path
      // DSH and other coding agents commonly create one linked checkout while
      // the session remains rooted at the clean primary checkout. Select that
      // checkout automatically only when the choice is unambiguous.
      const current = listed.find(entry => entry.current)
      const dirtyLinked = listed.filter(entry => !entry.current && entry.changes > 0)
      if (!worktreeChosenByUser.current) {
        target = (current?.changes ?? 0) === 0 && dirtyLinked.length === 1
          ? dirtyLinked[0]!.path
          : current?.path
      }
      const targetChanged = target !== selectedRef.current
      if (targetChanged) {
        // Changing the automatically selected checkout invalidates any direct
        // target refresh that may still be resolving for the previous one.
        generation = refreshGeneration.current += 1
        selectedRef.current = target
        setSelectedWorktree(target)
        // Remove rows owned by the previous checkout immediately: keeping them
        // interactive while the target changes could apply a destructive action
        // to the new checkout with stale history from the old one.
        setStatus(null)
        setBranchNames([])
        setLogEntries([])
        setLogEnded(false)
        setLogLoadingMore(false)
      }
      // A poll may update status alone only while staying on the same checkout.
      // Any automatic selection change refreshes the complete derived view.
      // The upstream relationship rides the same cheap poll: a commit made
      // outside the panel (model-authored) must flip the ahead count without
      // a manual refresh, and the cost is two sub-second ref lookups.
      if (silent && !targetChanged) {
        const [statusResult, upstreamResult, tipsResult] = await Promise.all([
          api.gitStatus(gitScope, target),
          api.gitBranchStatus(gitScope, target).catch(() => null),
          fetchTipsFor(target),
        ])
        if (generation === refreshGeneration.current) {
          setStatus(statusResult)
          if (upstreamResult !== null) setBranchStatus(upstreamResult)
          setTips(tipsResult)
        }
        return
      }
      await refreshTarget(target, { loading: !silent, generation })
    } catch (reason) {
      if (generation === refreshGeneration.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
        if (!silent) setLoading(false)
      }
    } finally {
      refreshInFlight.current = false
      const pending = pendingRefreshRef.current
      if (pending !== null) {
        pendingRefreshRef.current = null
        void refresh(pending.silent)
      }
    }
  }, [scope.sessionId, scope.cwd, refreshTarget])

  useEffect(() => {
    refreshGeneration.current += 1
    refreshInFlight.current = false
    worktreeChosenByUser.current = false
    selectedRef.current = undefined
    setSelectedWorktree(undefined)
  }, [scope.sessionId, scope.cwd])
  useEffect(() => { void refresh() }, [refresh])

  /** A user choice invalidates any older poll and atomically refreshes every
   *  checkout-derived surface before destructive history actions can run. */
  const chooseWorktree = (target: string): void => {
    worktreeChosenByUser.current = true
    selectedRef.current = target
    setSelectedWorktree(target)
    setStatus(null)
    setBranchNames([])
    setLogEntries([])
    setBranchStatus(null)
    setLogEnded(false)
    setLogLoadingMore(false)
    const generation = refreshGeneration.current += 1
    void refreshTarget(target, { loading: true, generation })
  }
  /** Switching the selected child repository must invalidate every
   *  target-derived surface (status/history/log) before the asynchronous
   *  refresh resolves; otherwise stale rows remain actionable while their
   *  handlers already address the new repository. Mirrors chooseWorktree. */
  const chooseRepo = (target: string): void => {
    setRepoRoot(target)
    setStatus(null)
    setBranchNames([])
    setLogEntries([])
    setBranchStatus(null)
    setLogEnded(false)
    setLogLoadingMore(false)
    // Re-list worktrees for the selected child (a workspace container's
    // own worktree list is empty); keep the current linked-checkout choice
    // unless it does not belong to the new repository.
    const generation = refreshGeneration.current += 1
    void refreshTarget(selectedRef.current ?? '', { loading: true, generation })
  }
  useEffect(() => {
    if (visible === false) return
    const timer = window.setInterval(() => { void refresh(true) }, 2_000)
    return () => { window.clearInterval(timer) }
  }, [visible, refresh])

  /** External git-status changes reach this panel through the shared change
   *  bus: the tree's move-to-trash bumps it (a trashed entry IS a real
   *  working-tree change), and so does any future mutating surface. The
   *  subscription turns the one-way GitView→explorer channel into a loop —
   *  any surface that bumps the bus repaints every surface, this panel
   *  included (without it, real status changes made outside the panel never
   *  appear in the changed-file lists while the tab is hidden, and even when
   *  visible they only arrive on the next poll tick). The panel's own
   *  broadcast is suppressed via ownBroadcastRef (see refreshTarget).
   *  Idempotent by construction: a refresh is a fresh pull of git status. */
  useEffect(() => subscribeGitStatusChanged(() => {
    if (ownBroadcastRef.current) {
      ownBroadcastRef.current = false
      return
    }
    void refresh(true)
  }), [refresh])

  /** The poll pauses while the tab is hidden (`visible` gate above); the
   *  moment it becomes visible again the panel pulls a FRESH snapshot
   *  immediately — changes made while hidden must appear the instant the
   *  panel is (re)opened, not two seconds later on the first poll tick. */
  const visibleRef = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    const was = visibleRef.current
    visibleRef.current = visible
    if (was === false && visible === true) void refresh(true)
  }, [visible, refresh])

  /** Append the next history page (lazy: only when the user asks for more). */
  const loadMoreLog = async (): Promise<void> => {
    if (logLoadingMore || logEnded) return
    const generation = refreshGeneration.current
    const target = selectedRef.current
    setLogLoadingMore(true)
    try {
const next = await historyPage(gitScope, LOG_BATCH, logEntries.length, target)
      // A worktree switch clears the old history and increments generation.
      // Never append a late page from that checkout into the new one.
      if (generation !== refreshGeneration.current || target !== selectedRef.current) return
      setLogEntries(entries => [...entries, ...next])
      if (next.length < LOG_BATCH) setLogEnded(true)
    } catch (reason) {
      if (generation === refreshGeneration.current && target === selectedRef.current) {
        setCommitError(`${t('historyLoadError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    } finally {
      if (generation === refreshGeneration.current && target === selectedRef.current) setLogLoadingMore(false)
    }
  }

  /** The diff tab for one changed file (one tab per path+side; same id = focused). */
  const openWorktreeDiff = (entry: GitStatusEntry, staged: boolean): void => {
    onOpenDiff({
      id: `diff:w:${encodeURIComponent(selectedWorktree ?? '')}:${staged ? 's' : 'u'}:${entry.path}`,
      type: 'diff',
      title: baseName(entry.path),
      diff: { kind: 'worktree', path: entry.path, staged, untracked: isUntracked(entry), worktree: selectedWorktree, repoRoot },
    })
  }

  /** The diff tab for one commit (one tab per commit). */
  const openCommitDiff = (entry: GitGraphEntry): void => {
    onOpenDiff({
      id: `diff:c:${encodeURIComponent(selectedWorktree ?? '')}:${entry.hashFull}`,
      type: 'diff',
      title: `${entry.hash} ${entry.subject}`,
      diff: { kind: 'commit', hash: entry.hash, hashFull: entry.hashFull, subject: entry.subject, worktree: selectedWorktree, repoRoot },
    })
  }

  const stageEntry = async (entry: GitStatusEntry, staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(gitScope, entry.path, selectedWorktree)
      else await api.gitStage(gitScope, entry.path, selectedWorktree)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const stageAll = async (staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await api.gitUnstage(gitScope, undefined, selectedWorktree)
      else await api.gitStage(gitScope, undefined, selectedWorktree)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    const message = commitMsg.trim()
    if (message === '' || busy || drafting) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCommit(gitScope, message, selectedWorktree)
      setCommitMsg('')
      await refresh()
    } catch (reason) {
      setCommitError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  /** Draft a commit message for the STAGED changes through the LLM chosen in
   *  the Side card settings (git card gear). The draft fills the message box
   *  as editable text — it never commits. */
  const draftCommit = async (): Promise<void> => {
    if (busy || drafting) return
    const blob = prefs.pluginSettings['git']
    const provider = commitLlmProviderOf(blob)
    const model = commitLlmModelOf(blob)
    if (provider === '' || model === '') {
      setCommitError(`${t('commitDraftNoLlm')} — ${t('commitDraftNoLlmDesc')}`)
      return
    }
    setDrafting(true)
    setCommitError(null)
    try {
      const result = await api.gitCommitDraft(scope, {
        template: commitTemplateOf(blob),
        customTemplate: commitCustomTemplateOf(blob),
        provider,
        model,
        historyRefs: commitHistoryRefsOf(blob),
      })
      setCommitMsg(result.message)
    } catch (reason) {
      const code = reason instanceof SidebarApiError ? reason.code : undefined
      const message = code === 'no-staged-changes' ? t('commitDraftNoStaged')
        : code === 'llm-unavailable' ? `${t('commitDraftNoLlm')} — ${t('commitDraftNoLlmDesc')}`
        : code === 'llm-error' ? `${t('commitDraftFailed')}: ${reason instanceof Error ? reason.message : String(reason)}`
        : reason instanceof Error ? reason.message : String(reason)
      setCommitError(message)
    } finally {
      setDrafting(false)
    }
  }

  const checkout = async (branch: string): Promise<void> => {
    if (branch === status?.branch || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitCheckout(gitScope, branch, selectedWorktree)
      await refresh()
    } catch (reason) {
      setCommitError(`${t('checkoutError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Fetch remote refs (optionally pruning deleted ones), then recompute every
   *  derived surface: fetch moves only remote-tracking refs, so status rows,
   *  history decorations (`origin/main`) and the upstream pill all refresh
   *  together — the same atomic unit as any other mutation. */
  const fetchRemote = async (prune: boolean): Promise<void> => {
    if (busy || fetching) return
    setFetching(true)
    setBusy(true)
    setCommitError(null)
    try {
      await api.gitFetch(gitScope, selectedWorktree, prune)
      await refresh()
    } catch (reason) {
      const code = reason instanceof SidebarApiError ? reason.code : undefined
      // A repository without any remote gets its own copy instead of the
      // host's raw "no remote configured" line.
      setCommitError(code === 'git-no-remote'
        ? t('noRemote')
        : `${t('fetchError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setFetching(false)
      setBusy(false)
    }
  }

  /** Run one destructive operation after the confirm modal, then refresh. */
  const runConfirmed = (confirmState: ConfirmState): void => {
    setConfirm({ ...confirmState, onConfirm: async () => {
      setBusy(true)
      setCommitError(null)
      try {
        await confirmState.onConfirm()
        await refresh()
      } catch (reason) {
        setCommitError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    } })
  }

  /** Copy `text` to the clipboard (best-effort; no visual feedback needed — the menu closes). */
  const copy = (text: string): void => {
    void writeClipboard(text)
  }

  /** Toggle one branch in the watch list (optimistic; persisted through the
   *  git tab's pluginSettings blob when a store is present) and refresh the
   *  tips immediately so the markers move without waiting for the poll. */
  const toggleWatched = (name: string): void => {
    if (watched.includes(name)) {
      const next = watched.filter(item => item !== name)
      setWatched(next)
      if (store !== undefined) updatePluginSettings(store, 'git', blob => ({ ...blob, [WATCHED_BRANCHES_KEY]: next }))
      void api.gitBranchTips(gitScope, next, selectedWorktree).then(result => setTips(result.tips), () => {})
      return
    }
    if (watched.length >= WATCHED_BRANCHES_MAX) return
    const next = [...watched, name]
    setWatched(next)
    if (store !== undefined) updatePluginSettings(store, 'git', blob => ({ ...blob, [WATCHED_BRANCHES_KEY]: next }))
    void api.gitBranchTips(gitScope, next, selectedWorktree).then(result => setTips(result.tips), () => {})
  }

  /** Page the history down until a watched tip's commit row is loaded (the
   *  bottom bubble's reveal; capped so a very deep tip cannot page forever). */
  const revealTip = async (hash: string): Promise<void> => {
    if (revealing || logEnded) return
    setRevealing(true)
    const generation = refreshGeneration.current
    const target = selectedRef.current
    try {
      let skip = logEntries.length
      for (let i = 0; i < REVEAL_PAGE_CAP; i += 1) {
        const page = await historyPage(gitScope, LOG_BATCH, skip, target)
        if (generation !== refreshGeneration.current || target !== selectedRef.current) return
        if (page.length === 0) return
        skip += page.length
        setLogEntries(entries => [...entries, ...page])
        if (page.some(entry => entry.hashFull === hash) || page.length < LOG_BATCH) {
          if (page.length < LOG_BATCH) setLogEnded(true)
          return
        }
      }
    } catch (reason) {
      if (generation === refreshGeneration.current && target === selectedRef.current) {
        setCommitError(`${t('historyLoadError')}: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    } finally {
      if (generation === refreshGeneration.current && target === selectedRef.current) setRevealing(false)
    }
  }

  const openFileMenu = (event: MouseEvent, entry: GitStatusEntry, staged: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ entry, staged, x: event.clientX, y: event.clientY })
  }

  const openHistoryMenu = (event: MouseEvent, entry: GitGraphEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setHistoryMenu({ entry, x: event.clientX, y: event.clientY })
  }

  const stagedEntries = (status?.entries ?? []).filter(isStagedEntry)
  const unstagedEntries = (status?.entries ?? []).filter(isUnstagedEntry)

  /** The lane layout over the accumulated log pages (recomputed on append). */
  const graph = useMemo(() => computeGraphRows(logEntries), [logEntries])

  /* ── watched-branch markers ─────────────────────────────────────────────
   * A watched tip that is AHEAD of HEAD has no row in the graph (its
   * commits are not in HEAD's history): the TOP bubble shows the count. A
   * tip BEHIND HEAD lives inside the history — its row gets the dot ring;
   * while the row is outside the loaded page the BOTTOM bubble shows the
   * count (click to page down to it). */
  const visibleHashMap = useMemo(() => {
    const setOfHashes = new Set<string>()
    for (const entry of logEntries) setOfHashes.add(entry.hashFull)
    return setOfHashes
  }, [logEntries])
  const tipByHash = useMemo(() => new Map(tips.map(tip => [tip.hash, tip])), [tips])
  const topTips = useMemo(() => tips.filter(tip => tip.ahead > 0), [tips])
  const bottomTips = useMemo(
    () => tips.filter(tip => tip.ahead === 0 && tip.behind > 0 && !visibleHashMap.has(tip.hash)),
    [tips, visibleHashMap],
  )

  /** The current branch's upstream pill: the ref name (tinted, since it is a
   *  REMOTE ref) + a state suffix, plus the hover title. Absent upstream and
   *  pruned (gone) upstream get explicit copy; otherwise arrows for the
   *  ahead/behind counts (VS Code-style `↑1 ↓2`). */
  const upstreamPill = (() => {
    if (branchStatus === null) return null
    const { upstream, ahead, behind, gone } = branchStatus
    if (upstream === undefined) return { ref: undefined, suffix: t('noUpstream'), title: t('noUpstream') }
    if (gone) return { ref: upstream, suffix: ` · ${t('upstreamGone')}`, title: t('upstreamGone') }
    if (ahead === 0 && behind === 0) return { ref: upstream, suffix: '', title: t('branchStatusUpToDate') }
    const arrows = `${ahead > 0 ? ` ↑${ahead}` : ''}${behind > 0 ? ` ↓${behind}` : ''}`
    return {
      ref: upstream,
      suffix: arrows,
      title: t('branchStatusTooltip', { upstream, ahead, behind }),
    }
  })()

  const renderEntry = (entry: GitStatusEntry, staged: boolean): ReactNode => {
    return (
      <div key={`${staged ? 's' : 'u'}:${entry.path}`} className={css.gitRow}>
        <button
          type="button"
          className={css.gitRowMain}
          title={entry.path}
          onClick={() => { openWorktreeDiff(entry, staged) }}
          onContextMenu={(event) => { openFileMenu(event, entry, staged) }}
        >
          <span className={css.gitBadge}>{badgeOf(entry)}</span>
          <span className={css.gitName}>{entry.path}</span>
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={staged ? t('unstage') : t('stage')}
          title={staged ? t('unstage') : t('stage')}
          disabled={busy}
          onClick={() => { void stageEntry(entry, staged) }}
        >
          {staged ? <IconTrashOutline16 /> : <IconBranchOutline16 />}
        </button>
      </div>
    )
  }

  return (
    <div className={css.git}>
      {worktrees.length > 1 && (
        <div className={css.gitWorktreeRow}>
          <span className={css.gitWorktreeLabel}>{t('worktree')}</span>
          <select
            className={css.gitBranchSelect}
            value={selectedWorktree ?? ''}
            title={selectedWorktree}
            disabled={busy}
            onChange={(event) => { chooseWorktree(event.target.value) }}
          >
            {worktrees.map(entry => (
              <option key={entry.path} value={entry.path}>
                {entry.branch} · {baseName(entry.path)} ({entry.changes})
              </option>
            ))}
          </select>
        </div>
      )}
      <div className={css.gitHeader}>
        {(status?.repositories?.length ?? 0) > 1 && (
          <select
            className={css.gitBranchSelect}
            value={repoRoot ?? ''}
            title={repoRoot}
            onChange={(event) => { chooseRepo(event.target.value) }}
            disabled={busy}
          >
            {status!.repositories!.map(root => <option key={root} value={root}>{baseName(root)}</option>)}
          </select>
        )}
        <select
          className={css.gitBranchSelect}
          value={status?.branch ?? ''}
          onChange={(event) => { void checkout(event.target.value) }}
          disabled={busy || (status !== null && !status.isRepo)}
        >
          {(status?.branch ?? '') !== '' && <option value={status!.branch}>{status!.branch}</option>}
          {branchNames.filter(name => name !== status?.branch).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        {status?.isRepo === true && upstreamPill !== null && (
          <span className={css.gitUpstream} title={upstreamPill.title} aria-label={upstreamPill.title}>
            {upstreamPill.ref !== undefined && <span className={css.gitUpstreamRef}>{upstreamPill.ref}</span>}
            {upstreamPill.suffix}
          </span>
        )}
        {status?.isRepo === true && (
          <>
            <Tooltip label={fetching ? t('fetching') : t('fetch')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={css.iconButton}
                aria-label={fetching ? t('fetching') : t('fetch')}
                disabled={busy || fetching}
                onClick={() => { void fetchRemote(false) }}
              >
                {fetching ? <IconLoadingOutline16 size={14} /> : <IconDownloadOutline16 size={14} />}
              </button>
            </Tooltip>
            <Tooltip label={t('fetchPrune')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={`${css.iconButton}${watched.length > 0 ? ` ${css.gitWatchActive}` : ''}`}
                aria-label={t('fetchPrune')}
                disabled={busy || fetching}
                onClick={(event) => {
                  event.stopPropagation()
                  const rect = event.currentTarget.getBoundingClientRect()
                  setFetchMenu(fetchMenu === null ? { x: rect.right - 8, y: rect.bottom + 4 } : null)
                }}
              >
                <IconChevronDownOutline14 size={14} />
              </button>
            </Tooltip>
          </>
        )}
        <Tooltip label={t('refresh')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('refresh')}
            onClick={() => { void refresh() }}
          >
            <IconRefreshOutline16 size={14} />
          </button>
        </Tooltip>
      </div>

      {loading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && <div className={css.gitError}>{error}</div>}
      {!loading && status !== null && !status.isRepo && (
        <div className={css.gitPlaceholder}>{t('notRepo')}</div>
      )}

      {status !== null && status.isRepo && (
        <>
          {status.truncated === true && (
            <div className={css.gitEmpty}>{t('statusTruncated')}</div>
          )}
          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}>
              <span>{t('staged')} ({stagedEntries.length})</span>
              {stagedEntries.length > 0 && (
                <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(true) }}>
                  {t('unstageAll')}
                </button>
              )}
            </div>
            {stagedEntries.length === 0 && <div className={css.gitEmpty}>{t('noChanges')}</div>}
            {stagedEntries.map(entry => renderEntry(entry, true))}
          </div>
          <div className={`${css.gitSection}${unstagedEntries.length > 0 ? ` ${css.gitChangesScrolled}` : ''}`}>
            <div className={css.gitSectionHeader}>
              <span>{t('unstaged')} ({unstagedEntries.length})</span>
              {unstagedEntries.length > 0 && (
                <button type="button" className={css.gitLink} disabled={busy} onClick={() => { void stageAll(false) }}>
                  {t('stageAll')}
                </button>
              )}
            </div>
            {unstagedEntries.length === 0 && <div className={css.gitEmpty}>{t('noChanges')}</div>}
            {unstagedEntries.map(entry => renderEntry(entry, false))}
          </div>

          <div className={css.gitCommit}>
            <Input
              className={css.gitCommitInput}
              placeholder={t('commitPlaceholder')}
              value={commitMsg}
              disabled={busy || drafting}
              onChange={(event) => { setCommitMsg(event.target.value); setCommitError(null) }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void commit()
              }}
            />
            <Tooltip label={t('commitDraftTooltip')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={css.gitDraftButton}
                aria-label={t('commitDraft')}
                title={t('commitDraft')}
                disabled={busy || drafting || stagedEntries.length === 0}
                onClick={() => { void draftCommit() }}
              >
                <IconSparkle16 size={14} />
                <span>{drafting ? t('commitDraftBusy') : t('commitDraft')}</span>
              </button>
            </Tooltip>
            <button
              type="button"
              className={css.gitCommitButton}
              disabled={busy || drafting || commitMsg.trim() === '' || stagedEntries.length === 0}
              onClick={() => { void commit() }}
            >
              {t('commit')}
            </button>
          </div>
          {commitError !== null && <div className={css.gitError}>{commitError}</div>}

          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}><span>{t('history')}</span></div>
            {/* Watched branch ahead of HEAD: no row exists in this graph (its
                commits are not in HEAD's history) — the sticky top bubble
                pins below the header and shows the gap. */}
            {topTips.length > 0 && (
              <div className={`${css.gitLogWatchBubble} ${css.gitLogWatchTop}`}>
                {topTips.map(tip => (
                  <span key={tip.name} className={css.gitLogWatchRow}>
                    <VscStarFull size={12} />
                    <span className={css.gitLogWatchBranch}>{tip.name}</span>
                    <span className={css.gitLogWatchCount}>{t('watchedAhead', { count: tip.ahead })}</span>
                  </span>
                ))}
              </div>
            )}
            {graph.rows.map((row, index) => {
              const entry = row.entry
              // A watched tip pointing AT this commit gets the dot ring.
              const isWatchedTip = tipByHash.has(entry.hashFull)
              return (
                <div
                  key={row.rowKey}
                  role="button"
                  tabIndex={0}
                  className={[
                    css.gitLogRow,
                    row.kind === 'local' ? css.gitLogRowLocal
                      : row.kind === 'remote' ? css.gitLogRowRemote
                      : '',
                  ].join(' ').trim()}
                  title={`${entry.author} · ${entry.date}\n${entry.hashFull}`}
                  onClick={() => { openCommitDiff(entry) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openCommitDiff(entry)
                    }
                  }}
                  onContextMenu={(event) => { openHistoryMenu(event, entry) }}
                >
                  <GitGraphSvg
                    row={row}
                    prev={index > 0 ? graph.rows[index - 1] : undefined}
                    graphWidth={graph.graphWidth}
                    watched={isWatchedTip}
                  />
                  <div className={css.gitLogBody} style={{ marginLeft: graph.graphWidth + 8 }}>
                    <span className={css.gitLogLine1}>
                      <span className={css.gitLogHash}>{entry.hash}</span>
                      {isWatchedTip && <VscStarFull size={12} className={css.gitLogWatchRowMark} />}
                      <span className={css.gitLogSubject}>{entry.subject}</span>
                    </span>
                    <span className={css.gitLogLine2}>
                      {refChips(entry.refs).map(chip => (
                        <span
                          key={`${chip.kind}:${chip.name}`}
                          className={[
                            css.gitLogRef,
                            chip.kind === 'branch' ? css.gitLogRefLocal
                              : chip.kind === 'remote' ? css.gitLogRefRemote
                              : '',
                          ].join(' ').trim()}
                        >
                          {chip.name}
                        </span>
                      ))}
                      <span className={css.gitLogMeta}>{entry.author} · {relativeTime(entry.date)}</span>
                    </span>
                  </div>
                </div>
              )
            })}
            {!logEnded && (
              <button
                type="button"
                className={css.gitLogMore}
                disabled={logLoadingMore || busy || revealing}
                onClick={() => { void loadMoreLog() }}
              >
                {logLoadingMore ? t('loading') : t('loadMore')}
              </button>
            )}
            {/* Watched branch behind HEAD whose tip row is below the loaded
                page — the sticky bottom bubble shows the gap; clicking pages
                down to the tip (single tip) or is inert (multiple tips). */}
            {bottomTips.length > 0 && (
              <div
                className={`${css.gitLogWatchBubble} ${css.gitLogWatchBottom}${bottomTips.length === 1 ? ` ${css.gitLogWatchClickable}` : ''}`}
                title={bottomTips.length === 1 ? t('watchedBehind', { count: bottomTips[0]!.behind }) : undefined}
                onClick={() => {
                  if (bottomTips.length === 1 && !revealing) void revealTip(bottomTips[0]!.hash)
                }}
              >
                {bottomTips.map(tip => (
                  <span key={tip.name} className={css.gitLogWatchRow}>
                    {revealing ? <IconLoadingOutline16 size={12} /> : <VscStarFull size={12} />}
                    <span className={css.gitLogWatchBranch}>{tip.name}</span>
                    <span className={css.gitLogWatchCount}>{t('watchedBehind', { count: tip.behind })}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/*
            The one shared file-row context menu, positioned at the right-click
            cursor (portal so the panel's overflow clip cannot crop it).
          */}
          <Menu
            open={fileMenu !== null}
            onClose={() => { setFileMenu(null) }}
            items={[
              // A linked worktree outside the session workspace cannot be
              // opened in the editor: the host's workspace fence rejects
              // every path under it. Hide the action for that checkout so
              // the menu does not offer a no-op that confuses the user.
              ...(fileMenu !== null && isWithinWorkspace(scope.cwd ?? '', resolveSidebarPath(repoRoot ?? selectedWorktree ?? scope.cwd, fileMenu.entry.path))
                ? [{ id: 'open', label: t('openEditor'), icon: <IconCodeOutline16 size={14} /> }]
                : []),
              fileMenu?.staged === true
                ? { id: 'stage', label: t('unstage'), icon: <IconTrashOutline16 size={14} /> }
                : { id: 'stage', label: t('stage'), icon: <IconBranchOutline16 size={14} /> },
              ...(fileMenu !== null && !isUntracked(fileMenu.entry)
                ? [{ id: 'discard', label: t('discard'), icon: <IconTrashOutline16 size={14} />, danger: true }]
                : []),
              { type: 'separator', id: 'sep1' },
              { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
            ]}
            onSelect={(id) => {
              const target = fileMenu
              if (target === null) return
              setFileMenu(null)
              if (id === 'open') {
                const resolved = resolveSidebarPath(repoRoot ?? selectedWorktree ?? scope.cwd, target.entry.path)
                // Defense-in-depth: the menu hides this action when the
                // resolved path escapes the session workspace, but a
                // racing repo switch could still reach here with a path
                // the host would reject. No-op in that case.
                if (!isWithinWorkspace(scope.cwd ?? '', resolved)) return
                onOpenFile(resolved)
                return
              }
              if (id === 'stage') {
                void stageEntry(target.entry, target.staged)
                return
              }
              if (id === 'discard') {
                runConfirmed({
                  title: t('discardTitle'),
                  description: t('discardDesc', { path: target.entry.path }),
                  confirmLabel: t('discard'),
                  onConfirm: () => api.gitDiscard(gitScope, target.entry.path, selectedWorktree),
                })
                return
              }
              if (id === 'relative') {
                copy(relativeTo(repoRoot ?? selectedWorktree ?? scope.cwd ?? '', target.entry.path))
                return
              }
              if (id === 'absolute') copy(resolveSidebarPath(repoRoot ?? selectedWorktree ?? scope.cwd, target.entry.path))
            }}
            portal
            align="start"
            getAnchorRect={() => (fileMenu === null ? null : new DOMRect(fileMenu.x, fileMenu.y, 0, 0))}
            anchor={<span />}
          />

          {/* The shared history-row context menu. */}
          <Menu
            open={historyMenu !== null}
            onClose={() => { setHistoryMenu(null) }}
            items={[
              { id: 'view', label: t('viewCommitDiff') },
              { id: 'copyShort', label: t('copyShortHash'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'copyFull', label: t('copyFullHash'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'copySubject', label: t('copySubject'), icon: <IconCopyOutline16 size={14} /> },
              { type: 'separator', id: 'sep2' },
              { id: 'revert', label: t('revertCommit'), danger: true },
              { id: 'cherryPick', label: t('cherryPickCommit'), danger: true },
            ]}
            onSelect={(id) => {
              const target = historyMenu
              if (target === null) return
              setHistoryMenu(null)
              if (id === 'view') {
                openCommitDiff(target.entry)
                return
              }
              if (id === 'copyShort') {
                copy(target.entry.hash)
                return
              }
              if (id === 'copyFull') {
                copy(target.entry.hashFull)
                return
              }
              if (id === 'copySubject') {
                copy(target.entry.subject)
                return
              }
              if (id === 'revert') {
                runConfirmed({
                  title: t('revertTitle'),
                  description: t('revertDesc', { subject: target.entry.subject }),
                  confirmLabel: t('revertCommit'),
                  onConfirm: () => api.gitRevert(gitScope, target.entry.hashFull, selectedWorktree),
                })
                return
              }
              if (id === 'cherryPick') {
                runConfirmed({
                  title: t('cherryPickTitle'),
                  description: t('cherryPickDesc', { subject: target.entry.subject }),
                  confirmLabel: t('cherryPickCommit'),
                  onConfirm: () => api.gitCherryPick(gitScope, target.entry.hashFull, selectedWorktree),
                })
              }
            }}
            portal
            align="start"
            getAnchorRect={() => (historyMenu === null ? null : new DOMRect(historyMenu.x, historyMenu.y, 0, 0))}
            anchor={<span />}
          />

          {/* The more menu (chevron): the plain-fetch button is the common path;
            this menu carries the prune variant (drops locally tracked refs whose
            remote branch disappeared — the one way `gone` ever appears) and the
            watched-branch (重点关注) picker: every local branch except the current
            one is a row; clicking a row toggles the watch flag WITHOUT closing
            the menu (multi-select; the chevron lights up while anything is
            watched). */}
          <Menu
            open={fetchMenu !== null}
            onClose={() => { setFetchMenu(null) }}
            selectedIds={watched.map(name => `watch:${name}`)}
            items={[
              { id: 'prune', label: t('fetchPrune'), icon: <IconDownloadOutline16 size={14} /> },
              { type: 'separator', id: 'watch-sep' },
              { type: 'label', id: 'watch-label', text: t('watchBranches') },
              ...(status === null ? [] : branchNames
                .filter(name => name !== status.branch)
                .map(name => ({
                  id: `watch:${name}`,
                  label: name,
                  icon: watched.includes(name)
                    ? <VscStarFull size={14} />
                    : <IconBranchOutline16 size={14} />,
                }))),
              ...(watched.length > 0
                ? [
                  { type: 'separator', id: 'watch-clear-sep' } as const,
                  { id: 'watch-clear', label: t('watchClear'), danger: true },
                ]
                : []),
            ]}
            onSelect={(id) => {
              if (id === 'prune') {
                setFetchMenu(null)
                void fetchRemote(true)
                return
              }
              if (id === 'watch-clear') {
                setWatched([])
                if (store !== undefined) updatePluginSettings(store, 'git', blob => ({ ...blob, [WATCHED_BRANCHES_KEY]: [] }))
                setTips([])
                return
              }
              if (id.startsWith('watch:')) {
                // Multi-select: keep the menu open after each toggle.
                toggleWatched(id.slice('watch:'.length))
              }
            }}
            portal
            align="start"
            getAnchorRect={() => (fetchMenu === null ? null : new DOMRect(fetchMenu.x, fetchMenu.y, 0, 0))}
            anchor={<span />}
          />

          {/* Destructive actions land here first: Cancel / Confirm. */}
          <Modal
            open={confirm !== null}
            onClose={() => { setConfirm(null) }}
            title={confirm?.title ?? ''}
            closeLabel={t('cancel')}
            footer={(
              <>
                <Button variant="outline" onClick={() => { setConfirm(null) }}>{t('cancel')}</Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    const pending = confirm
                    if (pending === null) return
                    setConfirm(null)
                    void pending.onConfirm()
                  }}
                >
                  {confirm?.confirmLabel ?? ''}
                </Button>
              </>
            )}
          >
            <p className={css.gitConfirmDesc}>{confirm?.description}</p>
          </Modal>
        </>
      )}
    </div>
  )
}
