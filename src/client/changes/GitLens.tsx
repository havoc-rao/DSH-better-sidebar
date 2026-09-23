/**
 * The Git lens of the changes tab: repository truth — status list (staged vs
 * unstaged), stage/unstage, commit with a message box, branch switch, and a
 * VSCode-like history with branch decorations, author and relative time.
 * Clicking a changed file or a history row previews it in the tab's shared
 * bottom pane (see {@link DiffPane}); rows carry right-click context menus
 * with advanced operations (open in editor, discard, revert, cherry-pick,
 * copy paths/hashes). Refresh is manual + on mount/focus. While visible it
 * polls lightweight porcelain state so model-authored file changes appear
 * without a manual refresh. Everything here is the former standalone git
 * panel, re-homed as a lens.
 */
import { Component, createElement, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Button, IconCodeOutline16, IconCopyOutline16, IconPlusOutline16,
  IconRefreshOutline16, IconTrashOutline16, Input, Menu, Modal, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import type { GitLogEntry, GitStatusEntry, GitStatusResult, GitWorktree, SessionScope } from '../api.ts'
import { api } from '../api.ts'
import type { BetterSidebarService, GitCommitActionProps, GitCommitTarget } from '../service.ts'
import { useGitSource } from '../git-source.ts'
import { RenderBoundary } from '../RenderBoundary.tsx'
import type { GraphTreeProps, GraphTreeRow } from 'dsh-git-graph/client-contract'
import { useGitGraph } from '../git-lens-graph.ts'
import { usePolling } from '../use-polling.ts'
import { baseName, isWithinWorkspace, relativeTo } from '../paths.ts'
import { resolveSidebarPath } from '../produced-files.ts'
import { relativeTime, t } from '../locales.ts'
import type { GitDiffRef, SidebarStore } from '../state.ts'
import css from './changes.module.css'

/** A GraphTree render crash must restore the original history list, not an
 *  error-only view (same degraded-fallback discipline as the fileTreeUi
 *  seat). The failure is sticky for the current checkout episode: the next
 *  checkout / service change re-arms the graph. */
class GraphBoundary extends Component<{ onFail(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) {
    console.error('[dsh-better-sidebar] gitGraph framework crashed; falling back to the history list:', error)
    this.props.onFail()
  }
  render() { return this.state.failed ? null : this.props.children }
}

/** Monotonic Git-lens instance id: keys the live-target registry so two
 *  mounted lenses cannot clear each other's target. */
let nextGitLensOwner = 0

/** The XY status letters a row badge shows (X = index, Y = worktree). */
function badgeOf(entry: GitStatusEntry): string {
  const index = entry.xy[0]
  if (index !== undefined && index !== ' ' && index !== '?') return index
  const worktree = entry.xy[1]
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

/** How one log row's ref pill is tinted (see `.gitLogRef[data-kind=…]`). */
type GitRefKind = 'head' | 'branch' | 'remote' | 'tag'

/** One log row's ref decoration: the display name plus its kind. */
interface GitRefDecoration {
  name: string
  kind: GitRefKind
}

/** The ref decorations of one log row (`%D` with `--decorate=short`), deduped
 *  and classified so every pill can carry its own color:
 *  `HEAD -> main` → the checked-out branch (`head`), plain local branch names
 *  → `branch`, `<remote>/<branch>` forms → `remote`, `tag: v1.0` → `tag`.
 *  `localBranches` (the checkout's `refs/heads` short names) disambiguates a
 *  local branch that itself contains a `/` from a remote-tracking ref. */
function refDecorations(refs: string, localBranches: ReadonlySet<string>): GitRefDecoration[] {
  const out: GitRefDecoration[] = []
  const seen = new Set<string>()
  for (const raw of refs.split(',')) {
    const ref = raw.trim()
    if (ref === '') continue
    const head = ref.includes(' -> ')
    const name = head
      ? ref.slice(ref.indexOf(' -> ') + 4)
      : ref.startsWith('tag: ')
        ? ref.slice(5)
        : ref
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    let kind: GitRefKind
    if (head || name === 'HEAD') kind = 'head'
    else if (localBranches.has(name)) kind = 'branch'
    else if (name.includes('/')) kind = 'remote'
    else kind = 'tag'
    out.push({ name, kind })
  }
  return out
}

/** One thrown value as display text (every error banner/row here normalizes
 *  through this so non-Error rejections never render as '[object Object]'). */
function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
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

/** Fixed row height for the gitGraph framework path: the built-in history
 *  rows carry TWO lines (hash + subject over ref pills + author·time) at the
 *  design-token line heights, so a compact single-line 32px row would clip
 *  them. 44px fits the same two-line content at its natural rhythm (the
 *  framework centers the block while drawing lanes/edges per row). */
const GRAPH_ROW_HEIGHT = 44

/** Every Nth silent poll re-lists worktrees (and re-runs auto-selection): the
 *  2s tick only needs the selected checkout's STATUS, and re-listing spawned
 *  a second git process per tick for a list that almost never changes — a
 *  linked checkout the agent creates mid-session is picked up within ~30s
 *  instead of 2s. */
const WORKTREE_RECHECK_TICKS = 15

export interface GitLensProps {
  /** The client context: resolves the git data source (feature `gitSource`).
   *  Absent (standalone/test compositions) → local host routes, byte for
   *  byte. */
  ctx?: Context
  scope: SessionScope
  /** The sidebar store: reads the `workspaceFence` pref (see the open guard below). */
  store: SidebarStore
  /** The commit-message draft (owned by {@link ChangesTab} so a lens switch —
   *  which unmounts this lens — cannot evaporate what the user was typing). */
  commitMsg: string
  /** The single typing path: local state update + the debounced layout write. */
  onCommitMsgChange: (next: string) => void
  /** A successful commit cleared the draft — immediately, not via the
   *  debounce: a committed message must not resurrect when the lens reopens. */
  onCommitMsgCommitted: () => void
  onOpenFile: (path: string) => void
  /** Preview one change in the shared bottom pane (worktree or commit ref). */
  onPreview: (ref: GitDiffRef) => void
  /** The ref currently previewed (row highlight); null when the pane is closed. */
  selectedRef: GitDiffRef | null
  /** Poll only while the tab is actually visible. */
  visible: boolean
  /**
   * The better-sidebar service (feature `gitCommitActions`): renders the
   * registered commit-row actions and receives this lens' live Git target
   * through `setGitCommitTarget`. Absent (standalone/test compositions) the
   * row behaves exactly as before.
   */
  service?: BetterSidebarService
}

export function GitLens(props: GitLensProps) {
  const { ctx, scope, store, commitMsg, onCommitMsgChange, onCommitMsgCommitted, onOpenFile, onPreview, selectedRef, visible, service } = props
  /** This instance's own key in the live-target registry (stable across renders). */
  const [ownerId] = useState(() => {
    nextGitLensOwner += 1
    return `git-lens:${nextGitLensOwner}`
  })
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [selectedWorktree, setSelectedWorktree] = useState<string | undefined>()
  const [repoRoot, setRepoRoot] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [branchNames, setBranchNames] = useState<string[]>([])
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  /** The commit-message draft, lifted to {@link ChangesTab}: the lens switch
   *  unmounts this lens, and a lens-local state would lose what the user was
   *  typing. */
  const [busy, setBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  /** Whether the history was fully paged (a batch shorter than LOG_BATCH). */
  const [logEnded, setLogEnded] = useState(false)
  const [logLoadingMore, setLogLoadingMore] = useState(false)
  /** The fixed-roots pagination cursor of the CURRENT log snapshot (see
   *  api.gitLog / GitLogPage): undefined = not anchored yet, so the next
   *  page request re-pins the server's own tips. */
  const [logCursor, setLogCursor] = useState<string | undefined>(undefined)
  /** Sticky GraphTree degradation for the current checkout episode: a render
   *  crash falls back to the built-in list until the checkout or the gitGraph
   *  service itself changes. */
  const [graphFailed, setGraphFailed] = useState(false)

  /** The checkout's local branch names as a lookup set: classifies log-row ref
   *  pills (a local branch may contain `/`, so remote detection must compare
   *  against this rather than the name shape alone). */
  const localBranches = useMemo(() => new Set(branchNames), [branchNames])

  /** The open file-row context menu (cursor position for the portaled Menu). */
  const [fileMenu, setFileMenu] = useState<{ entry: GitStatusEntry; staged: boolean; x: number; y: number } | null>(null)
  /** The open history-row context menu. */
  const [historyMenu, setHistoryMenu] = useState<{ entry: GitLogEntry; x: number; y: number } | null>(null)
  /** The pending destructive action awaiting confirmation. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const refreshInFlight = useRef(false)
  /** Monotonic request id: a manual worktree switch invalidates any older poll
   *  before it can publish state from the previous checkout. */
  const refreshGeneration = useRef(0)
  const worktreeChosenByUser = useRef(false)
  /** selectedWorktree read inside refresh without re-creating the callback:
   *  avoids a spurious full refresh on every auto-select (the very state
   *  change refresh writes back via setSelectedWorktree would recreate the
   *  callback and re-trigger the mount effect — an N→N+1 fetch loop). */
  const chosenPathRef = useRef<string | undefined>(undefined)
  useEffect(() => { chosenPathRef.current = selectedWorktree }, [selectedWorktree])
  /** Silent polls since the last worktree re-list (see WORKTREE_RECHECK_TICKS). */
  const silentTickCount = useRef(0)

  const gitScope: SessionScope = repoRoot === undefined ? scope : { ...scope, repoRoot }

  /** The resolved git data source for this scope (feature 'gitSource'):
   *  a matching provider's GitDataSource shadows the host `api.git*`
   *  routes; no match → `api` itself (byte for byte). */
  const gitSource = useGitSource(ctx, gitScope)
  const gitApi = gitSource ?? api

  /** Publish a complete checkout-derived view. Status, branch choices and
   *  history are one consistency unit: never mix rows from two worktrees. */
  const refreshTarget = useCallback(async (
    target: string | undefined,
    options: { loading: boolean; generation: number },
  ): Promise<void> => {
    if (options.loading) setLoading(true)
    setError(null)
    try {
      const [statusResult, branchResult, logResult] = await Promise.all([
        gitApi.gitStatus(gitScope, target),
        gitApi.gitBranch(gitScope, target).catch(() => ({ current: '', names: [] as string[] })),
        // Anchored page (roots: [] = pin the server's own HEAD tip): the
        // rows then carry real parents and every later page rides the
        // response cursor, so the gitGraph framework's lane layout never
        // shifts mid-pagination. Older hosts / plain arrays fall back to
        // legacy skip/count paging transparently.
        gitApi.gitLog(gitScope, LOG_BATCH, 0, target, { roots: [] }).catch(() => [] as GitLogEntry[]),
      ])
      if (options.generation !== refreshGeneration.current) return
      setStatus(statusResult)
      if (statusResult.root !== undefined && statusResult.root !== repoRoot) setRepoRoot(statusResult.root)
      setBranchNames(branchResult.names)
      if (Array.isArray(logResult)) {
        setLogEntries(logResult)
        setLogEnded(logResult.length < LOG_BATCH)
        setLogCursor(undefined)
      } else {
        setLogEntries(logResult.entries)
        setLogEnded(!logResult.hasMore)
        setLogCursor(logResult.cursor)
      }
    } catch (reason) {
      if (options.generation === refreshGeneration.current) {
        setError(errorMessage(reason))
      }
    } finally {
      if (options.loading && options.generation === refreshGeneration.current) setLoading(false)
    }
    // Granular scope fields: the scope object's identity churns, only its
    // sessionId / cwd fields gate the git target. `gitSource` joins the deps
    // so a provider registering/unregistering (feature 'gitSource') lands in
    // the refresh path — the registry subscription re-renders, and a fresh
    // source must be able to re-own the next refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.sessionId, scope.cwd, repoRoot, gitSource])

  const refresh = useCallback(async (silent = false): Promise<void> => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    let generation = refreshGeneration.current
    try {
      // Fast path for the ordinary silent tick: the selected checkout's
      // STATUS is all that changes between worktree re-lists (see
      // WORKTREE_RECHECK_TICKS) — one git process instead of two.
      if (silent && chosenPathRef.current !== undefined && (silentTickCount.current += 1) % WORKTREE_RECHECK_TICKS !== 0) {
        const statusResult = await gitApi.gitStatus(gitScope, chosenPathRef.current)
        if (generation === refreshGeneration.current) setStatus(statusResult)
        return
      }
      silentTickCount.current = 0
      const listed = await gitApi.gitWorktrees(scope)
      if (generation !== refreshGeneration.current) return
      setWorktrees(listed)
      const selectedStillExists = listed.some(entry => entry.path === chosenPathRef.current)
      let target = selectedStillExists ? chosenPathRef.current : listed.find(entry => entry.current)?.path
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
      const targetChanged = target !== chosenPathRef.current
      if (targetChanged) {
        // Changing the automatically selected checkout invalidates any direct
        // target refresh that may still be resolving for the previous one.
        generation = refreshGeneration.current += 1
        chosenPathRef.current = target
        setSelectedWorktree(target)
        // Remove rows owned by the previous checkout immediately: keeping them
        // interactive while the target changes could apply a destructive action
        // to the new checkout with stale history from the old one.
        setStatus(null)
        setBranchNames([])
        setLogEntries([])
        setLogEnded(false)
        setLogLoadingMore(false)
        setLogCursor(undefined)
      }
      // A poll may update status alone only while staying on the same checkout.
      // Any automatic selection change refreshes the complete derived view.
      if (silent && !targetChanged) {
        const statusResult = await gitApi.gitStatus(gitScope, target)
        if (generation === refreshGeneration.current) setStatus(statusResult)
        return
      }
      await refreshTarget(target, { loading: !silent, generation })
    } catch (reason) {
      if (generation === refreshGeneration.current) {
        setError(errorMessage(reason))
        if (!silent) setLoading(false)
      }
    } finally {
      refreshInFlight.current = false
    }
    // Granular scope fields: the scope object's identity churns, only its
    // sessionId / cwd fields gate the refresh target. `gitSource` joins the
    // deps so a provider registration change re-runs the mount refresh
    // through the new source (see refreshTarget).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.sessionId, scope.cwd, refreshTarget, gitSource])

  useEffect(() => {
    refreshGeneration.current += 1
    refreshInFlight.current = false
    worktreeChosenByUser.current = false
    chosenPathRef.current = undefined
    silentTickCount.current = 0
    setSelectedWorktree(undefined)
  }, [scope.sessionId, scope.cwd])
  useEffect(() => { void refresh() }, [refresh])

  /** A user choice invalidates any older poll and atomically refreshes every
   *  checkout-derived surface before destructive history actions can run. */
  const chooseWorktree = (target: string): void => {
    worktreeChosenByUser.current = true
    chosenPathRef.current = target
    setSelectedWorktree(target)
    setStatus(null)
    setBranchNames([])
    setLogEntries([])
    setLogEnded(false)
    setLogLoadingMore(false)
    setLogCursor(undefined)
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
    setLogEnded(false)
    setLogLoadingMore(false)
    setLogCursor(undefined)
    // Re-list worktrees for the selected child (a workspace container's
    // own worktree list is empty); keep the current linked-checkout choice
    // unless it does not belong to the new repository.
    const generation = refreshGeneration.current += 1
    void refreshTarget(chosenPathRef.current ?? '', { loading: true, generation })
  }
  /** The silent poll tick (the status-only fast path between worktree
   *  re-lists, see refresh) — fixed 2s cadence while visible, no initial
   *  burst (mount and scope changes already refresh above). */
  const pollTick = useCallback((): Promise<void> => refresh(true), [refresh])
  usePolling(visible, pollTick, { intervalMs: 2_000 })

  /** Append the next history page (lazy: only when the user asks for more).
   *  Pages ride the fixed-roots cursor when a snapshot is anchored; a lost
   *  cursor (old host / expiry) re-anchors on the server's own tips. */
  const loadMoreLog = async (): Promise<void> => {
    if (logLoadingMore || logEnded) return
    const generation = refreshGeneration.current
    const target = chosenPathRef.current
    setLogLoadingMore(true)
    try {
      const next = await gitApi.gitLog(
        gitScope,
        LOG_BATCH,
        0,
        target,
        logCursor === undefined ? { roots: [] } : { cursor: logCursor },
      )
      // A worktree switch clears the old history and increments generation.
      // Never append a late page from that checkout into the new one.
      if (generation !== refreshGeneration.current || target !== chosenPathRef.current) return
      setLogEntries(entries => [...entries, ...(Array.isArray(next) ? next : next.entries)])
      if (Array.isArray(next)) {
        if (next.length < LOG_BATCH) setLogEnded(true)
      } else {
        setLogCursor(next.cursor)
        if (!next.hasMore) setLogEnded(true)
      }
    } catch (reason) {
      if (generation === refreshGeneration.current && target === chosenPathRef.current) {
        setCommitError(`${t('historyLoadError')}: ${errorMessage(reason)}`)
      }
    } finally {
      if (generation === refreshGeneration.current && target === chosenPathRef.current) setLogLoadingMore(false)
    }
  }

  /** The preview ref for one changed file (one ref per path+side). */
  const worktreeRefOf = (entry: GitStatusEntry, staged: boolean): GitDiffRef => ({
    kind: 'worktree',
    path: entry.path,
    staged,
    untracked: isUntracked(entry),
    worktree: selectedWorktree,
    repoRoot,
  })

  /** The preview ref for one commit. */
  const commitRefOf = (entry: GitLogEntry): GitDiffRef => ({
    kind: 'commit',
    hash: entry.hash,
    hashFull: entry.hashFull,
    subject: entry.subject,
    worktree: selectedWorktree,
    repoRoot,
  })

  /** Whether a worktree row is the one currently previewed. */
  const isPreviewedWorktree = (entry: GitStatusEntry, staged: boolean): boolean => {
    if (selectedRef === null || selectedRef.kind !== 'worktree') return false
    return selectedRef.path === entry.path && selectedRef.staged === staged
      && (selectedRef.worktree ?? '') === (selectedWorktree ?? '')
  }

  const stageEntry = async (entry: GitStatusEntry, staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await gitApi.gitUnstage(gitScope, entry.path, selectedWorktree)
      else await gitApi.gitStage(gitScope, entry.path, selectedWorktree)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const stageAll = async (staged: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (staged) await gitApi.gitUnstage(gitScope, undefined, selectedWorktree)
      else await gitApi.gitStage(gitScope, undefined, selectedWorktree)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    const message = commitMsg.trim()
    if (message === '' || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await gitApi.gitCommit(gitScope, message, selectedWorktree)
      // Clear the draft immediately — not via the debounce: a committed
      // message must not resurrect when the lens reopens.
      onCommitMsgCommitted()
      await refresh()
    } catch (reason) {
      setCommitError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const checkout = async (branch: string): Promise<void> => {
    if (branch === status?.branch || busy) return
    setBusy(true)
    setCommitError(null)
    try {
      await gitApi.gitCheckout(gitScope, branch, selectedWorktree)
      await refresh()
    } catch (reason) {
      setCommitError(`${t('checkoutError')}: ${errorMessage(reason)}`)
    } finally {
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
        setCommitError(errorMessage(reason))
      } finally {
        setBusy(false)
      }
    } })
  }

  /** Copy `text` to the clipboard (best-effort; no visual feedback needed — the menu closes). */
  const copy = (text: string): void => {
    void writeClipboard(text)
  }

  const openFileMenu = (event: MouseEvent, entry: GitStatusEntry, staged: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ entry, staged, x: event.clientX, y: event.clientY })
  }

  /** The open history-row context menu, opened from BOTH the built-in list
   *  rows (a DOM mouse event) and the gitGraph rows (the framework's pointer
   *  event wrapper) — both structurally satisfy this minimal face. */
  const openHistoryMenu = (event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation?(): void }, entry: GitLogEntry): void => {
    event.preventDefault()
    event.stopPropagation?.()
    setHistoryMenu({ entry, x: event.clientX, y: event.clientY })
  }

  const stagedEntries = (status?.entries ?? []).filter(isStagedEntry)
  const unstagedEntries = (status?.entries ?? []).filter(isUnstagedEntry)

  /** The live target this lens publishes to the service — exactly what a
   *  registered commit-row action receives (feature `gitCommitActions`). */
  const commitTarget = useMemo<GitCommitTarget | null>(() => {
    if (status === null || !status.isRepo) return null
    return {
      scope,
      ...(repoRoot === undefined ? {} : { repoRoot }),
      ...(selectedWorktree === undefined ? {} : { worktree: selectedWorktree }),
      ...(status.branch === undefined ? {} : { branch: status.branch }),
      status,
      staged: stagedEntries,
    }
    // Granular scope fields: the scope object's identity churns, only its
    // sessionId / cwd fields gate the published target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, repoRoot, selectedWorktree, scope.sessionId, scope.cwd])

  // Publish the live target so external plugins can answer "which checkout is
  // the user looking at". setGitCommitTarget is deliberately silent (it does
  // NOT notify subscribers), so this cannot loop through the registry
  // subscription below — the lens is itself a subscriber.
  useEffect(() => {
    if (service === undefined) return
    service.setGitCommitTarget(ownerId, commitTarget)
  }, [service, ownerId, commitTarget])

  // Drop this instance's target on unmount (lens switch / tab close / session
  // switch) so a stale worktree is never published to consumers.
  useEffect(() => {
    if (service === undefined) return
    return () => { service.setGitCommitTarget(ownerId, null) }
  }, [service, ownerId])

  // A registry change (an action registered late, or disposed) re-renders the
  // row so the seam works without remounting the lens.
  const [registryVersion, setRegistryVersion] = useState(0)
  useEffect(
    () => service?.subscribe(() => { setRegistryVersion(version => version + 1) }),
    [service],
  )

  /** The registered commit-row actions, ranked (`order`, then registration)
   *  and gated by `available`. Empty without a service or an open repository. */
  const commitActionViews = useMemo(() => {
    // registryVersion is the re-read trigger on register/dispose (the value
    // itself is not otherwise needed).
    void registryVersion
    if (service === undefined || commitTarget === null) return []
    const actionProps: GitCommitActionProps = { ...commitTarget, service, refresh }
    return service.getGitCommitActions()
      .map((descriptor, index) => ({ descriptor, index }))
      .sort((a, b) => (a.descriptor.order ?? 100) - (b.descriptor.order ?? 100) || a.index - b.index)
      .filter(({ descriptor }) => {
        if (descriptor.available === undefined) return true
        try {
          return descriptor.available(commitTarget) !== false
        } catch (error) {
          console.error(`[dsh-better-sidebar] git commit action "${descriptor.id}" available() error:`, error)
          return false
        }
      })
      .map(({ descriptor }) => ({ descriptor, props: actionProps }))
    // registryVersion forces a re-read on register/dispose.
  }, [service, commitTarget, registryVersion, refresh])

  /** ══ gitGraph v1 soft join (provider: dsh-git-graph) ══
   *  The history section renders through the provider's generic GraphTree
   *  framework when the service is present and protocol-compatible: rows are
   *  this lens' own log entries (id = full hash + real parents), each row's
   *  whole content stays the built-in two-line commit row, and every
   *  interaction (preview / context menu / paging) stays here — the framework
   *  only draws lanes, virtualizes and routes keyboard/pointer events. */
  const gitGraph = useGitGraph()
  /** The exact checkout shown (worktree > status root > discovered root). */
  const historyRoot = selectedWorktree ?? status?.root ?? repoRoot
  /** Rows for the framework: the stable full hash + real parents only. */
  const graphRows = useMemo<GraphTreeRow[]>(
    () => logEntries.map(entry => ({ id: entry.hashFull, parents: entry.parents })),
    [logEntries],
  )
  /** row id (full hash) → entry, for event routing and row content. */
  const logEntryById = useMemo(() => {
    const map = new Map<string, GitLogEntry>()
    for (const entry of logEntries) map.set(entry.hashFull, entry)
    return map
  }, [logEntries])
  const previewLogRow = (id: string): void => {
    const entry = logEntryById.get(id)
    if (entry !== undefined) onPreview(commitRefOf(entry))
  }
  /** A framework crash is sticky for the episode: re-arm on checkout change
   *  (or service change) so a consistent thrower cannot loop every render. */
  useEffect(() => { setGraphFailed(false) }, [gitGraph, scope.sessionId, scope.cwd, historyRoot])
  const graphReady = gitGraph !== undefined && historyRoot !== undefined && !graphFailed
  /** The shared two-line commit row content — the exact same markup the
   *  built-in list rows render (hash + subject / ref pills + author·time). */
  const renderLogRowContent = (entry: GitLogEntry | undefined): ReactNode => {
    if (entry === undefined) return null
    return (
      <>
        <span className={css.gitLogLine1}>
          <span className={css.gitLogHash}>{entry.hash}</span>
          <span className={css.gitLogSubject}>{entry.subject}</span>
        </span>
        <span className={css.gitLogLine2}>
          {refDecorations(entry.refs, localBranches).map(({ name, kind }) => (
            <span key={name} className={css.gitLogRef} data-kind={kind}>{name}</span>
          ))}
          <span className={css.gitLogMeta}>{entry.author} · {relativeTime(entry.date)}</span>
        </span>
      </>
    )
  }
  const graphRowAttributes = (row: GraphTreeRow): Record<string, string> => {
    const entry = logEntryById.get(row.id)
    return entry === undefined ? {} : { title: `${entry.author} · ${entry.date}\n${entry.hashFull}` }
  }
  /** The GraphTree element when the framework path is live (created as an
   *  ELEMENT inside GraphBoundary so a throwing framework render is caught
   *  and the section falls back to the built-in list). */
  const graphProps: GraphTreeProps<GraphTreeRow> = {
    rows: graphRows,
    rowHeight: GRAPH_ROW_HEIGHT,
    selectedId: selectedRef?.kind === 'commit' ? selectedRef.hashFull : undefined,
    onSelect: previewLogRow,
    onActivate: previewLogRow,
    onContextMenu: (id, event) => {
      const entry = logEntryById.get(id)
      if (entry !== undefined) openHistoryMenu(event, entry)
    },
    hasMore: !logEnded,
    onLoadMore: () => { void loadMoreLog() },
    loading: logLoadingMore,
    ariaLabel: t('history'),
    emptyText: t('noHistory'),
    loadingText: t('loading'),
    loadMoreText: t('loadMore'),
    renderRow: (row) => (
      <span className={css.gitLogGraphRow}>{renderLogRowContent(logEntryById.get(row.id))}</span>
    ),
    rowAttributes: graphRowAttributes,
  }

  const renderEntry = (entry: GitStatusEntry, staged: boolean): ReactNode => {
    const selected = isPreviewedWorktree(entry, staged)
    return (
      <div
        key={`${staged ? 's' : 'u'}:${entry.path}`}
        className={css.gitRow}
        data-selected={selected ? 'true' : undefined}
      >
        <button
          type="button"
          className={css.gitRowMain}
          title={entry.path}
          onClick={() => { onPreview(worktreeRefOf(entry, staged)) }}
          onContextMenu={(event) => { openFileMenu(event, entry, staged) }}
        >
          <span className={css.gitBadge} data-letter={badgeOf(entry)}>{badgeOf(entry)}</span>
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
          {staged ? <IconTrashOutline16 /> : <IconPlusOutline16 />}
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
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { void refresh() }}
        >
          <IconRefreshOutline16 size={14} />
        </button>
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
          <div className={css.gitSection}>
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
              disabled={busy}
              onChange={(event) => { onCommitMsgChange(event.target.value); setCommitError(null) }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void commit()
              }}
            />
            <button
              type="button"
              className={css.gitCommitButton}
              disabled={busy || commitMsg.trim() === '' || stagedEntries.length === 0}
              onClick={() => { void commit() }}
            >
              {t('commit')}
            </button>
            {commitActionViews.length > 0 && (
              <div className={css.gitCommitActions} role="group" aria-label={t('gitCommitActions')}>
                {commitActionViews.map(({ descriptor, props }) => (
                  // The action is created as an ELEMENT inside the boundary, so
                  // a throwing component is caught by it (invoking the
                  // component directly here would throw during GitLens' own
                  // render, outside the boundary).
                  <RenderBoundary key={descriptor.id} className={css.gitCommitActionBoundary}>
                    {createElement(descriptor.component, props)}
                  </RenderBoundary>
                ))}
              </div>
            )}
          </div>
          {commitError !== null && <div className={css.gitError}>{commitError}</div>}

          <div className={css.gitSection}>
            <div className={css.gitSectionHeader}><span>{t('history')}</span></div>
            {graphReady ? (
              // gitGraph framework path: the framework draws lanes/edges,
              // virtualizes the viewport and routes events; every row's
              // content and all Git business stay here (see the state block
              // above). A throwing framework render is caught by the
              // boundary and degrades to the built-in list below.
              <GraphBoundary onFail={() => { setGraphFailed(true) }}>
                {createElement(gitGraph.GraphTree, graphProps)}
              </GraphBoundary>
            ) : (
              <>
                {logEntries.map(entry => (
                  <div
                    key={entry.hashFull}
                    role="button"
                    tabIndex={0}
                    className={css.gitLogRow}
                    data-selected={selectedRef?.kind === 'commit' && selectedRef.hashFull === entry.hashFull ? 'true' : undefined}
                    title={`${entry.author} · ${entry.date}\n${entry.hashFull}`}
                    onClick={() => { onPreview(commitRefOf(entry)) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onPreview(commitRefOf(entry))
                      }
                    }}
                    onContextMenu={(event) => { openHistoryMenu(event, entry) }}
                  >
                    {renderLogRowContent(entry)}
                  </div>
                ))}
                {!logEnded && (
                  <button
                    type="button"
                    className={css.gitLogMore}
                    disabled={logLoadingMore || busy}
                    onClick={() => { void loadMoreLog() }}
                  >
                    {logLoadingMore ? t('loading') : t('loadMore')}
                  </button>
                )}
              </>
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
              // opened in the editor while the host's workspace fence is
              // armed: it rejects every path under that checkout. Hide the
              // action for that checkout so the menu does not offer a no-op
              // that confuses the user; with the fence disarmed (the
              // `workspaceFence` pref) the open is allowed through.
              ...(fileMenu !== null && (store.getPrefs().workspaceFence === false || isWithinWorkspace(scope.cwd ?? '', resolveSidebarPath(repoRoot ?? selectedWorktree ?? scope.cwd, fileMenu.entry.path)))
                ? [{ id: 'open', label: t('openEditor'), icon: <IconCodeOutline16 size={14} /> }]
                : []),
              fileMenu?.staged === true
                ? { id: 'stage', label: t('unstage'), icon: <IconTrashOutline16 size={14} /> }
                : { id: 'stage', label: t('stage'), icon: <IconPlusOutline16 size={14} /> },
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
                // the host would reject. No-op in that case — unless the
                // workspace fence is disarmed by pref.
                if (store.getPrefs().workspaceFence !== false && !isWithinWorkspace(scope.cwd ?? '', resolved)) return
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
                  onConfirm: () => gitApi.gitDiscard(gitScope, target.entry.path, selectedWorktree),
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
            compact
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
                onPreview(commitRefOf(target.entry))
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
                  onConfirm: () => gitApi.gitRevert(gitScope, target.entry.hashFull, selectedWorktree),
                })
                return
              }
              if (id === 'cherryPick') {
                runConfirmed({
                  title: t('cherryPickTitle'),
                  description: t('cherryPickDesc', { subject: target.entry.subject }),
                  confirmLabel: t('cherryPickCommit'),
                  onConfirm: () => gitApi.gitCherryPick(gitScope, target.entry.hashFull, selectedWorktree),
                })
              }
            }}
            portal
            compact
            align="start"
            getAnchorRect={() => (historyMenu === null ? null : new DOMRect(historyMenu.x, historyMenu.y, 0, 0))}
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
