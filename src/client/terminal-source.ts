/**
 * The terminal tab's CONNECTION-LAYER slot (feature `'terminalSource'`):
 * when a terminal tab mounts, the built-in terminal descriptor resolves
 * the TerminalTransport it hands to TerminalView through this registry —
 * the FIRST provider whose `match` accepts the (sessionId, cwd, tabId)
 * triple supplies the transport; no match (or none registered) → the tab
 * mounts with NO transport and TerminalView keeps its built-in local pty
 * WebSocket, byte for byte. Resolution is pure, registration-order
 * first-match and throwing-safe: a provider whose `match` throws is
 * skipped (console.error), a matched provider whose `createTransport`
 * throws — or deliberately returns `undefined` (a per-tab refusal) — is
 * skipped too and the next provider gets its turn; no surviving transport
 * resolves `undefined` = the default local path.
 *
 * Timing semantics: TerminalView reads its `transport` prop ONCE at mount,
 * so the resolution only needs to be right at mount time — a provider
 * registering LATER affects terminals mounted afterwards (new tabs /
 * remounts), never hot-swaps an open one. The render-side hook subscribes
 * to the registry so a tab still waiting for its lazy chunk picks up a
 * provider that registered meanwhile.
 */
import { useEffect, useMemo, useReducer } from 'react'
import type { Context } from '../context-types.ts'
import type { TerminalTransport } from './terminal-transport.ts'

/**
 * One registered terminal source provider (the registration descriptor).
 * Register through `ctx.betterSidebar.registerTerminalProvider` — returns
 * a disposer (Cordis `ctx.effect` HMR-safe); duplicate ids throw (the
 * service layer owns that guard).
 *
 * The factory returns an existing {@link TerminalTransport} contract (a
 * connection layer, never a second wire protocol), which flows verbatim
 * into TerminalView's `transport` prop. There is deliberately no second
 * frame/wire protocol here — every lifecycle branch the transport owns
 * (close / park / dispose / retry, resize frames) keeps the semantics
 * TerminalView already documents.
 */
export interface TerminalProviderDescriptor {
  /** Unique id (package-prefixed, e.g. 'dsh-remote'). Registering a
   *  duplicate id throws. */
  id: string
  /** Session/tab predicate: does this provider own the given terminal tab?
   *  First match wins, consulted in registration order. All three arguments
   *  arrive VERBATIM (no path/session conversion happens on the host side):
   *  - `sessionId`: the tab's session (for pinned virtual tabs this is the
   *    HOME session);
   *  - `cwd`: the session working directory when known;
   *  - `tabId`: the full tab id — `terminal:<uuid>` for plain tabs,
   *    `agent:<uuid>` for agent-owned terminals (a provider that does not
   *    want the model's terminals returns false on that prefix). Global
   *    shared terminals (`gb:`) are host shared-PTY windows and must never
   *    be taken over — providers gate them in `match` too.
   *  A throwing `match` skips this provider (console.error). */
  match(sessionId: string, cwd: string | undefined, tabId: string): boolean
  /** Factory for the connection layer a matching tab mounts. Returning
   *  undefined REFUSES the takeover (the next provider gets its turn — the
   *  per-tab escape hatch); throwing is treated the same way. Returning a
   *  stable instance (a module-level transport or one cached per session)
   *  is the recommended shape — one transport can own many tabs through
   *  its `open(session)` handles. */
  createTransport(sessionId: string, cwd: string | undefined, tabId: string): TerminalTransport | undefined
}

/**
 * Resolve the connection layer of one terminal tab against a provider
 * list (registration order; first `match` whose `createTransport` returns
 * a transport wins). Throwing `match` / `createTransport` and an explicit
 * `undefined` factory result skip that provider; no match resolves
 * `undefined` — the caller then mounts WITHOUT a `transport` prop, i.e.
 * the built-in local pty WebSocket (byte for byte the historical
 * behavior). Pure: no React, no registry access, fully unit-testable.
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
 * this session should mount, or undefined for the built-in local path.
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
  // The tick is the SUBSCRIPTION state: the reducer's dispatch (`force`)
  // is stable, so the memo below must depend on the tick itself —
  // otherwise a registry notification re-renders the terminal tab but
  // never re-resolves the source, and a provider registering after the
  // tab opened would never be seen.
  const [tick, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (service === undefined) return
    const offs: Array<() => void> = []
    try { offs.push(service.subscribe(force)) } catch { /* registry-less stub */ }
    return () => { for (const off of offs) off() }
  }, [service, force])
  return useMemo(() => {
    // No registry — or no session to resolve against (a scope-less mount,
    // e.g. the descriptor invoked bare in tests) — means the built-in
    // local path; a provider takeover always requires a session.
    if (service === undefined || sessionId === undefined) return undefined
    try {
      return resolveTerminalSource(service.getTerminalProviders(), sessionId, cwd, tabId)
    } catch {
      // A registry-less / partial service stub must not break the terminal.
      return undefined
    }
  }, [service, sessionId, cwd, tabId, tick])
}