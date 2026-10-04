/** CodeMirror-only surface; import this through the existing editor lazy chunk. */
import { useLayoutEffect, useRef } from 'react'
import { EditorState, StateEffect, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import css from './CentralCodeEditor.module.css'

export interface CentralCodeEditorProps {
  path: string
  /** Opaque document identity, including the owning session (not just path). */
  documentKey: string
  content: string
  onChange: (text: string) => void
  onSave: () => void
  registerCacheCleanup?: (key: string, cleanup: () => void) => void
  /** One-based line and column of the primary selection's head. */
  onCursor?: (line: number, column: number) => void
}

interface RememberedDocument {
  path: string
  state: EditorState
  scrollTop: number
  scrollLeft: number
}

/**
 * Explicitly owned by the caller's open-document lifecycle. Remounts retain
 * history/selection/folds/scroll, but this module Map is NOT guaranteed across
 * HMR or a page reload. The caller must forget closed documents and use a
 * session-scoped documentKey. No path-only/global-session fallback is allowed.
 */
const documents = new Map<string, RememberedDocument>()

/** Safe before or after unmount: an active view cannot reinsert a forgotten key. */
export function forgetCentralCodeDocument(key: string): void {
  documents.delete(key)
}

function reportCursor(view: EditorView, callback: CentralCodeEditorProps['onCursor']): void {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  callback?.(line.number, head - line.from + 1)
}

export function CentralCodeEditor(props: CentralCodeEditorProps) {
  const { path, documentKey, content } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const liveRef = useRef(props)

  // Commit new callbacks before any creation/content effects dispatch updates.
  // Saved EditorStates must never keep callbacks bound to a previous mount.
  useLayoutEffect(() => { liveRef.current = props })

  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const theme = new CmThemeCompartment()
    const language = languageForPath(path)
    const extensions = [
      lineNumbers(),
      history(),
      foldGutter(),
      bracketMatching(),
      indentOnInput(),
      search({ top: true }),
      highlightSelectionMatches(),
      EditorState.tabSize.of(2),
      EditorView.contentAttributes.of({ spellcheck: 'false' }),
      cmSurfaceTheme,
      theme.of(isDarkScheme()),
      ...(language === null ? [] : [language]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) liveRef.current.onChange(update.state.doc.toString())
        if (update.docChanged || update.selectionSet) {
          reportCursor(update.view, liveRef.current.onCursor)
        }
      }),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { liveRef.current.onSave(); return true } },
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
    ]
    const previous = documents.get(documentKey)
    const remembered = previous?.path === path ? previous : undefined
    // Reconfigure the cached state (rather than serializing it) to preserve
    // history and selection while replacing the old listener/keymap/theme.
    let state = remembered === undefined
      ? EditorState.create({ doc: liveRef.current.content, extensions })
      : remembered.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state
    if (state.doc.toString() !== liveRef.current.content) {
      state = state.update({
        changes: { from: 0, to: state.doc.length, insert: liveRef.current.content },
        annotations: Transaction.addToHistory.of(false),
      }).state
    }
    const record: RememberedDocument = {
      path,
      state,
      scrollTop: remembered?.scrollTop ?? 0,
      scrollLeft: remembered?.scrollLeft ?? 0,
    }
    documents.set(documentKey, record)
    liveRef.current.registerCacheCleanup?.(documentKey, () => forgetCentralCodeDocument(documentKey))
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    // Restore after CodeMirror measures its native, full-height scroller.
    view.requestMeasure({
      read: () => ({ top: record.scrollTop, left: record.scrollLeft }),
      write: ({ top, left }) => {
        view.scrollDOM.scrollTop = top
        view.scrollDOM.scrollLeft = left
      },
    })
    reportCursor(view, liveRef.current.onCursor)
    const unsubscribe = subscribeColorScheme(() => {
      view.dispatch({ effects: theme.reconfigure(isDarkScheme()) })
    })
    return () => {
      unsubscribe()
      // Closing may forget before React runs cleanup; don't resurrect it.
      if (documents.get(documentKey) === record) {
        record.state = view.state
        record.scrollTop = view.scrollDOM.scrollTop
        record.scrollLeft = view.scrollDOM.scrollLeft
      }
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
  }, [documentKey, path])

  // A parent echo of our own edit is a no-op, keeping selection/undo/scroll.
  // Only a real external content change dispatches; all docChanged updates
  // (including this synchronization) go through the live onChange callback.
  useLayoutEffect(() => {
    const view = viewRef.current
    if (view === null || view.state.doc.toString() === content) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      annotations: Transaction.addToHistory.of(false),
    })
  }, [content, documentKey, path])

  return <div ref={hostRef} className={css.surface} data-central-code-editor />
}
