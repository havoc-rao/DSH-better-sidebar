/**
 * The terminal's DATA SOURCE slot (feature `'terminalSource'`): the seam
 * through which a plugin (e.g. dsh-remote) can take over the DEFAULT
 * terminal tab — the `terminal:<uuid>` tabs minted by the built-in
 * descriptor (src/client/builtins/tabs.tsx), the term rendered in
 * TerminalView's `hostRef` div — as its own connection layer, while the
 * view's UI (xterm rendering, block overlay, selection popup, info bar,
 * banner state machine, fit/theme/font) stays exactly as it is.
 *
 * Contract in one sentence: a terminal tab resolves its connection layer
 * through the registry — the FIRST provider whose `match` accepts the
 * (session, cwd, tab) triple hands back a {@link TerminalTransport} (a
 * factory returning one of the view's existing transports, never a second
 * wire protocol), and TerminalView receives it through the `transport`
 * prop it already knows. No provider matches (or none is registered) →
 * the tab mounts with NO transport prop → the default {@link localTransport}
 * (the local pty WebSocket) — byte for byte the historical behavior.
 *
 * Resolution is pure and throwing-safe, mirroring file-tree-source.ts:
 * providers are consulted in registration order — FIRST match wins, later
 * registrations never shadow an earlier one. A provider whose `match`
 * throws is skipped (console.error); a matched provider whose
 * `createTransport` throws — or deliberately returns `undefined` (a
 * per-tab refusal) — is skipped too and the next provider gets its turn.
 * No match and no surviving transport → `undefined` = the default local
 * path.
 *
 * Timing semantics: TerminalView reads its `transport` prop ONCE at mount
 * (its own documented contract), so the resolution only needs to be right
 * at mount time — a provider registering LATER affects terminals mounted
 * afterwards (new tabs / remounts), never hot-swaps an open one. The
 * render-side hook subscribes to the registry so a tab still waiting for
 * its lazy chunk (or the newly pinned / auto-opened surfaces) picks up a
 * provider that registered meanwhile.
 *
 * Coverage: every default-terminal surface renders through the built-in
 * terminal descriptor — plain `terminal:<uuid>` tabs, agent-terminal
 * auto-tabs (`agent:<uuid>` — a provider decides whether it owns those),
 * bottom-panel auto-terminals, and pinned virtual terminals (rendered
 * with the HOME session's scope, so a pinned terminal follows its home
 * session's provider). The instance-level GLOBAL shared terminals
 * (`gb:` windows on the global-workspace surface) are intentionally NOT
 * resolved here — they are host shared-PTY windows, not session
 * terminals, and keep the local transport.
 */
import { useEffect, useMemo, useReducer } from 'react'
import type { Context } from '../context-types.ts'
import type { TerminalTransport } from './terminal-transport.ts'

/**
 * One registered terminal source provider (the registration descriptor).
 * Register through `ctx.betterSidebar.registerTerminalProvider` — returns
 * a disposer (Cordis `ctx.effect` HMR-safe), duplicate ids throw.
 *
 * The core payload is an existing {@link TerminalTransport} contract: the
 * factory returns (or closes over) a transport instance, which flows
 * verbatim into TerminalView's `transport` prop. There is deliberately no
 * second frame/wire protocol here — every lifecycle branch the transport
 * owns (close / park / dispose / retry, resize frames, transcripts) keeps
 * the semantics TerminalView already documents.
 */
export interface TerminalProviderDescriptor {
  /** Unique id (package-prefixed, e.g. 'dsh-remote'). Registering a
   *  duplicate id throws. */
  id: string
  /** Session/tab predicate: does this provider own the given terminal tab?
   *  First match wins, consulted in registration order. All three arguments
   *  arrive VERBATIM (no path/session conversion happens on the host side):
   *  - `sessionId`: the tab's session (for pinned virtual tabs this is the
   *    HOME session — a pinned terminal follows its home session's source);
   *  - `cwd`: the session working directory when known;
   *  - `tabId`: the full tab id — `terminal:<uuid>` for plain tabs,
   *    `agent:<uuid>` for agent-owned terminals (a provider that does not
   *    want the model's terminals returns false on that prefix).
   *  A throwing `match` skips this provider (console.error). */
  match(sessionId: string, cwd: string | undefined, tabId: string): boolean
  /** Factory for the connection layer a matching tab mounts. Returning
   *  undefined REFUSES the takeover (the next provider gets its turn — the
   *  per-tab escape hatch); throwing is treated the same way. Keep it
   *  cheap: it is invoked per resolving render of the terminal tab, and
   *  returning a stable instance (a module-level transport or one cached
   *  per session) is the recommended shape — one transport can own many
   *  tabs through its `open(session)` handles. */
  createTransport(sessionId: string, cwd: string | undefined, tabId: string): TerminalTransport | undefined
}

/**
 * Resolve the connection layer of one terminal tab against a provider
 * list (registration order; first `match` whose `createTransport` returns
 * a transport wins). Throwing `match` / `createTransport` and an explicit
 * `undefined` factory result skip that provider; no match resolves
 * `undefined` — the caller then mounts WITHOUT a `transport` prop, i.e.
 * the default localTransport (byte for byte the historical behavior).
 * Pure: no React, no registry access, fully unit-testable.
 */
export function resolveTerminalSource(
  providers: readonly TerminalProviderDescriptor[],
  sessionId: string,
  cwd: string | undefined,
  tabId: string,
): TerminalTransport | undefined {
  for (const provider of providers) {
    let matched = false
    try {
      matched = provider.match(sessionId, cwd, tabId) === true
    } catch (error) {
      console.error('[dsh-better-sidebar] terminal provider match error:', error)
      continue
    }
    if (!matched) continue
    try {
      const transport = provider.createTransport(sessionId, cwd, tabId)
      if (transport === undefined) continue
      return transport
    } catch (error) {
      console.error('[dsh-better-sidebar] terminal provider createTransport error:', error)
      continue
    }
  }
  return undefined
}

/**
 * The render-side resolver hook: the connection layer a terminal tab in
 * this session should mount, or undefined for the default localTransport.
 * Live: re-resolves when the provider registry changes (a provider
 * registers/unregisters while a terminal tab is mounted — e.g. a plugin
 * activates after the panel exists) and when the session/cwd/tab changes.
 * The built-in terminal descriptor's wrapper passes the result as
 * TerminalView's `transport` prop; TerminalView reads it once at mount,
 * so the live re-resolution only affects tabs that mount afterwards.
 * A scope-less mount (`sessionId` undefined — the descriptor invoked bare
 * in tests etc.) always resolves undefined: a provider takeover requires
 * a session. Registry-less service stubs (tests, hosts without the full
 * service) degrade to the local path — a stub must never break the
 * terminal.
 */
export function useTerminalTransport(
  ctx: Context | undefined,
  sessionId: string | undefined,
  cwd: string | undefined,
  tabId: string,
): TerminalTransport | undefined {
  const service = ctx?.betterSidebar
  // The tick is the SUBSCRIPTION state (same pattern as useFileTreeSource):
  // the reducer's dispatch (`force`) is stable, so the memo below must
  // depend on the tick itself — otherwise a registry notification
  // re-renders the terminal tab but never re-resolves the source, and a
  // provider registering after the tab opened would never be seen.
  const [tick, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (service === undefined) return
    const offs: Array<() => void> = []
    try { offs.push(service.subscribe(force)) } catch { /* registry-less stub */ }
    return () => { for (const off of offs) off() }
  }, [service, force])
  return useMemo(() => {
    // No registry — or no session to resolve against (a scope-less mount,
    // e.g. the descriptor invoked bare in tests) — means the default
    // localTransport path; a provider takeover always requires a session.
    if (service === undefined || sessionId === undefined) return undefined
    try {
      return resolveTerminalSource(service.getTerminalProviders(), sessionId, cwd, tabId)
    } catch {
      // A registry-less / partial service stub must not break the terminal.
      return undefined
    }
  }, [service, sessionId, cwd, tabId, tick])
}