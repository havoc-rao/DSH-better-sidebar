/**
 * The interactive terminal: xterm.js rendered against an injectable
 * TRANSPORT (a connection layer), defaulting to a WebSocket to the host pty
 * (see terminal-transport.ts — the default {@link localTransport} keeps the
 * historical behavior byte for byte: host transcript replay on connect,
 * live streaming, `{type:'resize'}` frames, automatic reconnect on
 * transient drops, a server-side refusal (close code 1011 with a reason,
 * e.g. a failed pty spawn) stops the loop and shows the reason with a
 * manual retry, and repeated unreasoned failures surface the close code
 * after three attempts, so the banner never spins forever).
 *
 * The view itself owns everything UI: the connected/fatal state machine,
 * the banners + retry, the block tracker (Enter-separated "add to
 * conversation" blocks), the selection popup, the info bar (title frames),
 * fit/theme/font, openWhenSized, visibility re-fit and onTitleChange
 * routing. A consumer plugin (e.g. dsh-remote) injects its own transport
 * — a remote SSH PTY channel — through the `transport` prop; the default
 * view behavior is unchanged when no transport is injected.
 *
 * Transport lifecycle on unmount (the VIEW decides which branch applies
 * from the store/scope state; each transport implements what the branch
 * means for its channel):
 * - user closed the tab → `handle.close()` (the local transport sends
 *   `{type:'close'}`, killing the pty immediately / quota released),
 * - user switched to another conversation (tab still open in its session)
 *   → `handle.park()` (local: `{type:'park'}` — the host keeps the pty
 *   alive indefinitely, so switching back reattaches the SAME shell),
 * - same-session unmount (page refresh, crash, plugin teardown, re-render)
 *   → bare `handle.dispose()` (local: bare socket drop — the host's
 *   reconnect grace keeps the shell alive for a quick reconnect),
 * - agent terminals (tabId `agent:...`) follow the close-frame rule and
 *   never park (their lifetime is owned by the agent).
 *
 * The host replays the session's transcript on connect, then streams live
 * output; input frames are raw text, resize frames are JSON with
 * type:"resize".
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { writeClipboard, IconFolderOpen16 } from '@deepseek-ai/dsh-client-ui-primitives'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { t } from './locales.ts'
import { IconTerminalOutline16 } from './icons.tsx'
import { openWhenSized } from './open-when-sized.ts'
import type { SessionScope } from './api.ts'
import { isAgentTabId, type SidebarStore } from './state.ts'
import { isMacPlatform } from './keybindings.ts'
import { isDarkScheme, subscribeColorScheme, effectiveTokenValue, tokenValue } from './theme.ts'
import { resolveTerminalFont } from './terminal-font.ts'
import { generatePalette } from './generate-palette.ts'
import { createThrottledFit } from './throttled-fit.ts'
import { appendToDraft } from './conversation-draft.ts'
import {
  TerminalBlockTracker,
  blockForSelection,
  blockOutputText,
  blockSpanLines,
  buildTerminalInsert,
  type TerminalBlock,
} from './terminal-blocks.ts'
import { TerminalBlockOverlay } from './TerminalBlockOverlay.tsx'
import {
  localTransport,
  type TerminalDepsInfo,
  type TerminalTransport,
  type TerminalTransportHandle,
} from './terminal-transport.ts'
import type { Context } from '../context-types.ts'
import css from './sidebar.module.css'

// The frame parser + wire constants live with the transport layer now (both
// the client exports and the lazy chunk can import them); re-exported from
// here so existing importers (tests, consumers of TerminalView.tsx) keep
// resolving the same symbols.
export { parseDownlinkFrame, FAILURE_LIMIT, PTY_DEPS_MISSING } from './terminal-transport.ts'
export type { TerminalTransport, TerminalTransportHandle, TerminalTransportSession, TerminalTransportSurface } from './terminal-transport.ts'

/**
 * Whether a host title frame may RETITLE the terminal tab: only a non-empty
 * title — the first token of a SETTLED CLI command (`npm run dev` → `npm`)
 * — replaces the tab name. The host replays `title: ''` on every attach
 * (its "no command settled yet" state, see {@link digestCommandInput}), and
 * that must never overwrite the tab's DEFAULT name (终端): the default
 * stays until a CLI actually runs inside, then the name is replaced. The
 * info bar is unaffected — `cwd` / `command` follow every frame regardless.
 * Exported for the regression tests (tests/command-title.spec.ts).
 */
export function shouldRetitleTerminal(title: string): boolean {
  return title !== ''
}

/**
 * Curated ANSI palettes for the terminal. The surface colors (background,
 * foreground, cursor, selection) ride the theme tokens so the terminal
 * blends with the panel in both schemes; the 16 ANSI colors are the same
 * designed palettes the app's code surfaces use (one-dark family for dark,
 * one-light family for light), read live so a scheme flip re-themes in
 * place.
 */
const ANSI_DARK: Record<string, string> = {
  black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
  brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
  brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
  brightCyan: '#56b6c2', brightWhite: '#ffffff',
}

const ANSI_LIGHT: Record<string, string> = {
  black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
  blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#a0a1a7',
  brightBlack: '#4f525e', brightRed: '#e45649', brightGreen: '#50a14f',
  brightYellow: '#c18401', brightBlue: '#0184bc', brightMagenta: '#a626a4',
  brightCyan: '#0997b3', brightWhite: '#fafafa',
}

/**
 * The xterm theme for the current scheme (surface from tokens, ANSI curated).
 */
function xtermTheme(): ITheme {
  const dark = isDarkScheme()
  // Skin systems set --dsw-alias-bg-base to `transparent` or translucent
  // glass values (the dsh-web-ui skins use rgba 0.16–0.7); effectiveTokenValue
  // treats those as unset below the opacity floor, so the opaque fallback
  // engages and the terminal never renders see-through over the skin's
  // backdrop (issue #90). Effectively opaque scoped surfaces (e.g. a skin's
  // 0.96 porcelain) pass through — the skin still controls the terminal.
  const background = effectiveTokenValue('--dsw-alias-bg-base') || (dark ? '#111114' : '#ffffff')
  const foreground = effectiveTokenValue('--dsw-alias-label-primary') || (dark ? '#e6e6e6' : '#1a1a1a')
  const base = dark ? ANSI_DARK : ANSI_LIGHT
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)',
    ...base,
    // 256-color harmonization (ported from tabby-terminal's generatePalette,
    // MIT): LAB-interpolate the 16 curated colors + the surface bg/fg into
    // indices 16–255, so 256-color programs (htop, vim truecolor gradients)
    // render a palette in tune with the scheme instead of the browser
    // default ramp. Recomputed on every scheme flip like the 16 colors.
    extendedAnsi: generatePalette(Object.values(base), background, foreground, false),
  }
}

/** The floating "add to conversation" action: payload + viewport anchor
 *  (the selection-mode port of the text viewers' popup — the block mode is
 *  the hover-driven overlay layer, see {@link TerminalBlockOverlay}). */
interface SelectionPopup {
  insert: string
  left: number
  top: number
}

/** The live terminal session handed to the block overlay (state, so the
 *  overlay re-mounts per session instead of chasing refs). */
interface TerminalSession {
  term: Terminal
  tracker: TerminalBlockTracker
}

export function TerminalView(props: {
  /** The client context (the "add to conversation" draft lives on it). */
  ctx: Context
  scope: SessionScope
  tabId: string
  store: SidebarStore
  /** Host-downlink command-title updates (the tab title follows the running
   *  command's first token). The caller routes it through updateTab so both
   *  local tabs (patchTab) and workspace-bound stubs (windows store →
   *  every session) retitle. NEVER called with an empty title: the host's
   *  "no CLI settled yet" attach replay (`title: ''`) is filtered out here,
   *  so the tab's default name (终端) survives until a CLI actually runs. */
  onTitleChange?: (title: string) => void
  /** Whether this is the active tab with the panel open. Hidden tabs stay
   *  mounted (display:none); flipping back to visible forces a re-fit +
   *  repaint so the canvas never comes back blank (tabby's reactivate
   *  pattern). Absent = always visible (standalone/test callers). */
  visible?: boolean
  /** Render the box's info bar (cwd + running CLI) above the terminal —
   *  the Global Workspace's bottom workbench boxes use it. */
  infoBar?: boolean
  /** The connection layer behind this terminal. Absent → localTransport
   *  (the local pty WS — the historical behavior, byte for byte). Read ONCE
   *  at mount like onTitleChange: pass a stable instance (a module-level
   *  singleton); swapping it requires remounting the view. */
  transport?: TerminalTransport
}) {
  const { ctx, scope, tabId, store, onTitleChange, visible = true, infoBar = false, transport } = props
  const hostRef = useRef<HTMLDivElement>(null)
  // onTitleChange is a fresh closure on every parent render (the tab
  // descriptor builds it inline) — it must NEVER ride the effect deps: a
  // title update flows back into updateTab → store change → re-render →
  // new closure → effect restart → xterm dispose + reconnect LOOP (and a
  // dispose/rebuild race in a zero-size container crashes the Viewport:
  // "Cannot read properties of undefined (reading 'dimensions')"). The ref
  // keeps the effect stable while the latest callback stays reachable.
  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange
  // Same rule for the transport: mount binds ONE connection layer (an
  // inline `transport={{...}}` expression in JSX must not tear the shell
  // down on every parent render).
  const transportRef = useRef<TerminalTransport | undefined>(transport)
  transportRef.current = transport
  const [connected, setConnected] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const [depsFatal, setDepsFatal] = useState<TerminalDepsInfo | null>(null)
  const [lastUrl, setLastUrl] = useState<string | null>(null)
  /** The info bar payload (cwd + running CLI), fed by host title frames. */
  const [info, setInfo] = useState<{ cwd?: string; command?: string } | null>(null)
  /** The live transport handle (the view's only channel into the session). */
  const handleRef = useRef<TerminalTransportHandle | null>(null)
  /** The banner retry action (published by the main effect); visibility
   *  changes never restart the terminal effect, so the buttons read it
   *  through the ref (same pattern as refreshRef). */
  const retryRef = useRef<(() => void) | null>(null)
  // Re-fit + repaint when the tab becomes visible again (the canvas can come
  // back stale/blank after a display:none stay). The main effect publishes
  // the live refresh closure here so visibility changes never restart the
  // whole terminal effect.
  const refreshRef = useRef<(() => void) | null>(null)
  /** Live xterm + block tracker handles (set by the mount effect, read by
   *  the popup commits so the payload is always built at click time). */
  const termRef = useRef<Terminal | null>(null)
  const trackerRef = useRef<TerminalBlockTracker | null>(null)
  /** The mounted terminal session (null until the mount effect ran); the
   *  block overlay mounts on it. */
  const [session, setSession] = useState<TerminalSession | null>(null)
  /** The floating "add to conversation" popup for a selection (null = hidden). */
  const [selectionPopup, setSelectionPopup] = useState<SelectionPopup | null>(null)
  /** Live mirror of the popup state for click-time reads (no re-render race). */
  const selectionPopupRef = useRef<SelectionPopup | null>(null)

  const hideSelectionPopup = (): void => {
    selectionPopupRef.current = null
    setSelectionPopup(null)
  }

  /** Anchor the popup above the selection head; clamp inside the viewport. */
  const showSelectionPopup = (insert: string, left: number, top: number): void => {
    const next: SelectionPopup = {
      insert,
      left: Math.min(Math.max(left, 80), window.innerWidth - 80),
      top,
    }
    selectionPopupRef.current = next
    setSelectionPopup(next)
  }

  /** The selection popup's click: insert the stored payload into the draft. */
  const commitSelectionPopup = (): void => {
    const current = selectionPopupRef.current
    if (current === null) return
    appendToDraft(ctx, scope.sessionId, current.insert)
    hideSelectionPopup()
  }

  /** The block overlay pill's click: build THE hovered block's payload live
   *  (command + its output rows, marker-resolved boundaries) and insert it
   *  into the draft. */
  const commitBlock = (block: TerminalBlock): void => {
    const tracker = trackerRef.current
    const term = termRef.current
    if (tracker === null || term === null) return
    const buffer = term.buffer.active
    const span = blockSpanLines(tracker.blocks, block, buffer.length)
    const output = blockOutputText(buffer, block, tracker.pending, span.end)
    appendToDraft(ctx, scope.sessionId, buildTerminalInsert(block.command, output))
  }

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    // A (re)mount starts with a clean block model: the replay/resumed
    // transcript has no input history, and any stale popup from a previous
    // session must not survive.
    hideSelectionPopup()

    // The custom font prefs (side card settings, terminal card) resolve at
    // mount; store changes re-apply them live below.
    const font = resolveTerminalFont(store.getPrefs(), tokenValue('--ds-font-family-code'))
    const term = new Terminal({
      cursorBlink: true,
      fontSize: font.fontSize,
      fontFamily: font.fontFamily,
      allowTransparency: true,
      convertEol: false,
      scrollback: 4000,
      theme: xtermTheme(),
    })
    // ⌥↓ must SCROLL to the bottom (the muscle memory most terminals share),
    // not reach the shell as an Alt-modified escape sequence (`ESC[1;3B`)
    // that bash/zsh echo back as garbage. Intercept before xterm's key
    // evaluation: returning false keeps the chord out of the pty input path
    // entirely. macOS only — Option is the Mac spelling of Alt; on other
    // platforms Alt+arrows stay free for shell bindings.
    if (isMacPlatform()) {
      term.attachCustomKeyEventHandler((event) => {
        if (
          event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
          && event.code === 'ArrowDown'
        ) {
          event.preventDefault()
          term.scrollToBottom()
          return false
        }
        return true
      })
    }
    // The block model: every Enter in the input stream submits a command and
    // opens a new block anchored at the shell's echo row (terminal-blocks.ts).
    // Each block pins that row with an xterm marker — markers slide with
    // scrollback trims and reflows, keeping the bloc UI honest over time.
    const tracker = new TerminalBlockTracker((block) => {
      const marker = term.registerMarker(0)
      if (marker !== undefined) block.marker = marker
    })
    termRef.current = term
    trackerRef.current = tracker
    setSession({ term, tracker })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Re-theme in place when the app's scheme flips (tokens + palette).
    const applyTheme = (): void => {
      term.options.theme = xtermTheme()
      term.refresh(0, term.rows - 1)
    }
    const schemeSub = subscribeColorScheme(applyTheme)

    // The connection layer: this mount's transport (absent → the default
    // local pty WS). The socket / frames / reconnect loop live INSIDE the
    // transport; the view only translates its callbacks into the
    // connected/fatal/title state machine and forwards input + resize.
    const transport = transportRef.current ?? localTransport

    /** Open one transport session for this mount (first open + the banner
     *  retry fallback when the handle has no `retry`). */
    const openSession = (): void => {
      handleRef.current?.dispose()
      let handle: TerminalTransportHandle
      try {
        handle = transport.open({
          term,
          scope,
          tabId,
          cwd: scope.cwd,
          onOutput: (data) => {
            try {
              term.write(data)
            } catch {
              // The view is already torn down (a late write from a custom
              // transport); xterm throws after dispose — swallow.
            }
          },
          onTitle: (title, info) => {
            // An EMPTY title is the host's "no CLI settled yet" attach
            // replay — it must never overwrite the tab's default name (终端).
            // Only a settled CLI's first token replaces the name; the info
            // bar still follows every frame.
            if (shouldRetitleTerminal(title)) onTitleChangeRef.current?.(title)
            if (info !== undefined) setInfo(info)
          },
          onConnected: (connected) => {
            if (connected) {
              setConnected(true)
              setFatal(null)
            } else {
              setConnected(false)
            }
          },
          onFatal: (reason, detail) => {
            // The pty-deps repair banner is the LOCAL transport's reporting
            // channel; any other fatal rides the plain banner + retry.
            if (detail?.deps !== undefined) {
              setFatal(null)
              setDepsFatal(detail.deps)
            } else {
              setFatal(reason)
            }
          },
          onEndpoint: (endpoint) => setLastUrl(endpoint),
        })
      } catch (error) {
        // A broken custom transport must not take down the tab tree: pin
        // the fatal banner with the retry affordance instead.
        console.error('[dsh-better-sidebar] terminal transport open failed:', error)
        setFatal(t('terminalConnectFailed'))
        return
      }
      handleRef.current = handle
    }
    openSession()

    // The banner retry: the transport's own retry when it has one (one
    // fresh connection attempt); absent — tear down and open a fresh
    // session (transports may treat a fatal as session-ending).
    retryRef.current = (): void => {
      const handle = handleRef.current
      if (handle?.retry !== undefined) {
        handle.retry()
        return
      }
      handleRef.current = null
      handle?.dispose()
      openSession()
    }

    // Reflows are rate-limited (see throttled-fit.ts): ResizeObserver fires
    // every frame during a panel drag — each fit + pty resize would be a
    // SIGWINCH storm and visible drag flicker. One trailing fit per 32ms
    // window, with an explicit repaint after fit to close the blank-frame
    // gap while the renderer re-uploads its drawing buffer.
    const reflow = createThrottledFit(() => {
      try {
        fit.fit()
        term.refresh(0, term.rows - 1)
        handleRef.current?.resize(term.cols, term.rows)
      } catch {
        // The terminal may be mid-dispose; ignore.
      }
    })
    // The visibility refresh closure (see refreshRef): fit + repaint when the
    // tab is shown again. Guarded on term.element (set by open) so a
    // visibility flip before the deferred open is a safe no-op.
    refreshRef.current = (): void => {
      try {
        if (term.element !== undefined) {
          fit.fit()
          term.refresh(0, term.rows - 1)
          handleRef.current?.resize(term.cols, term.rows)
        }
      } catch {
        // The terminal may be mid-dispose; ignore.
      }
    }

    // The input stream feeds BOTH the transport and the block model: every
    // Enter submits the echo-row-anchored command block (terminal-blocks.ts).
    const inputSub = term.onData((data) => {
      tracker.onData(data, term.buffer.active.length)
      handleRef.current?.input(data)
    })
    // Selection → the floating "add to conversation" popup (the shared
    // selectionPopup chrome anchored at the selection head; same contract as
    // the text viewers' portaled button). The DOM renderer paints the
    // selection segments when the change lands, so the anchor rects are read
    // on the next frame. Scrolling hides the popup (same rule as the editors).
    let selectionFrame: number | undefined
    const selectionSub = term.onSelectionChange(() => {
      window.cancelAnimationFrame(selectionFrame ?? 0)
      const selected = term.getSelection()
      if (selected === '' || selected.trim() === '') {
        hideSelectionPopup()
        return
      }
      const range = term.getSelectionPosition()
      if (range === undefined) {
        hideSelectionPopup()
        return
      }
      selectionFrame = window.requestAnimationFrame(() => {
        if (handleRef.current === null) return
        const firstSegment = host.querySelector('.xterm-selection > div:first-child')
        if (firstSegment === null) {
          hideSelectionPopup()
          return
        }
        const rect = firstSegment.getBoundingClientRect()
        const command = blockForSelection(tracker.blocks, range.start.y - 1)?.command
        showSelectionPopup(
          buildTerminalInsert(command, selected),
          rect.left + rect.width / 2,
          rect.top,
        )
      })
    })
    const scrollSub = term.onScroll(() => hideSelectionPopup())
    const observer = new ResizeObserver(() => { reflow.schedule() })
    observer.observe(host)

    // Custom font prefs (the terminal card's secondary settings) apply LIVE:
    // on any store change re-resolve and diff the two options, re-fitting
    // when they moved (the grid dimensions may change with the font). The
    // subscribe fires on every store change (tabs, panels…), so the diff is
    // what keeps this cheap.
    const fontSub = store.subscribe(() => {
      const next = resolveTerminalFont(store.getPrefs(), tokenValue('--ds-font-family-code'))
      if (next.fontFamily !== term.options.fontFamily || next.fontSize !== term.options.fontSize) {
        term.options.fontFamily = next.fontFamily
        term.options.fontSize = next.fontSize
        reflow.schedule()
      }
    })

    // The terminal must not be opened in a zero-size container: xterm's
    // renderer creation fails there and the next Viewport refresh crashes
    // reading `.dimensions` off the undefined renderer (blank terminal on
    // WKWebView when the bottom panel's expand slide leaves the host at
    // height 0; any display:none-hidden ancestor does the same). Defer
    // open+fit until the host has a real size — writes arriving meanwhile
    // are buffered by xterm's WriteBuffer and render once open, and
    // FitAddon.fit() is a safe no-op before open. The resize here covers
    // the deferred path where the transport may already be open with the
    // default 80x24 dims.
    const cancelOpen = openWhenSized(host, () => {
      try {
        term.open(host)
        fit.fit()
        handleRef.current?.resize(term.cols, term.rows)
      } catch (error) {
        console.error('[dsh-better-sidebar] xterm open failed:', error)
      }
    })

    return () => {
      cancelOpen()
      reflow.cancel()
      refreshRef.current = null
      retryRef.current = null
      window.cancelAnimationFrame(selectionFrame ?? 0)
      observer.disconnect()
      fontSub()
      schemeSub()
      inputSub.dispose()
      selectionSub.dispose()
      scrollSub.dispose()
      // Three unmount cases, distinguished by the store's tab/open state and
      // the active session id (the VIEW decides which branch applies; each
      // transport implements what close/park/bare-drop mean for its
      // channel):
      // 1. The tab was closed by the user (NOT in its session's state):
      //    close() — the host releases the pty immediately.
      // 2. The user switched to another conversation (the tab IS still open
      //    in scope.sessionId's state, but the active session is now a
      //    different one): park() — the host keeps the pty alive
      //    indefinitely (no grace countdown), so switching back reattaches
      //    the SAME shell. Without this, the bare drop would start the 30s
      //    reconnect-grace countdown and kill the shell while the user is
      //    still actively working in the other session.
      // 3. A same-session unmount (page refresh, crash, plugin teardown, a
      //    re-render that re-mounts the view): bare dispose() — the host's
      //    reconnect grace keeps the shell alive for a quick reconnect.
      // Agent terminals follow the close-frame rule; their lifetime is owned
      // by the agent, so a bare drop (case 3) already leaves them alive
      // indefinitely — no park frame needed.
      const tabStillOpen = store.tabOpen(scope.sessionId, tabId)
      const sessionSwitched = store.getSnapshot().sessionId !== scope.sessionId
      if (!tabStillOpen) handleRef.current?.close()
      else if (sessionSwitched && !isAgentTabId(tabId)) handleRef.current?.park()
      handleRef.current?.dispose()
      handleRef.current = null
      term.dispose()
      termRef.current = null
      trackerRef.current = null
      setSession(null)
      hideSelectionPopup()
    }
  }, [scope.sessionId, scope.cwd, tabId, store])

  // Re-fit + repaint when the tab becomes visible again (refreshRef is
  // published by the main effect above; flipping visible never restarts it).
  useEffect(() => {
    if (visible) refreshRef.current?.()
  }, [visible])

  return (
    <div className={css.terminalWrap}>
      {depsFatal !== null && (
        <TerminalDepsBanner deps={depsFatal} onRetry={() => { setDepsFatal(null); retryRef.current?.() }} />
      )}
      {fatal !== null && (
        <div className={css.terminalBanner}>
          {t('terminalError')}: {fatal}
          {lastUrl !== null && <div className={css.terminalBannerUrl}>{lastUrl}</div>}
          <button
            type="button"
            className={css.terminalRetry}
            onClick={() => { setFatal(null); retryRef.current?.() }}
          >
            {t('terminalRetry')}
          </button>
        </div>
      )}
      {fatal === null && depsFatal === null && !connected && <div className={css.terminalBanner}>{t('disconnected')}</div>}
      {infoBar && info !== null && (
        <div className={css.terminalInfoBar}>
          {info.cwd !== undefined && (
            <span className={css.terminalInfoCwd} title={info.cwd}>
              <IconFolderOpen16 size={14} />
              <span className={css.terminalInfoCwdName}>{baseNameOf(info.cwd)}</span>
            </span>
          )}
          {info.command !== undefined && info.command !== '' && (
            <span className={css.terminalInfoCli} title={info.command}>
              <IconTerminalOutline16 size={12} />
              <span className={css.terminalInfoCliText}>{info.command}</span>
            </span>
          )}
        </div>
      )}
      <div ref={hostRef} className={css.terminal}>
        {/* The block layer: hairline dividers at every CLI block boundary;
            hovering a block highlights its span and raises the per-block
            "add to conversation" pill (see TerminalBlockOverlay). */}
        {session !== null && (
          <TerminalBlockOverlay
            hostRef={hostRef}
            term={session.term}
            tracker={session.tracker}
            visible={connected && fatal === null && depsFatal === null}
            onAddBlock={commitBlock}
          />
        )}
      </div>
      {/* Selection mode: portalled to document.body and position:fixed, so
          the terminal's overflow clips cannot crop it (same as TextEditor). */}
      {selectionPopup !== null && createPortal(
        <button
          type="button"
          className={css.selectionPopup}
          style={{ left: selectionPopup.left, top: selectionPopup.top }}
          // Keep the selection alive until the click commits.
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={commitSelectionPopup}
        >
          {t('addToConversation')}
        </button>,
        document.body,
      )}
    </div>
  )
}

/** The last path segment of a directory (the info bar's compact "project
 *  dir" label); falls back to the raw path. */
function baseNameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1]! : path
}

/**
 * The node-pty dependency failure banner (issue #140): explains that the
 * terminal's native dependency failed to load and shows the PASTEABLE repair
 * command (bash / cmd / PowerShell) with a copy button — the user pastes it
 * into a terminal where their DSH profile lives and runs it, then retries.
 * Extracted as a standalone component for direct testing. Raised ONLY by
 * the local transport's pty-deps-missing path (remote transports report
 * plain fatals).
 */
export function TerminalDepsBanner(props: { deps: TerminalDepsInfo; onRetry: () => void }) {
  const { deps, onRetry } = props
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    const written = await writeClipboard(deps.command)
    if (written) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }
  return (
    <div className={css.terminalDepsBanner}>
      <div className={css.terminalDepsTitle}>{t('terminalDepsFailed')}</div>
      <div className={css.terminalDepsHint}>
        {t('terminalDepsHint')}
        {deps.profile !== null ? t('terminalDepsProfile', { profile: deps.profile }) : ''}
      </div>
      <div className={css.terminalDepsCommandRow}>
        <pre className={css.terminalRepairCommand}>{deps.command}</pre>
        <button type="button" className={css.terminalRetry} onClick={() => { void copy() }} aria-label={t('copy')}>
          {copied ? t('copied') : t('copy')}
        </button>
      </div>
      {deps.note !== undefined && <div className={css.terminalDepsNote}>{deps.note}</div>}
      <div className={css.terminalDepsActions}>
        <button type="button" className={css.terminalRetry} onClick={onRetry}>
          {t('terminalRetry')}
        </button>
      </div>
    </div>
  )
}