/** Public explorer seat: actual TreePanel/FileTree UI with explicit remote authority. */
import { createElement, type ReactNode } from 'react'
import { api, type SessionScope } from './api.ts'
import { TreePanel } from './TreePanel.tsx'
import type { BetterSidebarService } from './service.ts'
import type { UploadItem, UploadResult } from './upload.ts'
export type { FsEntry, FsLevel } from './api.ts'
export type { UploadItem, UploadResult } from './upload.ts'

type Mutation = 'fsRename' | 'fsRemove' | 'fsMove' | 'fsCopy' | 'fsMkdir' | 'fsCreateFile'
export type FileExplorerSource = Pick<typeof api, 'fsTrees'> & Partial<Pick<typeof api, Mutation | 'fsSearch'>> & {
  download?(scope: SessionScope, path: string): void | Promise<void>
  upload?(scope: SessionScope, dir: string, items: UploadItem[], onProgress: (done: number, total: number, current: string) => void, signal?: AbortSignal): Promise<UploadResult[]>
}
export interface FileExplorerRenderProps {
  scope: SessionScope
  /** Change on machine/connection/provider generation change; fences cached data/actions. */
  sourceKey: string
  source: FileExplorerSource
  expanded: string[]
  revealed?: string[]
  onToggle(path: string): void
  onOpenFile(path: string): void
  /** Consumer owns remote @ reference syntax and composer integration. */
  onReferenceFile(path: string, isDir: boolean): void
  onOpenFileNewTab?(path: string): void
  onOpenFileSide?(path: string): void
  onPathRenamed?(oldPath: string, newPath: string): void
  onPathDeleted?(path: string, isDir: boolean): void
  visible?: boolean
  exclude?: readonly string[]
}
/** Missing methods fail closed even for keyboard/undo entry points. Never merge with api. */
export function strictExplorerApi(source: FileExplorerSource, signal?: AbortSignal): typeof api {
  return new Proxy(source, { get(target, key) {
    const method = Reflect.get(target, key)
    if (typeof method === 'function') return async (...args: unknown[]) => {
      if (signal?.aborted) throw new DOMException('Explorer retired', 'AbortError')
      if (key === 'fsTrees' || key === 'fsSearch') args[3] = args[3] ?? signal
      const result = await method.apply(target, args)
      if (signal?.aborted) throw new DOMException('Explorer retired', 'AbortError')
      return result
    }
    return () => Promise.reject(new Error(`File explorer operation unavailable: ${String(key)}`))
  } }) as unknown as typeof api
}
export function renderFileExplorer(service: BetterSidebarService, props: FileExplorerRenderProps): ReactNode {
  return createElement(TreePanel, {
    key: JSON.stringify([props.scope.sessionId, props.scope.cwd, props.sourceKey]),
    ...props, sessionId: props.scope.sessionId, cwd: props.scope.cwd,
    revealed: props.revealed ?? [], full: true, service, source: props.source,
  })
}
