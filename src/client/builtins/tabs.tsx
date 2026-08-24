/**
 * The 6 built-in tab descriptors: the plugin registers its own pages
 * (editor / git / terminal / browser / subagent / diff) through
 * the same {@link BetterSidebarService} external plugins use — eating its
 * own dogfood. The terminal descriptor owns its quota (`TERMINAL_LIMIT`)
 * and mints `terminal:<uuid>` ids through `createTab`; the browser mints
 * `browser:<n>` the same way (no quota). The editor IS the files window
 * (the old standalone explorer merged into it).
 */
import { IconBranchOutline16, IconCodeOutline16, IconFolderOpen16, IconPanelLeftOutline16, IconThinkOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { allLeaves, areaOfTab, isAgentTabId, type SidebarState } from '../state.ts'
import { t } from '../locales.ts'
import { openSidebarFile } from '../intercept.tsx'
import { EditorHost } from '../EditorHost.tsx'
import { GlobalView } from '../GlobalView.tsx'
import { lazyChunkComponent } from '../lazy-chunk.tsx'
import { GitView } from '../GitView.tsx'
import { DiffTab } from '../DiffTab.tsx'
import { SubagentView } from '../SubagentView.tsx'
import { BrowserView } from '../BrowserView.tsx'
import { IconTerminalOutline16, IconDiffOutline16, IconGlobeOutline16, IconPanelRightOutline16 } from '../icons.tsx'
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '../../prefs-shared.ts'
import type { ComponentType } from 'react'
import type { SessionScope } from '../api.ts'
import type { SidebarStore } from '../state.ts'
import type { TabDescriptor } from '../service.ts'

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
 * Exported for the full-page Global Workspace too: its bottom workbench
 * renders attached `gb:` terminal stubs through the same chunk-loaded
 * TerminalView the built-in terminal tab uses.
 */

/** The terminal view's props (mirror of TerminalView's own signature). */
export interface TerminalViewProps {
  scope: SessionScope
  tabId: string
  store: SidebarStore
  /** Host-downlink command-title updates; routes through updateTab so the
   *  tab title follows the running command's first token (workspace-bound
   *  stubs retitle in EVERY session via the windows store). */
  onTitleChange?: (title: string) => void
  /** Whether the tab is the active one with the panel open; hidden tabs
   *  re-fit + repaint on the way back to visible (tabby reactivate pattern). */
  visible?: boolean
}

/** The chunk-loaded terminal view component (see the doc comment above). */
export const LazyTerminal = lazyChunkComponent<TerminalViewProps>(
  'terminal',
  (mod) => mod.TerminalView as ComponentType<TerminalViewProps> | undefined,
)

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
  return allLeaves(state.splits)
    .flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'terminal' && !isAgentTabId(tab.id)).length
}

/** The 6 built-in tab descriptors. */
export function builtinTabs(ctx: Context, options: BuiltinTabOptions = {}): readonly TabDescriptor[] {
  return [
    {
      id: 'editor',
      // The single files window: an editor tab with no path IS the file
      // explorer (empty hint + docked tree); with a path it previews/edits
      // the file. Visible in the + menu in the explorer's old slot.
      title: () => t('files'),
      icon: (size: number) => <IconFolderOpen16 size={size} />,
      order: 10,
      hidden: false,
      dedupeKey: (tab) => tab.path,
      // Declarative settings: the file-open behavior picker (in-place switch
      // vs per-path windows) and the workbench-layout picker (docked tree vs
      // the VSCode-style independent side bar + activity bar) render as iconed
      // select rows under the editor card's gear in the Side card settings
      // page. The layout picker's `vscode` value is the mirror arrangement
      // (editor by the chat, activity bar on the panel edge).
      settings: {
        toggles: [{
          key: 'editorExplorer',
          type: 'select',
          title: () => t('editorExplorer'),
          desc: () => t('editorExplorerDesc'),
          options: [
            {
              value: true,
              icon: (size: number) => <IconPanelLeftOutline16 size={size} />,
              title: () => t('editorExplorerMerged'),
              desc: () => t('editorExplorerMergedDesc'),
            },
            {
              value: false,
              icon: (size: number) => <IconCodeOutline16 size={size} />,
              title: () => t('editorExplorerSplit'),
              desc: () => t('editorExplorerSplitDesc'),
            },
          ],
        }, {
          key: 'sidebarLayout',
          type: 'select',
          title: () => t('sidebarLayout'),
          desc: () => t('sidebarLayoutDesc'),
          options: [
            {
              value: 'docked',
              icon: (size: number) => <IconFolderOpen16 size={size} />,
              title: () => t('sidebarLayoutDocked'),
              desc: () => t('sidebarLayoutDockedDesc'),
            },
            {
              value: 'vscode',
              icon: (size: number) => <IconPanelLeftOutline16 size={size} />,
              title: () => t('sidebarLayoutVscode'),
              desc: () => t('sidebarLayoutVscodeDesc'),
            },
          ],
        }, {
          key: 'sideBarSide',
          type: 'select',
          title: () => t('sideBarSide'),
          desc: () => t('sideBarSideDesc'),
          options: [
            {
              value: 'left',
              icon: (size: number) => <IconPanelLeftOutline16 size={size} />,
              title: () => t('sideBarSideLeft'),
              desc: () => t('sideBarSideLeftDesc'),
            },
            {
              value: 'right',
              icon: (size: number) => <IconPanelRightOutline16 size={size} />,
              title: () => t('sideBarSideRight'),
              desc: () => t('sideBarSideRightDesc'),
            },
          ],
        }],
      },
      component: ({ ctx, store, scope, tab, expanded, onToggleDir, onReferenceFile, visible }) => (
        <EditorHost
          ctx={ctx}
          store={store}
          scope={scope}
          tab={tab}
          expanded={expanded ?? []}
          onToggleDir={onToggleDir ?? (() => { /* no-op */ })}
          onReferenceFile={onReferenceFile ?? (() => { /* no-op */ })}
          visible={visible}
        />
      ),
    },
    {
      id: 'git',
      title: () => t('git'),
      icon: (size: number) => <IconBranchOutline16 size={size} />,
      order: 20,
      single: true,
      component: ({ ctx, store, scope, tab, onOpenDiff }) => {
        // The panel the git tab lives in: a context-menu "open file" must
        // land in the SAME panel — the menu is portaled outside the pane, so
        // no pane pointerdown focuses it and the global activePane would
        // otherwise swallow the open into the other box.
        const state = store.getSnapshot().state
        const gitArea = state === undefined ? 'right' : areaOfTab(state, tab.id)
        return (
          <GitView
            scope={scope}
            onOpenFile={(path) => { openSidebarFile(ctx, store, scope.sessionId, path, gitArea) }}
            onOpenDiff={onOpenDiff ?? (() => { /* no-op */ })}
          />
        )
      },
    },
    {
      id: 'subagent',
      title: () => t('subagent'),
      icon: (size: number) => <IconThinkOutline16 size={size} />,
      order: 30,
      single: true,
      // Declarative settings: the auto-open switches render under this row in
      // the Side card settings page (the Jobs page's own related settings).
      settings: {
        toggles: [{
          key: 'autoOpenSubagent',
          title: () => t('settingsSubagentTitle'),
          desc: () => t('settingsSubagentDesc'),
        }, {
          key: 'autoOpenJobs',
          title: () => t('settingsJobsTitle'),
          desc: () => t('settingsJobsDesc'),
        }],
      },
      component: ({ ctx, scope, visible, onSubagentJump }) => (
        <SubagentView
          sessionId={scope.sessionId}
          ctx={ctx}
          active={visible}
          onOpenChild={(address) => { onSubagentJump?.(address.childSessionId) }}
        />
      ),
    },
    {
      id: 'terminal',
      title: () => t('terminal'),
      icon: (size: number) => <IconTerminalOutline16 size={size} />,
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
      component: ({ tab, scope, store, ctx, visible }) => (
        <LazyTerminal
          scope={scope}
          store={store}
          tabId={tab.id}
          visible={visible}
          onTitleChange={(title) => { ctx.betterSidebar?.updateTab(tab.id, { title }) }}
        />
      ),
    },
    {
      id: 'browser',
      title: () => t('browser'),
      icon: (size: number) => <IconGlobeOutline16 size={size} />,
      order: 50,
      // Declarative settings: the sandbox escape hatch, the link-takeover
      // MASTER switch, and the per-protocol takeover switches (http on /
      // https off by default) render under this tab's row in the Side card
      // settings page (the sandbox one is warned on).
      settings: {
        toggles: [{
          key: 'browserNoSandbox',
          title: () => t('settingsBrowserSandboxTitle'),
          desc: () => t('settingsBrowserSandboxDesc'),
        }, {
          key: 'browserInterceptLinks',
          title: () => t('settingsBrowserLinksTitle'),
          desc: () => t('settingsBrowserLinksDesc'),
        }, {
          key: 'browserInterceptHttp',
          title: () => t('settingsBrowserHttpTitle'),
          desc: () => t('settingsBrowserHttpDesc'),
        }, {
          key: 'browserInterceptHttps',
          title: () => t('settingsBrowserHttpsTitle'),
          desc: () => t('settingsBrowserHttpsDesc'),
        }],
      },
      createTab: (state) => ({
        tab: {
          id: `browser:${state.nextBrowser}`,
          type: 'browser',
          title: t('browser'),
        },
        patch: { nextBrowser: state.nextBrowser + 1 },
      }),
      component: (props) => <BrowserView {...props} />,
    },
    {
      id: 'global',
      // The "Global info" page: records every instance-level global window
      // (the `gb:` all-projects shared terminals and friends). Reachable from
      // the + menu and from the official left sidebar's footer action (the
      // plugin injects it into `sidebar.footer.action`).
      title: () => t('globalInfo'),
      icon: (size: number) => <IconGlobeOutline16 size={size} />,
      order: 60,
      single: true,
      component: (props) => <GlobalView {...props} />,
    },
    {
      id: 'diff',
      title: () => t('git'),
      icon: (size: number) => <IconDiffOutline16 size={size} />,
      order: -1,
      hidden: true,
      dedupeKey: (tab) => tab.id,
      component: ({ scope, tab }) => (
        tab.diff === undefined ? null
          : <DiffTab sessionId={scope.sessionId} cwd={scope.cwd} diff={tab.diff} />
      ),
    },
  ]
}
