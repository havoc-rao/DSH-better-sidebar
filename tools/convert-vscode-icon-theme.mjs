#!/usr/bin/env node
/**
 * Convert a VSCode icon-theme contribution (an extracted VSIX directory)
 * into a ready-to-compile TS module for `dsh-better-sidebar`'s icon-theme
 * extension point (v0.16.0+).
 *
 * Pipeline:
 *   1. read `<dir>/extension/package.json` → `contributes.iconThemes[0]`;
 *   2. parse the theme JSON document;
 *   3. rewrite every `iconPath`/`fontPath` relative reference into a
 *      `data:` URL (base64, mime from the file extension) — consumer
 *      plugins have no static file server, and the registry rejects
 *      non-data assets at registration;
 *   4. drop the sections the sidebar ignores (`languageIds`, `light`,
 *      `highContrast`, `hidesExplorerArrows`, theme-local `_` keys);
 *   5. emit a TS module exporting the normalized `IconThemeDocument`.
 *
 * The emitted module imports types only (`dsh-better-sidebar/client/service`)
 * and carries the source theme's license verbatim — it is pure data, so the
 * consumer plugin's build purity gate never trips.
 *
 * Usage:
 *   node tools/convert-vscode-icon-theme.mjs <extracted-vsix-dir> \
 *     [-o <output.ts>] [--export-name <name>] [--no-strict]
 *
 * `--no-strict`: missing referenced icon files downgrade to warnings and
 * the definition is skipped (the theme keeps working through fallbacks)
 * instead of failing the conversion.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname, relative, basename } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const TOOL_NAME = 'tools/convert-vscode-icon-theme.mjs'
const TOOL_VERSION = '0.1.0'

/** File extension → data: URL mime (font/woff2 first for fonts). */
const MIME = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
}

/** Sections of the VSCode icon-theme document we KEEP (the sidebar has no
 *  language model and is skin-token driven — the rest is dropped). The
 *  string default fields (file/folder/…) are carried separately below. */
const KEPT_TOP_LEVEL = [
  'fileNames',
  'fileExtensions',
  'folderNames',
  'folderNamesExpanded',
  'rootFolderNames',
  'rootFolderNamesExpanded',
]

/** Read a UTF-8 JSON file (fail with a readable message). */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Build one emitted constant: an object literal with stable key order. */
function tsLiteral(value, indent) {
  const pad = '  '.repeat(indent)
  const child = '  '.repeat(indent + 1)
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[\n${value.map(v => `${child}${tsLiteral(v, indent + 1)}`).join(',\n')}\n${pad}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([k, v]) => `${child}${JSON.stringify(k)}: ${tsLiteral(v, indent + 1)}`).join(',\n')}\n${pad}}`
}

/**
 * Convert one extracted VSIX directory into the generated TS module text.
 * @param options.dir - the directory containing `extension/` (extracted VSIX).
 * @param options.exportName - the exported constant name (default 'iconTheme').
 * @param options.strictMissing - fail on a missing referenced icon file
 *   (default true); false downgrades the entry to a warning + skip.
 * @returns the module text + conversion stats + warnings.
 */
export function convertIconTheme(options) {
  const dir = resolve(options.dir)
  const exportName = options.exportName ?? 'iconTheme'
  const strictMissing = options.strictMissing !== false
  const warnings = []
  const extDir = join(dir, 'extension')
  const manifest = readJson(join(extDir, 'package.json'))
  const contributions = manifest.contributes?.iconThemes
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw new Error(`${TOOL_NAME}: no contributes.iconThemes in ${join(extDir, 'package.json')}`)
  }
  const contribution = contributions[0]
  const themePath = resolve(extDir, contribution.path)
  const theme = readJson(themePath)
  const iconsDir = dirname(themePath)

  if (theme === null || typeof theme !== 'object' || theme.iconDefinitions === null || typeof theme.iconDefinitions !== 'object') {
    throw new Error(`${TOOL_NAME}: ${relative(dir, themePath)} lacks an iconDefinitions object`)
  }

  /** Rewrite one relative asset path into a data URL (or throw). */
  const assetDataUrl = (defId, field, pathValue) => {
    const target = resolve(iconsDir, pathValue)
    let bytes
    try {
      bytes = readFileSync(target)
    } catch (error) {
      const message = `missing ${field} file "${pathValue}" of definition "${defId}"`
      if (strictMissing) throw new Error(`${TOOL_NAME}: ${message} (re-run with --no-strict to skip it)`)
      warnings.push(message)
      return undefined
    }
    const mime = MIME[(extnameOf(target)).toLowerCase()]
    if (mime === undefined) {
      throw new Error(`${TOOL_NAME}: unsupported asset type "${basename(target)}" (supported: ${Object.keys(MIME).join('/')})`)
    }
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  const iconDefinitions = {}
  let dataBytes = 0
  for (const [defId, def] of Object.entries(theme.iconDefinitions)) {
    if (def === null || typeof def !== 'object') continue
    const out = {}
    if (typeof def.iconPath === 'string') {
      const url = assetDataUrl(defId, 'iconPath', def.iconPath)
      if (url === undefined) continue // --no-strict: skip the definition
      out.iconPath = url
      dataBytes += url.length
    } else if (typeof def.fontCharacter === 'string') {
      if (typeof def.fontPath !== 'string') {
        throw new Error(`${TOOL_NAME}: definition "${defId}" has fontCharacter but no fontPath`)
      }
      const url = assetDataUrl(defId, 'fontPath', def.fontPath)
      if (url === undefined) continue
      out.fontCharacter = def.fontCharacter
      out.fontPath = url
      dataBytes += url.length
      if (typeof def.fontSize === 'string') out.fontSize = def.fontSize
      if (typeof def.fontColor === 'string') out.fontColor = def.fontColor
    } else {
      throw new Error(`${TOOL_NAME}: definition "${defId}" needs iconPath or fontCharacter`)
    }
    iconDefinitions[defId] = out
  }

  const normalized = { iconDefinitions }
  let mapEntries = 0
  for (const key of KEPT_TOP_LEVEL) {
    const raw = theme[key]
    const kept = {}
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [name, value] of Object.entries(raw)) {
        if (typeof value === 'string') { kept[name] = value; mapEntries += 1 }
      }
    }
    // Empty sections are kept ({}) — the document shape stays explicit and
    // the engine's fallbacks resolve exactly like VSCode's.
    normalized[key] = kept
  }
  // Always carry the default fallbacks (the engine resolves them).
  for (const key of ['file', 'folder', 'folderExpanded', 'rootFolder', 'rootFolderExpanded']) {
    if (typeof theme[key] === 'string') normalized[key] = theme[key]
  }

  // License header (verbatim; escape the rare `*/` in bundled licenses).
  let license = 'No license file in the source extension.'
  try {
    license = readFileSync(join(extDir, 'LICENSE.txt'), 'utf8').trim()
  } catch { /* fall through to the default */ }

  const ts = `/**
 * GENERATED by ${TOOL_NAME} (v${TOOL_VERSION}) — do not edit by hand.
 *
 * Source: ${manifest.name ?? 'unknown'} ${manifest.version ?? ''}
 *   (contributes.iconThemes[0] = ${contribution.id} "${contribution.label ?? contribution.id}")
 * Generated: ${new Date().toISOString()}
 * Command:  node ${TOOL_NAME} ${dir} ${options.exportName !== undefined ? `--export-name ${options.exportName}` : ''}
 *
 * ${license.replaceAll('*/', '* /').split('\n').map(line => ` * ${line}`).join('\n').trimEnd()}
 */

import type { IconThemeDocument } from 'dsh-better-sidebar/client/service'

/** The normalized ${contribution.id} document (assets as data: URLs). */
export const ${exportName}: IconThemeDocument = ${tsLiteral(normalized, 0)}
`

  const jsonBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8')
  const stats = {
    definitions: Object.keys(iconDefinitions).length,
    mapEntries,
    dataUrlBytes: dataBytes,
    moduleBytes: Buffer.byteLength(ts, 'utf8'),
    gzipBytes: gzipSync(ts).length,
    warnings: warnings.length,
  }
  return { ts, stats, warnings }
}

/** The bare extension of a file path (lowercase). */
function extnameOf(pathValue) {
  const base = basename(pathValue)
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1)
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const help = () => {
    process.stderr.write(`Usage: node ${TOOL_NAME} <extracted-vsix-dir> [-o <out.ts>] [--export-name <name>] [--no-strict]\n`)
  }
  const dirArg = args.find(a => !a.startsWith('-'))
  if (dirArg === undefined) {
    help()
    process.exit(2)
  }
  let out
  let exportName
  let strictMissing = true
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '-o') out = args[i + 1]
    else if (arg === '--export-name') exportName = args[i + 1]
    else if (arg === '--no-strict') strictMissing = false
  }
  try {
    const { ts, stats, warnings } = convertIconTheme({ dir: dirArg, exportName, strictMissing })
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`)
    process.stderr.write(
      `${TOOL_NAME}: ${stats.definitions} definitions, ${stats.mapEntries} map entries, `
      + `${(stats.moduleBytes / 1024).toFixed(1)} KB module (${(stats.gzipBytes / 1024).toFixed(1)} KB gzip)\n`,
    )
    if (out === undefined) process.stdout.write(ts)
    else {
      writeFileSync(resolve(out), ts)
      process.stderr.write(`${TOOL_NAME}: wrote ${relative(process.cwd(), resolve(out))}\n`)
    }
  } catch (error) {
    process.stderr.write(`${TOOL_NAME}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}