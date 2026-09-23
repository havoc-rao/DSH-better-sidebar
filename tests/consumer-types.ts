/**
 * Consumer-facing type surface compile gate (v0.12.0+): this file exercises
 * EVERY public type and descriptor field exactly the way an external plugin
 * would, so `pnpm typecheck` fails the moment the shipped declaration
 * surface (service.ts re-exports / descriptor fields / service methods)
 * drifts from what consumers can name. Type-only — erased at runtime, never
 * executed by vitest (no `*.spec` suffix).
 *
 * Mirrors the "external consumer" fixture: what is importable here from
 * `../src/client/service.ts` must also be importable from
 * `dsh-better-sidebar/client/service` in the built package.
 */
import type {} from '../src/client/service.ts'
import {
  FOLDER_EXT,
  FOLDER_OPEN_EXT,
  SIDEBAR_FEATURES,
  SIDEBAR_SERVICE_VERSION,
} from '../src/client/service.ts'
import type {
  BetterSidebarService,
  FileFetchStrategy,
  FileIconDescriptor,
  FileViewerDescriptor,
  FileViewerProps,
  GitCommitActionDescriptor,
  GitCommitActionProps,
  GitCommitTarget,
  GitDataSource,
  GitOkResult,
  GitProviderDescriptor,
  OpenTabSeed,
  SidebarSettingsDeclaration,
  SidebarSettingsRenderProps,
  SidebarSettingToggle,
  SidebarSettingToggleType,
  TabComponentProps,
  TabDescriptor,
  TerminalProviderDescriptor,
} from '../src/client/service.ts'
import type {
  GitDiffRef,
  SessionScope,
  SidebarDiffRef,
  SidebarPrefs,
  SidebarSnapshot,
  SidebarState,
  SidebarStore,
  SidebarTab,
  TabType,
} from '../src/client/service.ts'

/** A full-featured external tab descriptor using every v0.12.0 field. */
const tab: TabDescriptor = {
  id: 'my-plugin:db',
  title: () => 'Database',
  icon: (_size: number) => null,
  order: 50,
  hidden: false,
  available: (ctx, scope, state) => scope.sessionId !== '' && state.bottomOpen && ctx !== null,
  single: false,
  dedupeKey: (t: SidebarTab) => t.id,
  createTab: (state: SidebarState) => ({
    tab: { id: `my-plugin:db:${state.nextTerminal}`, type: 'my-plugin:db', title: 'DB', meta: { n: state.nextTerminal } },
    patch: { nextTerminal: state.nextTerminal + 1 },
  }),
  badge: (ctx, scope, state) => (state.expanded.length > 0 ? state.expanded.length : null),
  onOpen: (tab: SidebarTab, scope: SessionScope) => { void tab; void scope },
  onActivate: (tab: SidebarTab, scope: SessionScope) => { void tab; void scope },
  onClose: (tab: SidebarTab, scope: SessionScope) => { void tab; void scope },
  settings: {
    toggles: [{ key: 'autoOpenSubagent', title: 'Auto-open', type: 'switch' }],
    pluginToggles: [{
      key: 'pageSize',
      title: 'Page size',
      type: 'number',
      min: 1,
      max: 100,
      unit: 'rows',
    }],
    render: (props: SidebarSettingsRenderProps) => {
      props.updatePluginSetting('refresh', true)
      props.close()
      return null
    },
  },
  component: (props: TabComponentProps) => {
    const { ctx, store, scope, tab, visible } = props
    void ctx; void store; void scope; void tab; void visible
    return null
  },
}

/** A full-featured external viewer using the v0.12.0 load signal. */
const viewer: FileViewerDescriptor = {
  id: 'my-plugin:csv',
  title: 'CSV',
  exts: ['csv'],
  priority: 10,
  fetchStrategy: 'custom',
  detect: (_path, head: Uint8Array) => head.length > 0,
  load: async (path: string, scope: SessionScope, signal?: AbortSignal) => {
    void path; void scope; void signal
    return { rows: [] }
  },
  settings: { pluginToggles: [{ key: 'delimiter', title: 'Delimiter', type: 'text', placeholder: ',' }] },
  component: (props: FileViewerProps) => {
    const { customData, content, truncated, mediaUrl, viewerId, path, title } = props
    void customData; void content; void truncated; void mediaUrl; void viewerId; void path; void title
    return null
  },
}

/** The full service surface, exercised exactly as consumers call it. */
declare const ctx: { betterSidebar: BetterSidebarService }
const service: BetterSidebarService = ctx.betterSidebar
service.registerTab(tab)
service.registerFileViewer(viewer)
service.getTabs()
service.getFileViewers()
service.getTab('my-plugin:db')
service.isTabEnabled('my-plugin:db')
service.isViewerEnabled('my-plugin:csv')
service.matchFileViewer('a.csv', new Uint8Array([1]))
service.closeTab('tab:1')
service.subscribe(() => {})
const seed: OpenTabSeed = { type: 'my-plugin:db', title: 'DB', path: '/p', id: 'x', meta: { a: 1 } }
service.openTab(seed)
service.openTab(seed, { sessionId: 's1', cwd: '/p' })
const _version: string = service.version
service.features.includes('badge')
const snapshot: SidebarSnapshot | undefined = service.getSnapshot()
void snapshot
service.subscribeState(() => {})
service.updateTab('tab:1', { title: 'T', path: '/p', meta: 1 })
service.activateTab('tab:1')
service.openFile({ sessionId: 's1', cwd: '/p' }, '/p/a.csv', 'Data')

/** File-icon registration surface (feature `fileIcons`). */
const icon: FileIconDescriptor = {
  id: 'my-plugin:icons',
  exts: ['csv', FOLDER_EXT, FOLDER_OPEN_EXT],
  names: ['package.json'],
  folderNames: ['node_modules'],
  priority: 5,
  icon: (path: string, size: number, open?: boolean) => {
    void path; void size; void open
    return null
  },
}
service.registerFileIcon(icon)
service.getFileIcons()
service.matchFileIcon('/p/a.csv')
service.matchFolderIcon(true)
service.matchFolderIcon(true, 'node_modules')
service.fileIcon('/p/a.csv', 14)
service.folderIcon('/p', true, 14)

/** Git commit-action seam (feature `gitCommitActions`). */
const commitTarget: GitCommitTarget = {
  scope: { sessionId: 's1', cwd: '/p' },
  repoRoot: '/p',
  worktree: '/p',
  branch: 'main',
  status: { isRepo: true, branch: 'main', entries: [] },
  staged: [],
}
void commitTarget
const commitAction: GitCommitActionDescriptor = {
  id: 'my-plugin:commit-agent',
  order: 50,
  available: (target: GitCommitTarget) => target.staged.length > 0 && target.worktree !== undefined,
  component: (props: GitCommitActionProps) => {
    void props.refresh
    const live: GitCommitTarget | undefined = props.service.getGitCommitTarget({ sessionId: props.scope.sessionId })
    void live
    return null
  },
}
service.registerGitCommitAction(commitAction)
service.getGitCommitActions()
service.getGitCommitTarget()
service.getGitCommitTarget({ sessionId: 's1', cwd: '/p' })

/** Terminal-source slot (feature `terminalSource`). */
const terminalDescriptor: TerminalProviderDescriptor = {
  id: 'my-plugin:terminal',
  match: (sessionId: string, _cwd: string | undefined, tabId: string) =>
    sessionId === 's1' && !tabId.startsWith('agent:') && !tabId.startsWith('gb:'),
  createTransport: () => undefined, // a refusal is a valid factory result
}
const disposeTerminal: () => void = service.registerTerminalProvider(terminalDescriptor)
const terminalProviders: readonly TerminalProviderDescriptor[] = service.getTerminalProviders()
void disposeTerminal; void terminalProviders

/** Git data-source slot (feature `gitSource`). */
const gitProvider: GitProviderDescriptor = {
  id: 'my-plugin:git',
  match: (sessionId: string) => sessionId === 's1',
  createSource: () => undefined, // a refusal is a valid factory result
}
const gitSource: GitDataSource | undefined = undefined
const gitOk: GitOkResult = { ok: true }
const disposeGit: () => void = service.registerGitProvider(gitProvider)
const gitProviders: readonly GitProviderDescriptor[] = service.getGitProviders()
void gitSource; void gitOk; void disposeGit; void gitProviders

/** gitGraph v1 framework consumption (soft join, provider dsh-git-graph):
 *  type-only cross-package contract; the consumer holds the literal service
 *  name / protocol version and shape-checks the runtime value itself. */
import type {
  GitGraphServiceV1,
  GraphTreePointerEvent,
  GraphTreeProps,
  GraphTreeRow,
  GraphTreeRowContext,
} from 'dsh-git-graph/client-contract'
declare const gitGraphValue: unknown
const gitGraph: GitGraphServiceV1 | undefined
  = (gitGraphValue !== null && typeof gitGraphValue === 'object'
    && (gitGraphValue as Partial<GitGraphServiceV1>).protocolVersion === 1
    && typeof (gitGraphValue as Partial<GitGraphServiceV1>).GraphTree === 'function')
    ? gitGraphValue as GitGraphServiceV1
    : undefined
const graphRow: GraphTreeRow = { id: 'a'.repeat(40), parents: [] }
const graphRows: GraphTreeRow[] = [graphRow]
gitGraph?.GraphTree<GraphTreeRow>({
  rows: graphRows,
  renderRow: (row: GraphTreeRow, ctx: GraphTreeRowContext) => {
    void row.id; void ctx.index; void ctx.totalCount; void ctx.selected; void ctx.focused
    return null
  },
  selectedId: graphRow.id,
  onSelect: (id: string) => { void id },
  onActivate: (id: string) => { void id },
  onContextMenu: (id: string, event: GraphTreePointerEvent) => {
    event.preventDefault()
    const point: { x: number; y: number } = { x: event.clientX, y: event.clientY }
    void point; void id
  },
  hasMore: true,
  onLoadMore: () => {},
  loading: false,
  rowAttributes: (row: GraphTreeRow): Record<string, string> => ({ title: row.id }),
  ariaLabel: 'History',
  emptyText: 'None',
  loadingText: 'Loading',
  loadMoreText: 'More',
  height: 320,
  rowHeight: 44,
  overscan: 5,
  className: 'x',
})
const graphProps: GraphTreeProps<GraphTreeRow> = gitGraph === undefined
  ? { rows: [], renderRow: () => null }
  : { rows: graphRows, renderRow: () => null }
const graphServiceVersion: 1 = gitGraph?.protocolVersion ?? 1
void graphProps; void graphServiceVersion; void gitGraph

/** Named state vocabulary stays importable (the pre-0.12 gap). */
const diff: SidebarDiffRef = { kind: 'worktree', path: '/p/a.ts', staged: false }
const proposed: SidebarDiffRef = { kind: 'proposed', id: 'plan:1', title: 'Plan', patch: 'diff --git a/x b/x' }
const gitDiffRef: GitDiffRef = { kind: 'commit', hash: 'abc1234', hashFull: 'a'.repeat(40), subject: 's' }
const prefs: SidebarPrefs = { ...({} as SidebarPrefs) }
const store: SidebarStore = null as unknown as SidebarStore
const toggleType: SidebarSettingToggleType = 'number'
const toggle: SidebarSettingToggle = { key: 'k', title: 'K', type: toggleType }
const declaration: SidebarSettingsDeclaration = { toggles: [toggle], pluginToggles: [toggle] }
const typeName: TabType = 'my-plugin:db'
const version: string = SIDEBAR_SERVICE_VERSION
const features: readonly string[] = SIDEBAR_FEATURES
void version; void features
const strategy: FileFetchStrategy = 'mediaUrl'
void diff; void proposed; void gitDiffRef; void prefs; void store; void declaration; void typeName; void strategy
