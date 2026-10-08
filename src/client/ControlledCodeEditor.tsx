/** Controlled view only. The consumer owns document caching and save semantics. */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { EditorState, StateEffect, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { bracketMatching, foldGutter, foldKeymap } from '@codemirror/language'
import { languageForPath } from './lang.ts'
import { cmSurfaceTheme, CmThemeCompartment } from './cm-themes.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import type { CodeEditorRenderProps } from './rendering.tsx'
import css from './sidebar.module.css'

/** Runtime-local opaque token. Reject stale/HMR/different-CM cached states safely. */
const cacheToken = {}
interface CachedEditor {
  token: object
  state: EditorState
  path: string
  scrollTop: number
  scrollLeft: number
}
function cachedEditor(value: unknown, path: string): CachedEditor | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const entry = value as Partial<CachedEditor>
  return entry.token === cacheToken && entry.path === path && entry.state instanceof EditorState
    && typeof entry.scrollTop === 'number' && typeof entry.scrollLeft === 'number'
    ? entry as CachedEditor : undefined
}

export function ControlledCodeEditor(props: CodeEditorRenderProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const live = useRef(props)
  const applying = useRef(false)
  useLayoutEffect(() => { live.current = props })
  useEffect(() => {
    if (host.current === null) return
    const theme = new CmThemeCompartment()
    const language = languageForPath(props.path)
    const extensions: Extension[] = [
      EditorView.lineWrapping, lineNumbers(), history(), search(), foldGutter(), bracketMatching(),
      EditorState.tabSize.of(2), EditorView.contentAttributes.of({ spellcheck: 'false' }),
      EditorState.readOnly.of(props.readOnly === true), EditorView.editable.of(props.readOnly !== true),
      cmSurfaceTheme, theme.of(isDarkScheme()), ...(language === null ? [] : [language]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applying.current) live.current.onChange(update.state.doc.toString())
      }),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { live.current.onSave?.(); return true } },
        indentWithTab, ...searchKeymap, ...foldKeymap, ...defaultKeymap, ...historyKeymap,
      ]),
    ]
    const cached = cachedEditor(props.stateCache?.get(props.documentKey), props.path)
    // Preserve state fields (history/selection/folds/search), but replace ALL
    // extensions so cached listeners/keymaps cannot retain an unmounted owner.
    let state = cached === undefined
      ? EditorState.create({ doc: live.current.content, extensions })
      : cached.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state
    if (state.doc.toString() !== live.current.content) {
      state = state.update({
        changes: { from: 0, to: state.doc.length, insert: live.current.content },
        annotations: Transaction.addToHistory.of(false),
      }).state
    }
    const editor = new EditorView({ parent: host.current, state })
    view.current = editor
    if (cached !== undefined) {
      editor.scrollDOM.scrollTop = cached.scrollTop
      editor.scrollDOM.scrollLeft = cached.scrollLeft
      // Restore after layout as well: virtualized content may not be measured
      // when the freshly mounted scroller first accepts its cached offset.
      editor.requestMeasure({ read: () => null, write: () => {
        editor.scrollDOM.scrollTop = cached.scrollTop
        editor.scrollDOM.scrollLeft = cached.scrollLeft
      } })
    }
    const unsubscribe = subscribeColorScheme(() => { editor.dispatch({ effects: theme.reconfigure(isDarkScheme()) }) })
    return () => {
      unsubscribe()
      props.stateCache?.set(props.documentKey, {
        token: cacheToken, state: editor.state, path: props.path,
        scrollTop: editor.scrollDOM.scrollTop, scrollLeft: editor.scrollDOM.scrollLeft,
      } satisfies CachedEditor)
      editor.destroy()
      view.current = null
    }
    // Callback/content updates are handled without rebuilding the view.
  }, [props.documentKey, props.path, props.readOnly, props.stateCache])
  useEffect(() => {
    const editor = view.current
    if (editor === null || editor.state.doc.toString() === props.content) return
    applying.current = true
    try {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: props.content },
        annotations: Transaction.addToHistory.of(false),
      })
    } finally { applying.current = false }
  }, [props.content])
  return <div className={props.className === undefined ? css.editorCm : `${css.editorCm} ${props.className}`} ref={host} />
}
