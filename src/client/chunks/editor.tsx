/**
 * Lazy chunk entry: the code/markdown/html text editor (CodeMirror 6 + the
 * language packages). Built as `lib/client-editor.js` and registered under
 * `dsh-better-sidebar/editor` — fetched only when a text file is first
 * opened (see chunk-loader.ts and docs/plans/2026-08-12-lazy-chunks-design.md).
 * Never import this module from the core bundle: it pulls CodeMirror into
 * the startup path.
 */
export { TextEditor } from '../TextEditor.tsx'
export { MarkdownPreview } from '../MarkdownPreview.tsx'
export { ControlledCodeEditor } from '../ControlledCodeEditor.tsx'
export { languageForPath } from '../lang.ts'
export { cmSurfaceTheme, CmThemeCompartment } from '../cm-themes.ts'
export { isDarkScheme, subscribeColorScheme } from '../theme.ts'
