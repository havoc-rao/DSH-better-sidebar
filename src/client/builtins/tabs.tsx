/**
 * The built-in tab descriptors: the plugin registers its own pages
 * (editor / git — the unified changes tab / subagent / sidechat / browser /
 * diff) through
 * the same {@link BetterSidebarService} external plugins use — eating its
 * own dogfood. The editor IS the files window (the old standalone explorer
 * merged into it).
 *
 * DSH 0.1.6-alpha.2 ships its own right-Sidebar terminal and browser tab
 * types, so this plugin contributes neither: the host's `terminal` kind owns
 * interactive shells outright, and the host's `browser` kind (delegated to
 * from the chat's http(s) links) owns embedded pages. See
 * docs/plans/2026-09-21-dsh-0.1.6-alpha.2-adaptation.md.
 */
import { IconCodeOutlineRegular, IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import {
  changesTabIcon, filesTabIcon, sidechatTabIcon, tasksTabIcon, terminalTabIcon,
} from './tab-icons.tsx'
import { allLeaves, isAgentTabId, type SidebarState } from '../state.ts'
import { t } from '../locales.ts'
import { openSidebarFile, openSidebarFileAt } from '../intercept.tsx'
import { EditorHost } from '../EditorHost.tsx'
import { OpenWithSettings } from '../open-with-settings.tsx'
import { LocalePreferenceRow } from '../SideCardSection.tsx'
import { lazyChunkComponent } from '../lazy-chunk.tsx'
import { ChangesTab, opCountOf } from '../changes/ChangesTab.tsx'
import { DiffTab } from '../DiffTab.tsx'
import { SubagentView } from '../SubagentView.tsx'
import { consumeSidechatSeed, SideChatView, sidechatThreadIdOf } from '../SideChatView.tsx'
import { api } from '../api.ts'
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '../../prefs-shared.ts'
import { useTerminalTransport } from '../terminal-source.ts'
import { resolveWorkspaceTerminalBinding, terminalServiceOf, workspaceTerminalIdOf, workspaceTerminalProviderOf } from '../workspace-terminals.ts'
import { WorkspaceTerminals } from '../WorkspaceTerminals.tsx'
import type { TerminalTransport } from '../terminal-transport.ts'
import { useEffect, useMemo, useReducer, type ComponentType, type ReactNode } from 'react'
import type { SessionScope } from '../api.ts'
import type { SidebarStore } from '../state.ts'
import type { TabComponentProps, TabDescriptor } from '../service.ts'

/**
 * Lazy wrapper over the terminal view: xterm (and its stylesheet) is fetched
 * only when a terminal tab is first opened (see chunk-loader.ts). The
 * wrapper keeps the descriptor contract `(props) => ReactNode` — Sidebar
 * calls it as a plain function.
 *
 * TerminalView's props are { scope, tabId, store } — `tabId` is NOT part of
 * TabComponentProps (it carries `tab: SidebarTab` instead), so the
 * descriptor maps it explicitly; a bare pass-through would leave tabId
 * undefined and TerminalView's isAgentTabId(tabId) would crash on
 * `undefined.startsWith` (regression-pinned in tests/lazy-chunk.spec.tsx).
 */
const LazyTerminal = lazyChunkComponent<TerminalViewProps>(
  'terminal',
  (mod) => mod.TerminalView as ComponentType<TerminalViewProps> | undefined,
)

/**
 * The terminal tab's SOURCE-RESOLVING wrapper (the terminal-source slot,
 * feature 'terminalSource'): the custom transport a registered provider
 * resolved for this (session, cwd, tab) — absent → TerminalView keeps its
 * default local pty WebSocket, byte for byte. TerminalView reads
 * `transport` once at mount, so resolution applies to terminals mounted
 * after the registry read (77ddf5e-style).
 */
function TerminalTabTransport(props: TabComponentProps): ReactNode {
  const { ctx, tab, scope, store, visible } = props
  const terminalId = workspaceTerminalIdOf(tab)
  const legacyTransport = useTerminalTransport(ctx, terminalId === undefined ? scope?.sessionId : undefined, scope?.cwd, tab.id)
  const providerId = workspaceTerminalProviderOf(tab)
  const service = terminalServiceOf(ctx)
  const [revision, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => service?.subscribe(bump), [service])
  const managed = useMemo(() => {
    if (terminalId === undefined || providerId === undefined) return undefined
    try {
      const binding = resolveWorkspaceTerminalBinding(service, scope.sessionId, scope.cwd, providerId)
      return { binding, transport: binding.source.createTransport(terminalId) }
    } catch (error) {
      // Restored remote references must NEVER fall through to the local WS.
      const message = error instanceof Error ? error.message : String(error)
      const transport: TerminalTransport = { kind: 'workspace-provider-unavailable', open: session => {
        session.onFatal?.(message)
        return { input() {}, resize() {}, close() {}, park() {}, dispose() {} }
      } }
      return { transport }
    }
  }, [service, scope.sessionId, scope.cwd, terminalId, providerId, revision])
  return (
    <LazyTerminal
      key={providerId === undefined ? tab.id : `${tab.id}:${terminalId}:${managed?.transport.kind}`}
      ctx={ctx}
      scope={scope}
      store={store}
      tabId={tab.id}
      terminalId={terminalId}
      transport={managed?.transport ?? legacyTransport}
      workspaceBinding={managed?.binding}
      visible={visible}
    />
  )
}

/** The terminal view's props (mirror of TerminalView's own signature). */
interface TerminalViewProps {
  ctx: Context
  scope: SessionScope
  tabId: string
  terminalId?: string
  store: SidebarStore
  /** Feature 'terminalSource': the transport a registered provider
   *  resolved for this terminal tab; absent → TerminalView's built-in
   *  local pty WebSocket (byte for byte). */
  transport?: TerminalTransport
  workspaceBinding?: import('../terminal-source.ts').WorkspaceTerminalBinding
  /** Whether this tab is the visible active tab of the bottom workbench
   *  (Sidebar's renderTab: `state.bottomOpen && active`): the view focuses
   *  xterm on open — a terminal opened in the bottom box takes keyboard
   *  input immediately. Absent → no auto-focus (native right-sidebar
   *  tabs render without it). */
  visible?: boolean
}

/** How many UI-owned terminals may be open at once (agent-owned ones are uncapped). */
export const TERMINAL_LIMIT = 3

/** Optional per-registration builtin behavior (currently terminal title). */
export interface BuiltinTabOptions {
  /** Returns the display title for newly opened terminal tabs. */
  terminalTitle?: () => string
}

/** A client-side uuid for terminal tab identity (not shown in the UI). */
function terminalUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

/** Count UI-owned terminals (agent:` tabs excluded — they are the model's). */
function uiTerminalCount(state: SidebarState): number {
  return allLeaves(state.bottomSplits)
    .flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'terminal' && !isAgentTabId(tab.id)).length
}

/** The 7 built-in tab descriptors. */
export function builtinTabs(ctx: Context, options: BuiltinTabOptions = {}): readonly TabDescriptor[] {

  return [
    {
      id: 'editor',
      description: () => t('guideDescFiles'),
      // The single files window: an editor tab with no path IS the file
      // explorer (empty hint + docked tree); with a path it previews/edits
      // the file. Visible in the + menu in the explorer's old slot.
      title: () => t('files'),
      icon: filesTabIcon,
      order: 10,
      hidden: false,
      dedupeKey: (tab) => tab.path,
      // Declarative settings: the file-open behavior picker (in-place switch
      // vs per-path windows) renders as an iconed select row under the
      // editor card's gear in the Side card settings page; the "open with"
      // configuration (SSH host + custom editors) is the custom panel BELOW
      // those rows — the settings seam renders rows first, custom panel after.
      // The workspace-fence switch is GONE: there is no containment to toggle.
      settings: {
        toggles: [{
          key: 'editorExplorer',
          type: 'select',
          title: () => t('editorExplorer'),
          desc: () => t('editorExplorerDesc'),
          options: [
            {
              value: true,
              icon: (size: number) => <IconPanelLeftOutlineRegular size={size} />,
              title: () => t('editorExplorerMerged'),
              desc: () => t('editorExplorerMergedDesc'),
            },
            {
              value: false,
              icon: (size: number) => <IconCodeOutlineRegular size={size} />,
              title: () => t('editorExplorerSplit'),
              desc: () => t('editorExplorerSplitDesc'),
            },
          ],
        }],
        // Plugin-owned rows (values live in `pluginSettings['editor']`): the
        // plugin's own open-with targets are shown only when the host reports
        // no local application, unless the user asks for both side by side.
        pluginToggles: [{
          key: 'openWithPluginTargets',
          title: () => t('settingsOpenWithPluginTitle'),
          desc: () => t('settingsOpenWithPluginDesc'),
        }],
        render: ({ pluginSettings, updatePluginSetting }) => (
          <OpenWithSettings pluginSettings={pluginSettings} updatePluginSetting={updatePluginSetting} />
        ),
      },
      component: ({ ctx, store, scope, tab, visible, expanded, revealed, onToggleDir, onReferenceFile }) => (
        <EditorHost
          ctx={ctx}
          store={store}
          scope={scope}
          tab={tab}
          visible={visible}
          expanded={expanded ?? []}
          revealed={revealed ?? []}
          onToggleDir={onToggleDir ?? (() => { /* no-op */ })}
          onReferenceFile={onReferenceFile ?? (() => { /* no-op */ })}
        />
      ),
    },
    {
      // The unified changes tab (id kept as 'git' so persisted layouts keep
      // resolving): the Git lens is the former source-control panel; the
      // session lens is the former file-trace tab (PR #471). Both preview
      // through one shared diff stack. The badge reads the op-count cache
      // the tab's event poll publishes (the client ctx exposes no event
      // log, and the git status needs a fetch — both stay out of the badge).
      id: 'git',
      title: () => t('changes'),
      description: () => t('guideDescGit'),
      icon: changesTabIcon,
      order: 20,
      single: true,
      // Custom settings panel: the DSH interface-language picker — the
      // second entry point to the same Host-backed `locale.preference`
      // the General section's Language row drives, so both stay in sync.
      // It is the changes tab's ONLY setting: the diff view stays docked
      // (no diff-placement preference here).
      settings: {
        render: () => <LocalePreferenceRow ctx={ctx} />,
      },
      badge: (_ctx, scope) => {
        const count = opCountOf(scope.sessionId)
        return count === undefined || count === 0 ? null : count
      },
      component: ({ ctx, store, scope, tab, visible, onOpenDiff }) => (
        <ChangesTab
          ctx={ctx}
          store={store}
          scope={scope}
          tab={tab}
          visible={visible}
          onOpenFile={(path) => { openSidebarFile(ctx, store, scope.sessionId, path) }}
          onOpenDiff={onOpenDiff}
        />
      ),
    },
    {
      id: 'subagent',
      title: () => t('subagent'),
      description: () => t('guideDescSubagent'),
      icon: tasksTabIcon,
      order: 30,
      single: true,
      // Declarative settings: the auto-open switches render under this row in
      // the Side card settings page (the Tasks page's related settings).
      settings: {
        toggles: [{
          key: 'autoOpenSubagent',
          title: () => t('settingsSubagentTitle'),
          desc: () => t('settingsSubagentDesc'),
        }, {
          key: 'autoOpenJobs',
          title: () => t('settingsJobsTitle'),
          desc: () => t('settingsJobsDesc'),
        }, {
          key: 'tasksViewMode',
          type: 'select',
          title: () => t('settingsViewModeTitle'),
          desc: () => t('settingsViewModeDesc'),
          options: [
            {
              value: 'graph',
              title: () => t('settingsViewModeGraph'),
              desc: () => t('settingsViewModeGraphDesc'),
            },
            {
              value: 'tree',
              title: () => t('settingsViewModeTree'),
              desc: () => t('settingsViewModeTreeDesc'),
            },
          ],
        }],
      },
      component: ({ ctx, store, scope, visible, onSubagentJump }) => (
        <SubagentView
          sessionId={scope.sessionId}
          ctx={ctx}
          store={store}
          active={visible}
          onOpenChild={(address) => { onSubagentJump?.(address.childSessionId) }}
        />
      ),
    },
    {
      id: 'sidechat',
      title: () => t('sideChat'),
      description: () => t('guideDescSidechat'),
      icon: sidechatTabIcon,
      order: 35,
      // Codex-style: EVERY side conversation is its own tab. A plain open
      // mints a fresh tab flagged `autoCreate` (the view creates the EMPTY
      // thread on mount); a thread switch from the header menu parks the
      // target id for a deterministic `sidechat:<threadId>` reattach tab.
      createTab: () => {
        const threadId = consumeSidechatSeed()
        if (threadId !== undefined) {
          return {
            tab: {
              id: `sidechat:${threadId}`,
              type: 'sidechat',
              title: t('sideChat'),
              meta: { threadId },
            },
          }
        }
        return {
          tab: {
            id: `sidechat:new-${crypto.randomUUID()}`,
            type: 'sidechat',
            title: t('sideChatUntitled'),
            meta: { autoCreate: true },
          },
        }
      },
      // One tab per thread: an already-open thread focuses instead of
      // duplicating; unbound fresh tabs never dedupe (each mints its own).
      dedupeKey: (tab) => sidechatThreadIdOf(tab),
      // Closing the tab releases the thread's live agent; the session and
      // its history stay persisted (reopen from any thread's header menu).
      onClose: (tab) => {
        const threadId = sidechatThreadIdOf(tab)
        if (threadId !== undefined) {
          void api.sidechatDispose(threadId).catch(() => {})
        }
      },
      component: ({ ctx, scope, tab, visible }) => (
        <SideChatView ctx={ctx} scope={scope} tab={tab} visible={visible} />
      ),
    },
    {
id: 'terminal',
      title: () => t('terminal'),
      description: () => t('guideDescTerminal'),
      icon: terminalTabIcon,
      order: 40,
      available: (_ctx, _scope, state) => uiTerminalCount(state) < TERMINAL_LIMIT,
      // Declarative settings: the model-facing terminal tools switch, the
      // bottom-panel first-expansion auto-terminal switch, and the custom
      // font family/size rows render under this card in the Side card
      // settings page (the host gates the toolset on the tools one
      // independently; the font rows apply live to every terminal).
      settings: {
        toggles: [{
          key: 'agentTerminalTools',
          title: () => t('settingsToolsTitle'),
          desc: () => t('settingsToolsDesc'),
        }, {
          key: 'bottomPanelAutoTerminal',
          title: () => t('settingsBottomTerminalTitle'),
          desc: () => t('settingsBottomTerminalDesc'),
        }, {
          key: 'terminalShell',
          type: 'text',
          title: () => t('settingsShellTitle'),
          desc: () => t('settingsShellDesc'),
          placeholder: t('settingsShellPlaceholder'),
        }, {
          key: 'terminalShellArgs',
          type: 'text',
          title: () => t('settingsShellArgsTitle'),
          desc: () => t('settingsShellArgsDesc'),
          placeholder: t('settingsShellArgsPlaceholder'),
        }, {
          key: 'terminalFontFamily',
          type: 'text',
          title: () => t('settingsFontFamilyTitle'),
          desc: () => t('settingsFontFamilyDesc'),
          placeholder: t('settingsFontFamilyPlaceholder'),
        }, {
          key: 'terminalFontSize',
          type: 'number',
          title: () => t('settingsFontSizeTitle'),
          desc: () => t('settingsFontSizeDesc'),
          min: TERMINAL_FONT_SIZE_MIN,
          max: TERMINAL_FONT_SIZE_MAX,
          unit: 'px',
        }],
      },
      createTab: (state) => {
        const count = uiTerminalCount(state)
        if (count >= TERMINAL_LIMIT) return null
        return {
          tab: {
            id: `terminal:${terminalUuid()}`,
            type: 'terminal',
            title: options.terminalTitle?.() ?? t('terminal'),
          },
          // Keep the legacy counter advancing for compatibility with older
          // persisted states; new ids no longer use it.
          patch: { nextTerminal: state.nextTerminal + 1 },
        }
      },
      component: (props) => <TerminalTabTransport {...props} />,
    },
    {
      id: 'workspace-terminals',
      title: () => t('workspaceTerminals'),
      description: () => t('workspaceTerminalDetachHint'),
      icon: terminalTabIcon,
      order: 41,
      single: true,
      component: ({ ctx, scope, store, visible }) => (
        <WorkspaceTerminals ctx={ctx} sessionId={scope.sessionId} store={store} visible={visible} />
      ),
    },
    {
      id: 'diff',
      title: () => t('changes'),
      icon: changesTabIcon,
      order: -1,
      hidden: true,
      dedupeKey: (tab) => tab.id,
      component: ({ ctx, store, scope, tab }) => (
        tab.diff === undefined ? null
          : <DiffTab sessionId={scope.sessionId} cwd={scope.cwd} diff={tab.diff}
              onOpenFile={tab.diff.kind === 'proposed'
                ? (path: string) => openSidebarFile(ctx, store, scope.sessionId, path)
                : undefined}
              onOpenRow={tab.diff.kind === 'proposed'
                ? (path: string, line: number | null) => openSidebarFileAt(ctx, store, scope.sessionId, path, line)
                : undefined} />
      ),
    },
  ]
}
