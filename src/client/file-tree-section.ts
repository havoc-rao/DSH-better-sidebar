/**
 * The file tree's UPPER-MODULE slot (feature `'fileTreeSection'`, v0.19.0+):
 * a component-region seam that turns the Files panel's tree area into a
 * two-module stack — the injected section on TOP, the existing local tree
 * (with all of its v0.17/v0.18 multi-root logic) unchanged BELOW.
 *
 * Contract in one sentence: a plugin (e.g. dsh-remote) registers a section
 * (unique id + session predicate + render), the panel resolves the FIRST
 * registered section whose `match` accepts the current session, and renders
 * that section's component in an independent scroll region above the local
 * tree; no match → nothing renders (byte-for-byte the pre-slot path).
 *
 * The section owns its whole surface: toolbar, tree rows, context menus,
 * opening remote files — better-sidebar applies NO panel-level capability
 * to it (no search box, no upload, no git) and no tree semantics (the
 * caller's `expanded` set, reveals, refreshTick and git overlays all stay
 * local-tree-only). The panel's own chrome (search / upload / git footer)
 * keeps serving the LOCAL tree exclusively.
 *
 * Resolution is pure and throwing-safe: a section whose `match` throws is
 * skipped (console.error), never allowed to break the tree. Sections are
 * consulted in registration order — FIRST match wins; later registrations
 * never shadow an earlier one.
 *
 * Rendering is live: the render-side hook subscribes to the service
 * registry (the same force/tick pattern as `useFileTreeSource`), so a
 * plugin activating or deactivating after the panel exists makes the
 * section appear / disappear immediately.
 */
import { useEffect, useMemo, useReducer } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '../context-types.ts'

/**
 * The render scope of a matched file-tree section: the current session's
 * identity plus the client context (the injector reaches the shared
 * service / registries through `ctx`).
 */
export interface FileTreeSectionScope {
  sessionId: string
  cwd: string | undefined
  ctx: Context
}

/**
 * One registered file-tree section (the registration descriptor).
 * Register through `ctx.betterSidebar.registerFileTreeSection` — returns a
 * disposer (Cordis `ctx.effect` HMR-safe), duplicate ids throw.
 */
export interface FileTreeSectionDescriptor {
  /** Unique id (package-prefixed, e.g. 'dsh-remote'). */
  id: string
  /** Session predicate: does this section belong above the given session's
   *  tree? `cwd` is the session working directory when known. First match
   *  wins (registration order); a throwing match is skipped. */
  match(sessionId: string, cwd: string | undefined): boolean
  /** The section's component: the injector's OWN remote-tree surface,
   *  rendered in the independent upper region. Receives the session scope.
   *  A throwing render is the plugin's bug (no better-sidebar capability
   *  is applied); keep it cheap — it re-renders with the panel. */
  render(scope: FileTreeSectionScope): ReactNode
}

/**
 * Resolve the upper section of one session against a section list
 * (registration order; first `match` wins). A throwing `match` skips that
 * section; no match resolves `undefined` — the panel then renders the
 * plain local tree, byte for byte. Pure: no React, no registry access,
 * fully unit-testable.
 */
export function resolveFileTreeSection(
  sections: readonly FileTreeSectionDescriptor[],
  sessionId: string,
  cwd: string | undefined,
): FileTreeSectionDescriptor | undefined {
  for (const section of sections) {
    let matched = false
    try {
      matched = section.match(sessionId, cwd) === true
    } catch (error) {
      console.error('[dsh-better-sidebar] file tree section match error:', error)
      continue
    }
    if (matched) return section
  }
  return undefined
}

/**
 * The render-side resolver hook: the session's resolved upper section, or
 * undefined (the upper region stays unrendered — the exact pre-slot path).
 * Live: re-resolves when the section registry changes (a plugin registers
 * / unregisters a section while the panel is mounted) and when the
 * session/cwd changes. Registry-less service stubs (tests, hosts without
 * the full service) degrade to no section.
 */
export function useFileTreeSection(
  ctx: Context | undefined,
  sessionId: string,
  cwd: string | undefined,
): FileTreeSectionDescriptor | undefined {
  const service = ctx?.betterSidebar
  // The tick is the SUBSCRIPTION state: the reducer's dispatch (`force`)
  // is stable, so the memo below must depend on the tick itself — the same
  // pattern as `useFileTreeSource`'s live registry re-resolution.
  const [tick, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (service === undefined) return
    const offs: Array<() => void> = []
    try { offs.push(service.subscribe(force)) } catch { /* registry-less stub */ }
    return () => { for (const off of offs) off() }
  }, [service, force])
  return useMemo(() => {
    if (service === undefined) return undefined
    try {
      return resolveFileTreeSection(service.getFileTreeSections(), sessionId, cwd)
    } catch {
      // A registry-less / partial service stub must not break the tree.
      return undefined
    }
  }, [service, sessionId, cwd, tick])
}