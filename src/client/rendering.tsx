/** Public rendering seam. Heavy renderers stay in the existing editor chunk. */
import { createElement, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import type { SessionScope } from './api.ts'
import type { MarkdownCopyLabels } from './markdown-labels.tsx'
import type { languageForPath } from './lang.ts'
import type { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import type { isDarkScheme, subscribeColorScheme } from './theme.ts'
import { loadChunk } from './chunk-loader.ts'

export type { MarkdownCopyLabels } from './markdown-labels.tsx'
export interface MarkdownRenderProps {
  text: string
  scope: SessionScope
  path: string
  codeLabels: MarkdownCopyLabels
  /** Optional owned preview scroll surface; omit to render into the caller's surface. */
  className?: string
}
export interface CodeEditorRenderProps {
  /** Document identity; selects the caller-owned cached view state when provided. */
  documentKey: string
  path: string
  content: string
  onChange(content: string): void
  /** Requests a save only; the caller owns persistence and errors. */
  onSave?(): void
  className?: string
  readOnly?: boolean
  /** Opaque in-memory view states; caller owns the Map and eviction on close/unload.
   * Do not serialize or share between different sidebar CodeMirror runtimes. */
  stateCache?: { get(key: string): unknown; set(key: string, value: unknown): void }
}
export interface CodeRendering {
  languageForPath: typeof languageForPath
  cmSurfaceTheme: typeof cmSurfaceTheme
  CmThemeCompartment: typeof CmThemeCompartment
  isDarkScheme: typeof isDarkScheme
  subscribeColorScheme: typeof subscribeColorScheme
}
export interface SharedRenderingService {
  renderMarkdown(props: MarkdownRenderProps): ReactNode
  renderCodeEditor(props: CodeEditorRenderProps): ReactNode
  /** Extensions belong to the sidebar chunk's CM runtime. Prefer renderCodeEditor. */
  loadCodeRendering(): Promise<CodeRendering>
}

function ChunkRenderer<P extends object>({ name, props }: { name: 'MarkdownPreview' | 'ControlledCodeEditor'; props: P }): ReactNode {
  const [component, setComponent] = useState<ComponentType<P> | null>(null)
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    let active = true
    void loadChunk('editor').then((chunk) => {
      if (typeof chunk[name] !== 'function') throw new Error(`Missing sidebar renderer: ${name}`)
      if (active) setComponent(() => chunk[name] as ComponentType<P>)
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause : new Error(String(cause)))
    })
    return () => { active = false }
  }, [name])
  // Consumer error boundaries own presentation; do not silently render an empty failed preview.
  if (error !== null) throw error
  return component === null ? null : createElement(component, props)
}

export const sharedRendering: SharedRenderingService = {
  renderMarkdown: (props) => createElement(ChunkRenderer<MarkdownRenderProps>, { name: 'MarkdownPreview', props }),
  renderCodeEditor: (props) => createElement(ChunkRenderer<CodeEditorRenderProps>, { name: 'ControlledCodeEditor', props }),
  async loadCodeRendering() {
    const chunk = await loadChunk('editor')
    return {
      languageForPath: chunk.languageForPath as CodeRendering['languageForPath'],
      cmSurfaceTheme: chunk.cmSurfaceTheme as CodeRendering['cmSurfaceTheme'],
      CmThemeCompartment: chunk.CmThemeCompartment as CodeRendering['CmThemeCompartment'],
      isDarkScheme: chunk.isDarkScheme as CodeRendering['isDarkScheme'],
      subscribeColorScheme: chunk.subscribeColorScheme as CodeRendering['subscribeColorScheme'],
    }
  },
}
