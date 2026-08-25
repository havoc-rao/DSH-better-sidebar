/**
 * Tests for the file-icon rendering surface (src/client/FileIcon.tsx):
 * - {@link FileIcon} renders the three ref forms (colored SVG /
 *   monochrome mask / font glyph);
 * - registering a font theme injects its @font-face once and the disposer
 *   removes it;
 * - {@link useFileIconResolver} + FileTree render themed row icons only
 *   under an ACTIVE theme, fall back to the built-in outline icons
 *   otherwise, and follow registry/prefs changes live (theme install,
 *   pref flip, theme uninstall).
 */
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileIcon, useFileIconResolver } from '../src/client/FileIcon.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { FileTree } from '../src/client/FileTree.tsx'
import { api, type FsEntry } from '../src/client/api.ts'
import type { FileIconRef, IconThemeDocument } from '../src/client/icon-theme.ts'
import type { Context } from '../src/context-types.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const svgData = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
const fontData = 'data:font/woff2;base64,AAEAAA='

/** A self-contained theme: root/folder/file defaults + a src folder +
 *  tsconfig.json name entry (all defs share one svg — identity checks use
 *  the def ids through the index, the forms through the ref kind). */
function miniTheme(): IconThemeDocument {
  return {
    iconDefinitions: {
      file: { iconPath: svgData },
      folder: { iconPath: svgData },
      'folder-open': { iconPath: svgData },
      'folder-root': { iconPath: svgData },
      'folder-root-open': { iconPath: svgData },
      tsconfig: { iconPath: svgData },
      js: { iconPath: svgData },
      'folder-src': { iconPath: svgData },
      'folder-src-open': { iconPath: svgData },
    },
    fileNames: { 'tsconfig.json': 'tsconfig' },
    fileExtensions: { js: 'js' },
    folderNames: { src: 'folder-src' },
    folderNamesExpanded: { src: 'folder-src-open' },
    file: 'file',
    folder: 'folder',
    folderExpanded: 'folder-open',
    rootFolder: 'folder-root',
    rootFolderExpanded: 'folder-root-open',
  }
}

/** Mount a node into a detached container under React's act(). */
function mountRoot(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

describe('FileIcon rendering', () => {
  it('renders a colored SVG ref via background-image (data URL, contain)', () => {
    const icon: FileIconRef = { kind: 'svg-image', url: svgData }
    const { container, unmount } = mountRoot(createElement(FileIcon, { icon }))
    try {
      const span = container.querySelector('[data-file-icon="svg"]') as HTMLElement
      expect(span).not.toBeNull()
      expect(span.getAttribute('aria-hidden')).toBe('true')
      expect(span.style.backgroundImage).toContain('data:image/svg+xml;base64')
      expect(span.style.backgroundSize).toBe('contain')
      expect(span.style.width).toBe('14px')
      expect(span.style.height).toBe('14px')
    } finally {
      unmount()
    }
  })

  it('renders a monochrome ref via mask + currentColor', () => {
    const icon: FileIconRef = { kind: 'svg-mono', url: svgData }
    const { container, unmount } = mountRoot(createElement(FileIcon, { icon }))
    try {
      const span = container.querySelector('[data-file-icon="svg-mono"]') as HTMLElement
      expect(span).not.toBeNull()
      expect(span.style.backgroundColor.toLowerCase()).toBe('currentcolor')
      expect(span.style.webkitMaskImage).toContain('data:image/svg+xml;base64')
    } finally {
      unmount()
    }
  })

  it('renders a font ref as a glyph in the theme-scoped family', () => {
    const icon: FileIconRef = { kind: 'font', fontFamily: 'dsh-fi-t-1', character: '\\ue001' }
    const { container, unmount } = mountRoot(createElement(FileIcon, { icon }))
    try {
      const span = container.querySelector('[data-file-icon="font"]') as HTMLElement
      expect(span).not.toBeNull()
      expect(span.textContent).toBe('\\ue001')
      expect(span.style.fontFamily).toBe('dsh-fi-t-1')
      expect(span.style.color.toLowerCase()).toBe('currentcolor')
    } finally {
      unmount()
    }
  })
})

describe('icon theme fonts injection', () => {
  it('injects @font-face at registration and removes it on dispose (SVG themes inject nothing)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    expect(document.querySelector('style[data-dsh-theme-font]')).toBeNull()
    // A font theme injects ONE face for its single font (theme-scoped family).
    const disposeFont = service.registerIconTheme({
      id: 'fonts',
      title: 'Fonts',
      theme: {
        iconDefinitions: {
          f1: { fontCharacter: '\\ue001', fontPath: fontData },
          f2: { fontCharacter: '\\ue002', fontPath: fontData },
        },
        fileExtensions: { js: 'f1', json: 'f2' },
      },
    })
    const faces = document.querySelectorAll<HTMLElement>('style[data-dsh-theme-font="fonts"]')
    expect(faces).toHaveLength(1)
    expect(faces[0]!.textContent).toContain('dsh-fi-fonts-1')
    // An SVG theme must not add faces.
    const disposeSvg = service.registerIconTheme({ id: 'svgtheme', title: 'SVG', theme: miniTheme() })
    expect(document.querySelectorAll('style[data-dsh-theme-font="svgtheme"]')).toHaveLength(0)
    disposeSvg()
    disposeFont()
    expect(document.querySelector('style[data-dsh-theme-font]')).toBeNull()
  })
})

describe('useFileIconResolver + FileTree integration', () => {
  const file = (name: string, path: string): FsEntry =>
    ({ name, path, isDir: false, hidden: false, isSymlink: false, broken: false })
  const dir = (name: string, path: string): FsEntry =>
    ({ name, path, isDir: true, hidden: false, isSymlink: false, broken: false })

  /** A controlled FileTree (expansion state lives outside, like the app). */
  function Harness(props: { ctx?: Context }): ReactNode {
    const { ctx } = props
    const [expanded, setExpanded] = useState<string[]>([])
    return createElement(FileTree, {
      sessionId: 's',
      cwd: '/repo',
      ctx,
      expanded,
      onToggle: (path: string) => {
        setExpanded(current => current.includes(path) ? current.filter(p => p !== path) : [...current, path])
      },
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
    })
  }

  it('renders themed row icons only under an ACTIVE theme and follows registry/prefs changes live', async () => {
    vi.spyOn(api, 'fsTree').mockImplementation(async (_scope, path) => {
      if (path === '/repo') {
        return { path, entries: [file('tsconfig.json', '/repo/tsconfig.json'), dir('src', '/repo/src')], truncated: false }
      }
      return { path, entries: [], truncated: false }
    })
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const ctx = { betterSidebar: service } as unknown as Context

    const { container, unmount } = mountRoot(createElement(Harness, { ctx }))
    try {
      // Rows load; without a theme they render the built-in outline icons
      // (zero themed spans).
      await vi.waitFor(() => expect(container.textContent).toContain('tsconfig.json'))
      expect(container.querySelectorAll('[data-file-icon]')).toHaveLength(0)

      // Installing a theme alone changes nothing (no ACTIVE theme yet).
      const dispose = service.registerIconTheme({ id: 'mini', title: 'Mini', theme: miniTheme() })
      expect(container.querySelectorAll('[data-file-icon]')).toHaveLength(0)

      // Flipping the pref gives the rows themed icons: the root row (root
      // variant), the src folder and the tsconfig.json file all resolve.
      act(() => { store.setPrefs({ ...store.getPrefs(), fileIconTheme: 'mini' }) })
      await vi.waitFor(() => expect(container.querySelectorAll('[data-file-icon]').length).toBeGreaterThanOrEqual(3))
      for (const icon of [...container.querySelectorAll<HTMLElement>('[data-file-icon]')]) {
        expect(icon.getAttribute('data-file-icon')).toBe('svg')
      }

      // Uninstalling the ACTIVE theme falls back to the built-ins (never
      // crashes).
      act(() => { dispose() })
      await vi.waitFor(() => expect(container.querySelectorAll('[data-file-icon]')).toHaveLength(0))
    } finally {
      unmount()
    }
  })
})

beforeEach(() => { vi.restoreAllMocks() })