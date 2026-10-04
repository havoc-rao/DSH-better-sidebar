/** File-tree moves and conversation references have separate drop owners. */
import type { InputActions, ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { fileMention } from './conversation-draft.ts'
import { isAbsolutePath, relativeTo } from './paths.ts'

export const FILE_REFERENCE_MIME = 'application/x-dsh-sidebar-file-reference+json'
export const TREE_DRAG_MIME = 'application/x-dsh-tree-drag'
export interface FileReferenceDrag { version: 1; path: string; isDir: boolean }

export function parseFileReferenceDrag(raw: string): FileReferenceDrag | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return undefined
    const { version, path, isDir } = value as Partial<FileReferenceDrag>
    if (version !== 1 || typeof path !== 'string' || typeof isDir !== 'boolean'
      || !isAbsolutePath(path) || !fileMention(path)) return undefined
    return { version, path, isDir }
  } catch { return undefined }
}

export function writeFileReferenceDrag(transfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>, path: string, isDir: boolean): void {
  transfer.setData(TREE_DRAG_MIME, path)
  transfer.effectAllowed = 'copyMove'
  // Unrepresentable names still participate in tree moves, never raw-text drops.
  if (parseFileReferenceDrag(JSON.stringify({ version: 1, path, isDir }))) {
    transfer.setData(FILE_REFERENCE_MIME, JSON.stringify({ version: 1, path, isDir }))
  }
}

/** New public actions are feature-detected: the pinned host has only insertText. */
export type FileReferenceActions = Pick<InputActions, 'captureInsertion' | 'insertText'> & {
  insertReference?: (reference: ReferenceInsert, span: TokenSpan) => boolean
  focus?: () => void
}
export function canInsertFileReference(actions: FileReferenceActions): boolean {
  return typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function'
    && typeof actions.insertReference === 'function' && typeof actions.focus === 'function'
}

export function insertDroppedFileReference(actions: FileReferenceActions, payload: FileReferenceDrag, cwd: string | undefined): boolean {
  if (!canInsertFileReference(actions)) return false
  const relative = relativeTo(cwd ?? '', payload.path)
  // Format the trailing slash INSIDE quotes for directory names with spaces.
  const reference = fileMention(relative)
  if (!reference) return false
  const span = actions.captureInsertion()
  const folder = relative === '.' ? './' : `${relative.replace(/[\\/]+$/, '')}/`
  const folderText = /\s/u.test(folder) ? `@"${folder}"` : `@${folder}`
  const inserted = payload.isDir
    ? actions.insertText(folderText, span)
    : actions.insertReference!({ source: 'reference', ref: reference.mention,
      label: reference.label, appearance: 'file', clipboardText: reference.mention }, span)
  if (inserted) actions.focus!()
  return inserted
}
