/**
 * Client half of dsh-better-sidebar: resolves the user's "Side card"
 * preferences through the plugin's own fenced settings route, mounts the
 * right sidebar portal (inside an error boundary so a rendering failure
 * shows an error strip instead of a blank panel), registers the turn-tail
 * interception, and contributes the Side card settings section to the DSH
 * Settings shell. Requires the runtime's slots and sessions services; the
 * bundle itself is a module-table consumer only (react + ui-primitives +
 * xterm, all provided or inlined).
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context, SidebarLayoutService } from '../context-types.ts'
import { createSidebarStore, activeTabOf, activePaneTabsOf } from './state.ts'
import { createBetterSidebarService, matchUrlTarget } from './service.ts'
import { createWorkspaceWindowsStore } from './workspace-windows.ts'
import { resetChunks } from './chunk-loader.ts'
import { registerBuiltins } from './builtins/index.ts'
import { registerBuiltinKeybindings } from './builtins/keybindings.ts'
import { Sidebar } from './Sidebar.tsx'
import { RenderBoundary } from './RenderBoundary.tsx'
import { registerOpenPathInterception, registerTurnTailInterception } from './intercept.tsx'
import { registerLinkInterception } from './link-intercept.ts'
import { registerImeGuard } from './ime-guard.ts'
import { KeybindingRuntime, isPlusMenuOpen, isSearchActive, type SidebarKeybindingContext } from './keybindings.ts'
import { registerSettingsNavIcon } from './settings-nav-icon.ts'
import { registerOfficialSidebarEntry } from './official-sidebar.tsx'
import { loadExternalDisable, loadPrefs } from './prefs.ts'
import { SideCardSection } from './SideCardSection.tsx'
import { api } from './api.ts'
import { isNarrowWidth } from './breakpoints.ts'
import { LOCALE_NS, attachLocale, t, zh, en } from './locales.ts'
import css from './sidebar.module.css'
import './layout.css'

/** Services required before mounting (provided by the client runtime; the
 *  locale service backs the sidebar's copy — see locales.ts). */
export const inject = ['slots', 'sessions', 'connection', 'workspaces', 'locale']

/**
 * Error boundary over the sidebar tree (root scope): a render error in the
 * sidebar SHELL itself must never blank the page silently — the shared
 * RenderBoundary shows a dismissible error strip and logs the stack. The
 * per-tab scope (Sidebar.tsx) catches viewer/editor crashes first; this root
 * boundary stays as the last resort for Workbench/shell errors.
 */
/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, sessions).
 */
export function apply(ctx: Context): void {
  // The sidebar follows the DSH i18n system: attach the locale service so
  // the module-level t()/isZh() resolve the Host-backed language preference
  // (and switch live — the Sidebar root subscribes to it), and register the
  // plugin's dictionaries into the shared locale registry. The disposers
  // run on fiber disposal, so re-activation (HMR) re-registers cleanly.
  attachLocale(ctx.locale)
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    return () => { offZh(); offEn() }
  }, 'dsh-better-sidebar: dictionaries')
  // One store instance per activation: production code creates it only here,
  // then hands it to the mounted panel and closes over it in the slot
  // registrations (the official createXXXStore() factory rule — no
  // module-level singleton).
  const sidebarStore = createSidebarStore()
  // The workspace windows store: workspace-bound windows ("pinned" content
  // tabs shared by every session of a workspace). Attached to the sidebar
  // store so bound windows merge into every session's first leaf and strip
  // out of persistence; the service routes stub updates/opens through it.
  const workspaceWindows = createWorkspaceWindowsStore(ctx)
  workspaceWindows.attachSidebarStore(sidebarStore)
  // The ONE keybinding runtime: every built-in shortcut (panel toggles,
  // quick open, search focus, tab keys) and every plugin registration share
  // this document-capture dispatcher. Its context is rebuilt per key event
  // from the store snapshot, the DOM focus, and the transient UI markers
  // (the + menu / search states published by the components).
  const keybindingRuntime = new KeybindingRuntime((): SidebarKeybindingContext => {
    const snapshot = sidebarStore.getSnapshot()
    const state = snapshot.state ?? null
    const activeTab = state === null ? undefined : activeTabOf(state)
    let focusInSidebar = false
    let textEditing = false
    try {
      const activeElement = document.activeElement as HTMLElement | null
      if (activeElement !== null) {
        focusInSidebar = activeElement.closest?.('[data-dsh-better-sidebar]') !== null
        textEditing = !focusInSidebar
          && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)
      }
    } catch {
      // Degraded focus context: bindings fall back to their other gates.
    }
    return {
      state,
      narrow: isNarrowWidth(window.innerWidth),
      focusInSidebar,
      textEditing,
      plusMenuOpen: isPlusMenuOpen(),
      searchActive: isSearchActive(),
      activeTab: activeTab ?? null,
      activeTabType: activeTab?.type ?? '',
      activePaneTabs: state === null ? [] : activePaneTabsOf(state),
    }
  })
  // The sidebar registry service: external plugins register tab types and
  // file previewers through `ctx.betterSidebar.registerTab/registerFileViewer`,
  // and keybindings through `registerKeybinding` — all landing on the shared
  // runtime above. Published before the panel mounts so consumers injecting
  // 'betterSidebar' are ready by the time the sidebar renders.
  const service = createBetterSidebarService(sidebarStore, workspaceWindows, keybindingRuntime)
  ctx.provide('betterSidebar', service)
  // Register the plugin's own built-in tabs and viewers through the same
  // service (eating our own dogfood). The disposer unregisters them on
  // fiber disposal (HMR-safe).
  ctx.effect(
    () => registerBuiltins(ctx, service),
    'dsh-better-sidebar: register built-in tabs and viewers',
  )
  // A failure anywhere in the client lifecycle must never take the app down
  // silently: log with the plugin prefix and pin a visible diagnostic strip
  // to the page so a blank panel is never the only symptom.
  const fail = (phase: string, error: unknown): void => {
    console.error(`[dsh-better-sidebar] ${phase} error:`, error)
    try {
      const bar = document.createElement('div')
      bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;'
        + 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;'
        + 'border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap'
      bar.textContent = `[dsh-better-sidebar] ${phase} error: ${error instanceof Error ? error.message : String(error)}`
      document.body.appendChild(bar)
    } catch {
      // Nothing left to report with.
    }
  }
  try {
    // Fresh chunk state for this activation: invalidate any chunk factories
    // registered by a previous fiber (HMR) and drop the in-memory load cache
    // so the next lazy open re-fetches the current chunk scripts.
    resetChunks()
    ctx.effect(() => {
      let disposed = false
      let root: Root | undefined
      let host: HTMLDivElement | undefined
      let mounted = false
      const unmount = (): void => {
        if (!mounted) return
        mounted = false
        root?.unmount()
        root = undefined
        host?.remove()
        host = undefined
      }
      const mount = (): void => {
        if (mounted || disposed) return
        try {
          host = document.createElement('div')
          host.setAttribute('data-dsh-better-sidebar', '')
          // The host must NEVER occupy document flow: everything inside is
          // fixed-positioned, but the right-click Menu (anchor wrapper span)
          // and any future inline content would otherwise push an empty
          // line box (≈18px) into the page and grow body → a page scrollbar.
          // fixed + full-bleed + click-through makes the host a zero-impact
          // root; the panels restore pointer-events on their own surfaces.
          //
          // z-index 40 is REQUIRED, not cosmetic: a fixed-positioned host
          // forms its own stacking context, so the panels' z-40 lives INSIDE
          // it and the host itself competes with the host app's UI at
          // z-index auto (0). The app's composer sits at z-1 — without an
          // explicit host z-index the bottom/right panels can never cover
          // the conversation area (regression after the host became fixed;
          // verified: even z-1000 on the panel does not win).
          host.style.cssText = 'position: fixed; inset: 0; z-index: 40; pointer-events: none;'
          document.body.appendChild(host)
          root = createRoot(host)
          root.render(createElement(RenderBoundary, { className: css.boundaryError }, createElement(Sidebar, { ctx, store: sidebarStore, windows: workspaceWindows })))
          mounted = true
        } catch (error) {
          fail('mount', error)
        }
      }
      const sync = async (): Promise<void> => {
        if (disposed) return
        // Resolve the user's side card prefs BEFORE the first session seeds,
        // so a brand-new conversation opens (or stays closed) at the chosen
        // width from first paint. A settings route failure falls back to the
        // schema defaults; the sidebar still mounts (a stalled wire gives up
        // after the timeout and mounts on the defaults).
        const prefs = await Promise.race([
          loadPrefs(api),
          new Promise<null>(resolve => { const timer = window.setTimeout(() => resolve(null), 2000) }),
        ])
        if (prefs !== null) sidebarStore.setPrefs(prefs)
        if (disposed) return
        // Mutual exclusion with the dsh-web-ui family right panel: while the
        // aionui-panel provider is selected, the sidebar must not mount at
        // all. Re-evaluated on every settings-document update (live switch).
        const suspended = await loadExternalDisable(api)
        if (disposed) return
        sidebarStore.setSuspended(suspended)
        if (suspended) unmount()
        else mount()
      }
      void sync()
      // Live re-evaluation: the runtime broadcasts settings-document updates
      // (the aionui card saves through the same document). Best effort —
      // deployments without the 'remote' service fall back to boot-time
      // evaluation only.
      const remote = ctx.get('remote') as { $on?: (event: string, listener: () => void) => () => void } | undefined
      const offRemote = remote?.$on?.('settings/document-updated', () => { void sync() })
      return () => {
        disposed = true
        offRemote?.()
        unmount()
      }
    }, 'dsh-better-sidebar: sidebar mount')

    ctx.effect(
      () => {
        try {
          return registerTurnTailInterception(ctx, sidebarStore)
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-better-sidebar: turn-tail interception',
    )

    ctx.effect(
      () => {
        try {
          return registerOpenPathInterception(ctx, sidebarStore)
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-better-sidebar: open-path interception',
    )

    ctx.effect(
      () => {
        try {
          // External http(s) links in the chat/GUI open the sidebar instead
          // of a new window. Gated on the browserInterceptLinks MASTER pref,
          // the URL's protocol flag (browserInterceptHttp / Https — https
          // defaults OFF: most https sites refuse iframe embedding), and the
          // target tab's enable switch; Ctrl/Cmd+click always bypasses. The
          // target is the first registered tab whose `urlTarget` claims the
          // URL (enabled tabs only), else the built-in browser tab.
          const urlTargetOf = (url: URL): string | undefined => {
            const prefs = sidebarStore.getPrefs()
            const enabled = service.getTabs().filter(tab => prefs.tabsEnabled[tab.id] !== false)
            return matchUrlTarget(enabled, url)?.id
          }
          return registerLinkInterception({
            takeoverEnabled: (url) => {
              if (sidebarStore.getSuspended()) return false
              const prefs = sidebarStore.getPrefs()
              if (prefs.browserInterceptLinks === false) return false
              const protocolOn = url.protocol === 'https:'
                ? prefs.browserInterceptHttps !== false
                : prefs.browserInterceptHttp !== false
              if (!protocolOn) return false
              // A plugin claim is the target (already enabled-filtered);
              // otherwise the built-in browser must be enabled.
              return urlTargetOf(url) !== undefined || prefs.tabsEnabled['browser'] !== false
            },
            openInSidebar: (url) => {
              let title: string | undefined
              try { title = new URL(url).hostname } catch { /* keep the default title */ }
              const type = urlTargetOf(new URL(url)) ?? 'browser'
              ctx.betterSidebar?.openTab({ type, url, title })
            },
            selfOrigin: window.location.origin,
          })
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-better-sidebar: link interception',
    )

    // The IME guard: composition keys (candidate arrows, confirm, cancel)
    // belong to the input method, never to page JS. Inlined third-party UI
    // (formerly Univer's office controls, #562 regression) has shipped
    // unguarded keydown handlers that hijack ArrowUp/ArrowDown and break
    // Chinese input; the document-capture guard neutralizes the whole class
    // before React or any native listener sees the event. Registered as
    // early as possible so no other capture-phase listener can win the
    // ordering race.
    ctx.effect(
      () => {
        try {
          return registerImeGuard()
        } catch (error) {
          fail('ime guard', error)
          return undefined
        }
      },
      'dsh-better-sidebar: IME composition guard',
    )

    // ── react-code-finder 对照试验（RCF_TRIAL=1 时启用）────────────────────
    // 直接试用 @react-code-finder/core 的 Inspector（不依赖 dsh-code-finder）：
    // 对比「现成工具 vs 自研」在 DSH 生产宿主（react-dom.production.min.js，
    // 无 _debugSource）下的实际效果。预期：fiber 遍历可用 → 能显示组件名；
    // 但 _debugSource 缺失 → 无 file:line（这正是 dsh-code-finder 构建期注入
    // 要补的差距）。仅 dev 构建 + 环境开关，生产/默认构建 dead-code 消除。
    ctx.effect(
      () => {
        if (process.env.NODE_ENV !== 'development') return undefined
        if (process.env.RCF_TRIAL !== '1') return undefined
        let handle: { destroy(): void } | null = null
        let disposed = false
        void import('@react-code-finder/core')
          .then(({ Inspector }) => {
            if (disposed) return
            const inspector = new Inspector({
              enabled: true,
              showNoSource: true,
              debug: true,
              buttonPosition: 'bottom-right',
            })
            inspector.init()
            handle = { destroy: () => inspector.destroy() }
          })
          .catch((error) => fail('react-code-finder trial', error))
        return () => {
          disposed = true
          handle?.destroy()
        }
      },
      'dsh-better-sidebar: react-code-finder trial',
    )

    // The keybinding runtime (⌘B / ⌘J / ⌘⌥B panel toggles, ⌘P quick open,
    // ⌘F search focus, ⌘Tab / ⌘1…9 tab keys — and every plugin
    // registration): one document-capture dispatcher with the shared
    // IME/AltGr/repeat guards and a per-event context. The built-ins
    // register through the same API plugins use; the left sidebar toggle
    // resolves ui-layout's ctx.layout lazily like 'conversation'. A strict
    // no-op without a current session (the store reduce is the gate).
    ctx.effect(
      () => {
        try {
          const disposeBindings = registerBuiltinKeybindings(keybindingRuntime, ctx, sidebarStore)
          const disposeAttach = keybindingRuntime.attach()
          return () => {
            disposeBindings()
            disposeAttach()
          }
        } catch (error) {
          fail('keybindings', error)
          return undefined
        }
      },
      'dsh-better-sidebar: keybindings',
    )

    // DSH 0.1.x does not yet carry an icon through the settings.section
    // registration contract: its shell renders a generic gear for every
    // external section. Mark only this plugin's localized nav row so
    // layout.css can paint the requested Side card SVG; the disposer clears
    // the marker for HMR / plugin disable.
    ctx.effect(
      () => registerSettingsNavIcon(() => t('settingsNav')),
      'dsh-better-sidebar: settings navigation icon',
    )

    // The "Side card" settings section: appears in the DSH Settings shell
    // once the shell's declaration is on the ledger (slots.inject waits for
    // it); the section reads/writes the prefs through the plugin's own
    // fenced settings route, keeps the shared store in sync, and renders the
    // declarative enable/disable inventory from the tab/viewer registry.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'better-sidebar',
      order: 100,
      label: () => t('settingsNav'),
      inject: () => ({ store: sidebarStore, service }),
    }, SideCardSection))

    // The official LEFT sidebar footer action: inject the "Global info"
    // entry into DSH's own ui-sidebar foot (the additive sidebar.footer.action
    // seat). The button opens the `global` tab — the page recording all
    // instance-level global info (incl. the global-shared terminals). The
    // inject waits for the official declaration and the disposer rides the
    // fiber (HMR-safe); a host without the slots service degrades to no-op.
    registerOfficialSidebarEntry(ctx)
  } catch (error) {
    fail('load', error)
  }
}
