/** Type declarations for tools/convert-vscode-icon-theme.mjs (its tests
 *  live in tests/convert-icon-theme.spec.ts; the tool itself is plain JS). */
export interface ConvertIconThemeOptions {
  /** The extracted VSIX directory (contains `extension/`). */
  dir: string
  /** The exported constant name (default 'iconTheme'). */
  exportName?: string
  /** Fail on a missing referenced icon file (default true); false
   *  downgrades the entry to a warning + skip. */
  strictMissing?: boolean
}

export interface ConvertIconThemeStats {
  definitions: number
  mapEntries: number
  dataUrlBytes: number
  moduleBytes: number
  gzipBytes: number
  warnings: number
}

export interface ConvertIconThemeResult {
  ts: string
  stats: ConvertIconThemeStats
  warnings: string[]
}

export function convertIconTheme(options: ConvertIconThemeOptions): ConvertIconThemeResult