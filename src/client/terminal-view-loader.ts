/**
 * Lazy entry to the terminal slice for CROSS-PLUGIN consumers (the
 * dsh-remote reuse path): resolves the xterm-dependent TerminalView from the
 * lazy client-terminal.js chunk through this plugin's own chunk system
 * (chunk-loader.ts + the /sidebar/bundle route). A consumer plugin therefore
 * never bundles xterm itself, never touches chunk internals, and still gets
 * a TerminalView that accepts the `transport` slot.
 *
 * Usage (from another plugin's client half, AFTER resolving this module
 * through the client module system — see src/client/index.tsx):
 *
 *   const { loadTerminalView } = await ctx.modules.import('dsh-better-sidebar')
 *   const { TerminalView, localTransport } = await loadTerminalView()
 */
import type { ComponentType } from 'react'
import { loadChunk } from './chunk-loader.ts'
import type { TerminalTransport, TerminalViewProps } from './terminal-transport.ts'

/** The terminal slice a cross-plugin consumer mounts (loadTerminalView). */
export interface LoadedTerminalView {
  /** The chunk-loaded TerminalView (accepts `transport` via TerminalViewProps). */
  TerminalView: ComponentType<TerminalViewProps>
  /** The default local pty WS transport — the same instance the built-in
   *  terminal tab uses when no transport is injected. */
  localTransport: TerminalTransport
}

/**
 * Load the terminal chunk on first use and return the mountable slice.
 * Memoized by the chunk loader (one script inject + factory execution per
 * page; HMR revalidates via the bundle route's ETags).
 */
export async function loadTerminalView(): Promise<LoadedTerminalView> {
  const mod = await loadChunk('terminal')
  const view = mod.TerminalView
  const local = mod.localTransport
  if (typeof view !== 'function' || local === undefined) {
    throw new Error('[dsh-better-sidebar] terminal chunk did not export TerminalView / localTransport')
  }
  return {
    TerminalView: view as ComponentType<TerminalViewProps>,
    localTransport: local as TerminalTransport,
  }
}