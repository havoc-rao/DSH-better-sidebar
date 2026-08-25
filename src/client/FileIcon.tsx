/**
 * The file-icon rendering surface for registered icon themes (v0.16.0+):
 * - {@link FileIcon} renders one resolved {@link FileIconRef} — a colored
 *   SVG data URL (background-image), a monochrome SVG (CSS mask +
 *   currentColor, so it follows the skin's foreground token), or a font
 *   glyph (the theme's @font-face, injected at registration).
 * - {@link useFileIconResolver} gives a row-ready resolver: it queries the
 *   ACTIVE theme through `ctx.betterSidebar.matchFileIcon` and returns
 *   null when nothing matches — the caller then keeps its built-in outline
 *   icon, so an absent theme changes nothing. Re-resolves on registry
 *   changes (theme HMR/install) and store changes (theme prefs).
 */
import { useCallback, useEffect, useReducer, type ReactNode } from 'react'
import type { Context } from '../context-types.ts'
import type { FileIconContext, FileIconRef } from './icon-theme.ts'

/** The default row/tab icon size (kept in sync with the built-in icons). */
export const FILE_ICON_SIZE = 14

/** Shared inline base: a fixed-size inline-block box (no CSS-module
 *  dependency — this component must render identically anywhere). */
const BASE_STYLE: React.CSSProperties = {
  display: 'inline-block',
  width: FILE_ICON_SIZE,
  height: FILE_ICON_SIZE,
  flexShrink: 0,
  verticalAlign: 'middle',
}

/** Render one resolved file-icon ref. `size` scales the box (the SVG/
 *  glyph scales with it); `className` rides along for row-specific nudge.
 *  (Prop named `icon`, not `ref`: React reserves `ref` for the DOM ref
 *  mechanism and would swallow it.) */
export function FileIcon(props: {
  icon: FileIconRef
  size?: number
  className?: string
}): ReactNode {
  const { icon: ref, size = FILE_ICON_SIZE, className } = props
  const box: React.CSSProperties = { ...BASE_STYLE, width: size, height: size }
  if (ref.kind === 'svg-image') {
    return (
      <span
        aria-hidden
        data-file-icon="svg"
        className={className}
        style={{
          ...box,
          backgroundImage: `url("${ref.url}")`,
          backgroundSize: 'contain',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center',
        }}
      />
    )
  }
  if (ref.kind === 'svg-mono') {
    // Mask + currentColor: the icon follows the ambient text color (skin
    // tokens), exactly like the built-in outline icons do.
    return (
      <span
        aria-hidden
        data-file-icon="svg-mono"
        className={className}
        style={{
          ...box,
          backgroundColor: 'currentColor',
          maskImage: `url("${ref.url}")`,
          WebkitMaskImage: `url("${ref.url}")`,
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
        }}
      />
    )
  }
  return (
    <span
      aria-hidden
      data-file-icon="font"
      className={className}
      style={{
        ...box,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: ref.fontFamily,
        fontSize: ref.fontSize ?? `${Math.round(size * 1.2)}px`,
        lineHeight: 1,
        color: ref.color ?? 'currentColor',
      }}
    >
      {ref.character}
    </span>
  )
}

/**
 * The row-ready file-icon resolver of the ACTIVE icon theme. Returns a
 * function that resolves one row context to a rendered icon (14px), or
 * null when no theme is active / nothing matches — the caller renders its
 * built-in outline icon in that case. Live: registry changes (a theme
 * installs/uninstalls) and snapshot changes (the theme pref flips) both
 * re-render. The resolve step is guarded: a throwing lookup degrades to
 * null, never breaking the tree.
 */
export function useFileIconResolver(ctx: Context | undefined): (context: FileIconContext) => ReactNode {
  const service = ctx?.betterSidebar
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (service === undefined) return
    const offs: Array<() => void> = []
    try { offs.push(service.subscribe(force)) } catch { /* registry-less stub */ }
    try { offs.push(service.subscribeState(force)) } catch { /* snapshot-less stub */ }
    return () => { for (const off of offs) off() }
  }, [service, force])
  return useCallback((context: FileIconContext): ReactNode => {
    try {
      const ref = service?.matchFileIcon(context)
      return ref === undefined ? null : <FileIcon icon={ref} />
    } catch {
      return null
    }
  }, [service])
}