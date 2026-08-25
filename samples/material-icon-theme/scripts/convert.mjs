#!/usr/bin/env node
/**
 * Regenerate src/client/icons.generated.ts from a local VSIX.
 *
 *   node scripts/convert.mjs /path/to/pkief.material-icon-theme-<ver>.vsix
 *
 * Downloads nothing — point it at your own VSIX file (e.g. from the
 * Open VSX / marketplace). The generated module embeds every icon as a
 * data URL and carries the source license verbatim (MIT).
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const repoRoot = join(here, '..', '..', '..')
const converter = join(repoRoot, 'tools', 'convert-vscode-icon-theme.mjs')
const unpacked = join(root, 'unpacked')
const out = join(root, 'src', 'client', 'icons.generated.ts')

const vsix = process.argv[2]
if (vsix === undefined) {
  console.error('usage: node scripts/convert.mjs <material-icon-theme-<ver>.vsix>')
  process.exit(2)
}

rmSync(unpacked, { recursive: true, force: true })
mkdirSync(unpacked, { recursive: true })
// The VSIX bundles everything under `extension/` — extract only that.
execFileSync('unzip', ['-q', '-o', vsix, 'extension/*'], { cwd: unpacked, stdio: 'inherit' })
execFileSync(process.execPath, [converter, unpacked, '-o', out], { stdio: 'inherit' })
console.log('converted:', out)