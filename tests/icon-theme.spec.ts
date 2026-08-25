/**
 * Tests for the file-icon theme engine (src/client/icon-theme.ts) and the
 * service surface it powers (registerIconTheme / getIconThemes /
 * getActiveIconTheme / matchFileIcon). The algorithm cases run against a
 * REAL document subset extracted from material-icon-theme 5.38.1
 * (tests/fixtures/material-icon-theme.sample.json — real keys, real SVGs),
 * so the resolution ladder is locked to VSCode-compatible behavior rather
 * than to hand-made fixtures.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Mock browser globals (SidebarStore uses window.setTimeout + localStorage).
const g = globalThis as Record<string, unknown>
if (g.window === undefined) {
  g.window = {
    clearTimeout: () => {},
    setTimeout: (_fn: () => void) => 0,
    innerWidth: 1024,
  }
}
if (g.localStorage === undefined) {
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
}

import { buildIconThemeIndex, matchFileIcon, type FileIconRef, type IconThemeDocument } from '../src/client/icon-theme.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { parsePrefs } from '../src/client/prefs.ts'

/** The REAL material-icon-theme document subset (real keys + SVG data URLs). */
function realTheme(): IconThemeDocument {
  return JSON.parse(
    readFileSync(new URL('./fixtures/material-icon-theme.sample.json', import.meta.url), 'utf8'),
  ) as IconThemeDocument
}

/** Narrow a resolved ref to its svg url (these tests target svg themes). */
function svgUrlOf(ref: FileIconRef | undefined): string {
  if (ref === undefined) throw new Error('expected a resolved icon ref')
  if (ref.kind === 'svg-image' || ref.kind === 'svg-mono') return ref.url
  throw new Error(`expected an svg icon ref, got ${ref.kind}`)
}

/** Narrow a resolved ref to its font description. */
function fontOf(ref: FileIconRef | undefined): Extract<FileIconRef, { kind: 'font' }> {
  if (ref?.kind === 'font') return ref
  throw new Error('expected a font icon ref')
}

/** Build the index of the real theme and resolve one context. */
function realRef(context: { name: string; isDir: boolean; expanded?: boolean; isRoot?: boolean }): FileIconRef | undefined {
  return matchFileIcon(buildIconThemeIndex(realTheme(), 'material-icon-theme'), context)
}

const svgData = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
const fontData = 'data:font/woff2;base64,AAEAAA='

/** A minimal synthetic theme for structural tests. */
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

describe('icon theme engine — real material-icon-theme data', () => {
  it('exact fileNames win over extensions (tsconfig.json, package.json, justfile, .pug-lintrc.json)', () => {
    const index = buildIconThemeIndex(realTheme(), 'material-icon-theme')
    for (const name of ['tsconfig.json', 'package.json', 'justfile', '.pug-lintrc.json']) {
      const ref = matchFileIcon(index, { name, isDir: false })
      expect(ref?.kind).toBe('svg-image')
      expect(ref).toBeDefined()
    }
    // .pug-lintrc.json is a fileNames hit even though 'json' is a known ext.
    const pug = svgUrlOf(matchFileIcon(index, { name: '.pug-lintrc.json', isDir: false }))
    const tsconfig = svgUrlOf(matchFileIcon(index, { name: 'tsconfig.json', isDir: false }))
    expect(pug).not.toBe(tsconfig)
  })

  it('fileExtensions match LONGEST suffix first (foo.d.ts → typescript-def, not typescript)', () => {
    const index = buildIconThemeIndex(realTheme(), 'material-icon-theme')
    const dts = svgUrlOf(matchFileIcon(index, { name: 'foo.d.ts', isDir: false }))
    const ts = svgUrlOf(matchFileIcon(index, { name: 'foo.ts', isDir: false }))
    // The two resolve to DIFFERENT defs in the real theme.
    expect(dts).not.toBe(ts)
    // Plain 'ts' still resolves (and multi-dot files still fall to 'ts').
    expect(svgUrlOf(matchFileIcon(index, { name: 'lib.ts', isDir: false }))).toBe(ts)
    expect(svgUrlOf(matchFileIcon(index, { name: 'deep.a.b.ts', isDir: false }))).toBe(ts)
  })

  it('unknown extensions fall through to the default file icon', () => {
    const index = buildIconThemeIndex(realTheme(), 'material-icon-theme')
    const fallback = svgUrlOf(matchFileIcon(index, { name: 'foo.xyz', isDir: false }))
    expect(fallback).toBe(svgUrlOf(index.defs.get('file')))
    // .js is NOT in the fixture's fileExtensions (only languageIds has it)
    // — languageIds must never leak into file matching.
    expect(svgUrlOf(matchFileIcon(index, { name: 'app.js', isDir: false }))).toBe(fallback)
    // light.fileExtensions ('blink') must also be ignored.
    expect(svgUrlOf(matchFileIcon(index, { name: 'x.blink', isDir: false }))).toBe(fallback)
  })

  it('folders: expanded map wins while expanded, generic map when collapsed', () => {
    const index = buildIconThemeIndex(realTheme(), 'material-icon-theme')
    const open = svgUrlOf(matchFileIcon(index, { name: 'src', isDir: true, expanded: true }))
    const closed = svgUrlOf(matchFileIcon(index, { name: 'src', isDir: true, expanded: false }))
    expect(open).toBe(svgUrlOf(index.defs.get('folder-src-open')))
    expect(closed).toBe(svgUrlOf(index.defs.get('folder-src')))
  })

  it('folders: unknown names fall back to folderExpanded / folder defaults', () => {
    const index = buildIconThemeIndex(realTheme(), 'material-icon-theme')
    expect(svgUrlOf(matchFileIcon(index, { name: 'custom', isDir: true, expanded: true })))
      .toBe(svgUrlOf(index.defs.get('folder-open')))
    expect(svgUrlOf(matchFileIcon(index, { name: 'custom', isDir: true })))
      .toBe(svgUrlOf(index.defs.get('folder')))
  })

  it('root folders use the root variants — empty rootFolderNames fall to rootFolder defaults', () => {
    const index = buildIconThemeIndex(realTheme(), 'material-icon-theme')
    // The real theme ships EMPTY rootFolderNames maps → default variants.
    expect(svgUrlOf(matchFileIcon(index, { name: 'src', isDir: true, isRoot: true })))
      .toBe(svgUrlOf(index.defs.get('folder-root')))
    expect(svgUrlOf(matchFileIcon(index, { name: 'src', isDir: true, isRoot: true, expanded: true })))
      .toBe(svgUrlOf(index.defs.get('folder-root-open')))
  })

  it('every fixture icon is a data: URL SVG (render-ready)', () => {
    const index = buildIconThemeIndex(realTheme(), 'material-icon-theme')
    for (const ref of index.defs.values()) {
      expect(ref.kind).toBe('svg-image')
      expect(svgUrlOf(ref).startsWith('data:image/svg+xml;')).toBe(true)
    }
    expect(index.defs.size).toBeGreaterThanOrEqual(27)
  })
})

describe('icon theme engine — structure and validation', () => {
  it('rejects documents without an iconDefinitions object', () => {
    expect(() => buildIconThemeIndex({ iconDefinitions: null } as unknown as IconThemeDocument, 't'))
      .toThrow(/iconDefinitions/)
    expect(() => buildIconThemeIndex({} as unknown as IconThemeDocument, 't'))
      .toThrow(/iconDefinitions/)
  })

  it('rejects a def with neither iconPath nor fontCharacter', () => {
    expect(() => buildIconThemeIndex({ iconDefinitions: { x: {} } }, 't')).toThrow(/iconPath or fontCharacter/)
  })

  it('rejects non-data assets fail-fast (the converter contract)', () => {
    expect(() => buildIconThemeIndex({
      iconDefinitions: { x: { iconPath: './icons/x.svg' } },
    }, 't')).toThrow(/data: URL/)
    expect(() => buildIconThemeIndex({
      iconDefinitions: { x: { fontCharacter: '\\ue001', fontPath: 'http://x/f.woff' } },
    }, 't')).toThrow(/data: URL/)
  })

  it('rejects fontCharacter without fontPath', () => {
    expect(() => buildIconThemeIndex({ iconDefinitions: { x: { fontCharacter: '\\ue001' } } }, 't'))
      .toThrow(/data: URL/)
  })

  it('resolves matches to undefined when nothing matches at all (no defaults)', () => {
    const index = buildIconThemeIndex({
      iconDefinitions: { a: { iconPath: svgData } },
      fileExtensions: { ts: 'a' },
    }, 't')
    expect(matchFileIcon(index, { name: 'x.xyz', isDir: false })).toBeUndefined()
    expect(matchFileIcon(index, { name: 'x.ts', isDir: false })!.kind).toBe('svg-image')
  })

  it('skips garbage map entries but keeps valid ones', () => {
    const index = buildIconThemeIndex({
      iconDefinitions: { a: { iconPath: svgData } },
      fileNames: { good: 'a', bad: 42, worse: null } as unknown as Record<string, string>,
      fileExtensions: { ts: 'a', num: 7 } as unknown as Record<string, string>,
    }, 't')
    expect(matchFileIcon(index, { name: 'good', isDir: false })).toBeDefined()
    expect(matchFileIcon(index, { name: 'bad', isDir: false })).toBeUndefined()
    expect(matchFileIcon(index, { name: 'x.ts', isDir: false })).toBeDefined()
    expect(matchFileIcon(index, { name: 'x.num', isDir: false })).toBeUndefined()
  })

  it('dangling map refs are skipped entry-wise (one bad ref cannot break the theme)', () => {
    const index = buildIconThemeIndex({
      iconDefinitions: { a: { iconPath: svgData } },
      fileNames: { ok: 'a', dangling: 'missing' },
      file: 'a',
    }, 't')
    expect(matchFileIcon(index, { name: 'ok', isDir: false })).toBeDefined()
    // The dangling ref falls THROUGH to the default.
    expect(svgUrlOf(matchFileIcon(index, { name: 'dangling', isDir: false })))
      .toBe(svgUrlOf(index.defs.get('a')))
  })

  it('font themes: theme-scoped families, one @font-face per fontPath', () => {
    const theme: IconThemeDocument = {
      iconDefinitions: {
        f1: { fontCharacter: '\\ue001', fontPath: fontData },
        f2: { fontCharacter: '\\ue002', fontPath: fontData },
        f3: { fontCharacter: '\\ue003', fontPath: 'data:font/woff;base64,BBBB' },
      },
      fileExtensions: { js: 'f1', ts: 'f2', json: 'f3' },
    }
    const index = buildIconThemeIndex(theme, 'my theme')
    const a = fontOf(matchFileIcon(index, { name: 'a.js', isDir: false }))
    const b = fontOf(matchFileIcon(index, { name: 'b.ts', isDir: false }))
    const c = fontOf(matchFileIcon(index, { name: 'c.json', isDir: false }))
    expect(a.character).toBe('\\ue001')
    expect(a.fontFamily).toBe('dsh-fi-my_theme-1')
    expect(b.fontFamily).toBe(a.fontFamily) // same fontPath → shared face
    expect(c.fontFamily).toBe('dsh-fi-my_theme-2') // new fontPath → new face
    expect(Array.from(index.fonts.values()).map(f => f.family).sort())
      .toEqual(['dsh-fi-my_theme-1', 'dsh-fi-my_theme-2'])
  })

  it('monochrome themes resolve svg defs as svg-mono (mask + currentColor)', () => {
    const index = buildIconThemeIndex(miniTheme(), 't', true)
    expect(matchFileIcon(index, { name: 'tsconfig.json', isDir: false })!.kind).toBe('svg-mono')
    expect(matchFileIcon(index, { name: 'src', isDir: true })!.kind).toBe('svg-mono')
  })
})

describe('icon theme service surface', () => {
  it('register/get/dispose lifecycle + registry notifications', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    expect(service.getIconThemes()).toHaveLength(0)
    let calls = 0
    const unsub = service.subscribe(() => { calls++ })
    const dispose = service.registerIconTheme({ id: 'material-icon-theme', title: 'Material', theme: realTheme() })
    expect(service.getIconThemes()).toHaveLength(1)
    expect(service.getIconTheme('material-icon-theme')?.id).toBe('material-icon-theme')
    expect(service.getIconTheme('nope')).toBeUndefined()
    expect(calls).toBe(1)
    dispose()
    expect(service.getIconThemes()).toHaveLength(0)
    expect(calls).toBe(2)
    unsub()
  })

  it('throws on duplicate theme id and on malformed documents (fail fast)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerIconTheme({ id: 't', title: 'T', theme: miniTheme() })
    expect(() => service.registerIconTheme({ id: 't', title: 'T2', theme: miniTheme() }))
      .toThrow(/already registered/)
    // An EMPTY definition table is structurally valid (defaults-only theme)
    // — fail-fast fires on malformed DOCUMENTS/ASSETS instead.
    expect(() => service.registerIconTheme({
      id: 'bad', title: 'Bad',
      theme: { iconDefinitions: { x: { iconPath: './icons/x.svg' } } },
    })).toThrow(/data: URL/)
    expect(() => service.registerIconTheme({
      id: 'bad2', title: 'Bad2',
      theme: { iconDefinitions: { x: { fontCharacter: '\\ue001' } } },
    })).toThrow(/data: URL/)
  })

  it("getActiveIconTheme follows prefs.fileIconTheme ('' → none, unknown → none)", () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    expect(service.getActiveIconTheme()).toBeUndefined()
    const dispose = service.registerIconTheme({ id: 'material-icon-theme', title: 'Material', theme: realTheme() })
    store.setPrefs({ ...store.getPrefs(), fileIconTheme: 'material-icon-theme' })
    expect(service.getActiveIconTheme()?.id).toBe('material-icon-theme')
    store.setPrefs({ ...store.getPrefs(), fileIconTheme: 'gone-theme' })
    expect(service.getActiveIconTheme()).toBeUndefined()
    // Unregistering the ACTIVE theme falls back to none (never crashes).
    store.setPrefs({ ...store.getPrefs(), fileIconTheme: 'material-icon-theme' })
    dispose()
    expect(service.getActiveIconTheme()).toBeUndefined()
  })

  it('matchFileIcon resolves only under an active theme', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerIconTheme({ id: 'material-icon-theme', title: 'Material', theme: realTheme() })
    expect(service.matchFileIcon({ name: 'tsconfig.json', isDir: false })).toBeUndefined()
    store.setPrefs({ ...store.getPrefs(), fileIconTheme: 'material-icon-theme' })
    expect(svgUrlOf(service.matchFileIcon({ name: 'tsconfig.json', isDir: false }))).toBeTruthy()
    // The expanded folder resolves to the theme's REAL folder-src-open def.
    const realIndex = buildIconThemeIndex(realTheme(), 'material-icon-theme')
    const expectedOpen = svgUrlOf(realIndex.defs.get('folder-src-open'))
    expect(svgUrlOf(service.matchFileIcon({ name: 'src', isDir: true, expanded: true }))).toBe(expectedOpen)
  })

  it('parsePrefs keeps a string fileIconTheme and defaults non-strings', () => {
    expect(parsePrefs({ fileIconTheme: 'material-icon-theme' }).fileIconTheme).toBe('material-icon-theme')
    expect(parsePrefs({ fileIconTheme: 42 }).fileIconTheme).toBe('')
    expect(parsePrefs(null).fileIconTheme).toBe('')
  })
})