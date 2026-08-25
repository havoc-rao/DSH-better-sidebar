/**
 * File-icon theme support (v0.16.0+): a VSCode-style icon theme registry
 * engine. Consumes an {@link IconThemeDocument} — the VSCode icon-theme JSON
 * shape with SVG/font assets rewritten to `data:` URLs (the official
 * `tools/convert-vscode-icon-theme.mjs` emits exactly this) — and resolves
 * the icon for a file/folder context through the same priority ladder
 * VSCode's own icon theme service uses:
 *
 * - files: exact `fileNames` match → `fileExtensions` by LONGEST suffix
 *   first (`foo.d.ts` tries `d.ts` before `ts`) → the `file` default;
 * - folders: root-variant maps when the folder is the session cwd, then
 *   `folderNamesExpanded`/`folderNames` (expanded state first) → the
 *   `folderExpanded`/`folder` defaults.
 *
 * The module is pure (no React, no DOM): it builds a query index at
 * registration time and answers O(1)–O(4) lookups. Rendering (`FileIcon`)
 * and @font-face injection live in the components, fed by
 * `BetterSidebarService.matchFileIcon`.
 */
import type { ReactNode } from 'react'

/** One icon definition of an {@link IconThemeDocument} (VSCode's
 *  `IconDefinition` subset). SVG themes carry `iconPath`; font themes carry
 *  `fontCharacter` + `fontPath` (+ optional size/color). */
export interface IconThemeIconDefinition {
  /** SVG asset as a `data:` URL (required for SVG themes). */
  iconPath?: string
  /** The glyph character of a font-based icon (e.g. '\ue001'). */
  fontCharacter?: string
  /** Font asset as a `data:` URL backing `fontCharacter`. */
  fontPath?: string
  /** Relative font size (e.g. '150%'); font themes only. */
  fontSize?: string
  /** Explicit glyph color; defaults to the current text color. */
  fontColor?: string
}

/** A VSCode icon-theme document (the `iconThemes` contribution payload):
 *  definition table + file/folder name maps + defaults. The `languageIds`
 *  and `light`/`highContrast` variant sections are intentionally absent —
 *  the sidebar has no language model and is skin-token driven, so they are
 *  ignored by {@link buildIconThemeIndex} (unknown keys are skipped).
 */
export interface IconThemeDocument {
  /** Definition table: def id → rendering description (required). */
  iconDefinitions: Record<string, IconThemeIconDefinition>
  /** Exact file names → def id (e.g. 'tsconfig.json'). */
  fileNames?: Record<string, string>
  /** File extensions (multi-dot allowed: 'd.ts') → def id. */
  fileExtensions?: Record<string, string>
  /** Folder names (collapsed state) → def id. */
  folderNames?: Record<string, string>
  /** Folder names (expanded state) → def id; preferred while expanded. */
  folderNamesExpanded?: Record<string, string>
  /** Root-folder names (collapsed; the session cwd) → def id. */
  rootFolderNames?: Record<string, string>
  /** Root-folder names (expanded) → def id. */
  rootFolderNamesExpanded?: Record<string, string>
  /** Default def ids — the final fallbacks. */
  file?: string
  folder?: string
  folderExpanded?: string
  rootFolder?: string
  rootFolderExpanded?: string
}

/** A render-ready icon reference resolved from a theme (what
 *  `matchFileIcon` returns and {@link FileIcon}-style components render). */
export type FileIconRef =
  /** Colored SVG (the material-icon-theme case): render the data URL as-is. */
  | { kind: 'svg-image'; url: string }
  /** Monochrome themes: render via CSS mask + currentColor. */
  | { kind: 'svg-mono'; url: string }
  /** Font glyph: the @font-face with this family is injected once per
   *  theme (family names are theme-scoped: `dsh-fi-<themeId>-<n>`). */
  | { kind: 'font'; fontFamily: string; character: string; fontSize?: string; color?: string }

/** What one icon lookup needs to know about the target row. */
export interface FileIconContext {
  /** The basename (with dots), e.g. 'foo.d.ts' / 'node_modules'. */
  name: string
  /** Whether the row is a directory (folders resolve by name only). */
  isDir: boolean
  /** Directory expansion state (folders only): expanded maps win. */
  expanded?: boolean
  /** Whether the folder IS the session cwd (root-folder variants win). */
  isRoot?: boolean
}

/** The prebuilt lookup structure of one registered theme. Built once at
 *  registration; queries never allocate. */
export interface IconThemeIndex {
  /** def id → render-ready ref (theme assets validated + normalized here). */
  defs: ReadonlyMap<string, FileIconRef>
  /** The @font-face table needed by `font` refs (keyed by font data URL). */
  fonts: ReadonlyMap<string, { family: string; url: string }>
  fileNames: ReadonlyMap<string, string>
  fileExtensions: ReadonlyMap<string, string>
  folderNames: ReadonlyMap<string, string>
  folderNamesExpanded: ReadonlyMap<string, string>
  rootFolderNames: ReadonlyMap<string, string>
  rootFolderNamesExpanded: ReadonlyMap<string, string>
  file?: string
  folder?: string
  folderExpanded?: string
  rootFolder?: string
  rootFolderExpanded?: string
}

/** The registration contract of `BetterSidebarService.registerIconTheme`. */
export interface IconThemeDescriptor {
  /** Unique id (recommend a package prefix: 'material-icon-theme'). */
  id: string
  /** Display name (i18n friendly: string or () => string). */
  title: string | (() => string)
  /** Settings-list preview icon (typically the theme's default file icon). */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** The normalized theme document (assets as `data:` URLs). */
  theme: IconThemeDocument
  /** Render SVGs through CSS mask + currentColor instead of as colored
   *  images (for monochrome themes that should follow the skin). */
  monochrome?: boolean
  /** Settings-list sort order (ascending); default 100. */
  order?: number
}

/** Accept only string→string map sections; garbage entries are skipped. */
function stringMapOf(raw: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out.set(key, value)
  }
  return out
}

/** Validate one `data:` asset (SVG/font). Registration fails fast on a
 *  non-data URL — a consumer plugin has no static file server, so relative
 *  paths would 404 at render; the converter exists to prevent this. */
function requireDataUrl(themeId: string, defId: string, what: string, value: string): string {
  if (!value.startsWith('data:')) {
    throw new Error(
      `[dsh-better-sidebar] icon theme "${themeId}": ${what} of "${defId}" must be a data: URL `
      + '(run tools/convert-vscode-icon-theme.mjs over the VSIX)',
    )
  }
  return value
}

/** Resolve one icon definition into a render ref (registering its font
 *  face when needed). A missing/unknown combination throws — a malformed
 *  theme must fail at registration, not silently render broken rows. */
function resolveDef(
  themeId: string,
  defId: string,
  def: IconThemeIconDefinition,
  monochrome: boolean,
  fonts: Map<string, { family: string; url: string }>,
  fontSeq: { n: number },
): FileIconRef {
  if (typeof def.iconPath === 'string') {
    const url = requireDataUrl(themeId, defId, 'iconPath', def.iconPath)
    return { kind: monochrome ? 'svg-mono' : 'svg-image', url }
  }
  if (typeof def.fontCharacter === 'string') {
    const fontPath = requireDataUrl(themeId, defId, 'fontPath', def.fontPath ?? '')
    let entry = fonts.get(fontPath)
    if (entry === undefined) {
      fontSeq.n += 1
      entry = { family: `dsh-fi-${themeId.replace(/[^A-Za-z0-9_-]/g, '_')}-${fontSeq.n}`, url: fontPath }
      fonts.set(fontPath, entry)
    }
    const ref: FileIconRef = { kind: 'font', fontFamily: entry.family, character: def.fontCharacter }
    if (typeof def.fontSize === 'string') ref.fontSize = def.fontSize
    if (typeof def.fontColor === 'string') ref.color = def.fontColor
    return ref
  }
  throw new Error(`[dsh-better-sidebar] icon theme "${themeId}": definition "${defId}" needs iconPath or fontCharacter`)
}

/**
 * Build the query index of one theme. Validates the document (fail fast on
 * malformed definitions/assets) and pre-resolves every def into a
 * render-ready {@link FileIconRef}. Name maps referencing def ids that do
 * not exist are skipped entry-wise (the rest of the theme keeps working —
 * a third-party theme must not brick the registry over one dangling ref).
 */
export function buildIconThemeIndex(
  theme: IconThemeDocument,
  themeId: string,
  monochrome = false,
): IconThemeIndex {
  if (theme === null || typeof theme !== 'object'
    || theme.iconDefinitions === null || typeof theme.iconDefinitions !== 'object') {
    throw new Error(`[dsh-better-sidebar] icon theme "${themeId}": theme.iconDefinitions must be an object`)
  }
  const fonts = new Map<string, { family: string; url: string }>()
  const fontSeq = { n: 0 }
  const defs = new Map<string, FileIconRef>()
  for (const [defId, def] of Object.entries(theme.iconDefinitions)) {
    if (def === null || typeof def !== 'object') continue
    defs.set(defId, resolveDef(themeId, defId, def, monochrome, fonts, fontSeq))
  }
  return {
    defs,
    fonts,
    fileNames: stringMapOf(theme.fileNames),
    fileExtensions: stringMapOf(theme.fileExtensions),
    folderNames: stringMapOf(theme.folderNames),
    folderNamesExpanded: stringMapOf(theme.folderNamesExpanded),
    rootFolderNames: stringMapOf(theme.rootFolderNames),
    rootFolderNamesExpanded: stringMapOf(theme.rootFolderNamesExpanded),
    file: typeof theme.file === 'string' ? theme.file : undefined,
    folder: typeof theme.folder === 'string' ? theme.folder : undefined,
    folderExpanded: typeof theme.folderExpanded === 'string' ? theme.folderExpanded : undefined,
    rootFolder: typeof theme.rootFolder === 'string' ? theme.rootFolder : undefined,
    rootFolderExpanded: typeof theme.rootFolderExpanded === 'string' ? theme.rootFolderExpanded : undefined,
  }
}

/** The folder side of {@link matchFileIcon}: root variants when the folder
 *  is the session cwd, then expanded/collapsed name maps (expanded state
 *  prefers its dedicated map and falls back to the generic one), then the
 *  folder defaults. */
function matchDirIcon(index: IconThemeIndex, ctx: FileIconContext): FileIconRef | undefined {
  const { name } = ctx
  const expanded = ctx.expanded === true
  if (ctx.isRoot === true) {
    const id = (expanded
      ? index.rootFolderNamesExpanded.get(name) ?? index.rootFolderNames.get(name) ?? index.rootFolderExpanded
      : index.rootFolderNames.get(name) ?? index.rootFolderNamesExpanded.get(name) ?? index.rootFolder)
    return id === undefined ? undefined : index.defs.get(id)
  }
  const id = (expanded
    ? index.folderNamesExpanded.get(name) ?? index.folderNames.get(name) ?? index.folderExpanded
    : index.folderNames.get(name) ?? index.folderNamesExpanded.get(name) ?? index.folder)
  return id === undefined ? undefined : index.defs.get(id)
}

/**
 * Resolve the icon for one file/folder row under a built theme index.
 * Returns `undefined` when nothing matches (the caller falls back to the
 * built-in outline icons — an absent theme must change nothing).
 *
 * File ladder: exact `fileNames` → `fileExtensions` (suffix candidates
 * walked LONGEST first: `foo.d.ts` tries `d.ts` then `ts`, mirroring
 * VSCode) → the `file` default. Case-sensitive, like VSCode.
 */
export function matchFileIcon(index: IconThemeIndex, ctx: FileIconContext): FileIconRef | undefined {
  if (ctx.isDir) return matchDirIcon(index, ctx)
  const { name } = ctx
  const exact = index.fileNames.get(name)
  if (exact !== undefined) {
    const ref = index.defs.get(exact)
    if (ref !== undefined) return ref
  }
  let dot = name.indexOf('.')
  while (dot !== -1) {
    const defId = index.fileExtensions.get(name.slice(dot + 1))
    if (defId !== undefined) {
      const ref = index.defs.get(defId)
      if (ref !== undefined) return ref
    }
    dot = name.indexOf('.', dot + 1)
  }
  return index.file === undefined ? undefined : index.defs.get(index.file)
}