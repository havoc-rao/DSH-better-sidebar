/** Controlled file chrome: the consumer owns content, transport and commands. */
import { createElement, useLayoutEffect, useState, type ReactNode } from 'react'
import type { BetterSidebarService } from './service.ts'
import type { SessionScope } from './api.ts'
import type { FileDocumentState } from './resource-actions.ts'
import { ResourceActions } from './ResourceActions.tsx'
import { baseName } from './paths.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export interface FileViewerRenderProps {
  scope: SessionScope
  /** Absolute resource path, used for icons, identity and resource actions. */
  path: string
  title?: string
  /** Owned content slot (code editor, preview, loading, error or binary UI). */
  content: ReactNode
  /** Owned toolbar commands; no implicit local download/save/open actions. */
  actions?: ReactNode
  status?: ReactNode
  /** Live state for action guards; absent = unknown dirty and read-only. */
  documentState?: FileDocumentState
  /** Defaults to true. Disable when the consumer already seats ResourceActions. */
  showResourceActions?: boolean
}

/** The same header geometry used by EditorHost, with consumer-owned children. */
export function FileViewerHeader({ children }: { children: ReactNode }) {
  return <div className={css.editorHeader}>{children}</div>
}

function FileViewer({ service, ...props }: FileViewerRenderProps & { service: BetterSidebarService }) {
  const { path, scope, title, content, actions, status, documentState, showResourceActions } = props
  // fileIcon has no snapshot version; subscribe to registry mutations directly.
  const [, rerender] = useState(0)
  useLayoutEffect(() => service.subscribe(() => { rerender(value => value + 1) }), [service])
  const state = documentState ?? { dirty: 'unknown' as const, readOnly: true }
  return <div className={css.editor} data-dsh-file-viewer="" data-path={path}>
    <FileViewerHeader>
      <span aria-hidden="true">{service.fileIcon(path, 14)}</span>
      <span className={css.editorTitle} title={path}>{title ?? baseName(path)}</span>
      <span className={css.fileViewerPath} title={path}>{path}</span>
      {state.dirty === true && <span className={css.dirtyDot} title={t('unsaved')} />}
      {showResourceActions !== false && <ResourceActions service={service} readContext={() => ({
        kind: 'file', surface: 'file-viewer-toolbar', scope: { ...scope },
        absolutePath: path, isDirectory: false, ...state,
      })} />}
      {status}
      {actions}
    </FileViewerHeader>
    <div className={css.editorMain}>{content}</div>
  </div>
}

export function renderFileViewer(service: BetterSidebarService, props: FileViewerRenderProps): ReactNode {
  return createElement(FileViewer, { ...props, service })
}
