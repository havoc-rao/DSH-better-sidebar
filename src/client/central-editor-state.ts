/** In-memory editor state only: no React, host service, IO, or draft persistence. */
export interface CentralEditorDocument {
  readonly path: string
  /** Unique for this open lifetime; reopening never inherits an old view cache. */
  readonly generation: number
  /** null means content has not loaded; an empty string is a real draft. */
  readonly draft: string | null
  readonly savedContent?: string
  readonly dirty: boolean
  readonly title: string
}

export interface CentralEditorSnapshot {
  readonly sessionId: string | undefined
  readonly documents: readonly CentralEditorDocument[]
  readonly activePath: string | null
  readonly visible: boolean
}

export interface OpenCentralEditorFileOptions {
  readonly title?: string
  readonly content?: string
}

export interface CloseCentralEditorFileOptions {
  readonly force?: boolean
}

function emptySnapshot(sessionId: string | undefined): CentralEditorSnapshot {
  return Object.freeze({ sessionId, documents: Object.freeze([]), activePath: null, visible: false })
}

/** Callers resolve/canonicalize paths before opening; identity is the exact absolute path. */
function assertAbsolutePath(path: string): void {
  if (path.includes('\0') || !(path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path))) {
    throw new Error('Central editor requires an absolute file path')
  }
}

function freezeSnapshot(snapshot: CentralEditorSnapshot): CentralEditorSnapshot {
  return Object.freeze({ ...snapshot, documents: Object.freeze([...snapshot.documents]) })
}

/**
 * All tabs are fixed; opening another file never replaces an existing document.
 * Switching sessions restores the same in-memory snapshot, including hidden drafts.
 * Async callers MUST capture the sessionId before IO and pass it to initializeContent
 * / markSaved, rather than using the potentially changed current-session default.
 * Serialize writes for each document: markSaved is called in successful commit order.
 */
export class CentralEditorStore {
  private nextGeneration = 0
  private readonly sessions = new Map<string, CentralEditorSnapshot>()
  private readonly listeners = new Set<() => void>()
  private readonly unselected = emptySnapshot(undefined)
  private snapshot: CentralEditorSnapshot = this.unselected

  /** Bound and stable for external-store consumers; unchanged state keeps its reference. */
  readonly getSnapshot = (): CentralEditorSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Includes hidden/background sessions for the browser's unload guard. */
  hasDirtyDocuments(): boolean {
    return [...this.sessions.values()].some(session => session.documents.some(document => document.dirty))
  }

  /** A read does not allocate or register a missing session. */
  getSessionSnapshot(sessionId: string): CentralEditorSnapshot | undefined {
    return this.sessions.get(sessionId)
  }

  setSession(sessionId: string | undefined): void {
    if (sessionId === this.snapshot.sessionId) return
    if (sessionId === undefined) {
      this.snapshot = this.unselected
    } else {
      const next = this.sessions.get(sessionId) ?? emptySnapshot(sessionId)
      this.sessions.set(sessionId, next)
      this.snapshot = next
    }
    this.emit()
  }

  openFile(path: string, options: OpenCentralEditorFileOptions = {}, sessionId = this.snapshot.sessionId): boolean {
    assertAbsolutePath(path)
    if (sessionId === undefined) return false
    const previous = this.sessions.get(sessionId) ?? emptySnapshot(sessionId)
    const existing = previous.documents.find(document => document.path === path)
    let documents = previous.documents
    if (!existing) {
      const title = options.title ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
      const document: CentralEditorDocument = Object.freeze({
        path, generation: ++this.nextGeneration, title, draft: options.content ?? null, dirty: false,
        ...(options.content !== undefined ? { savedContent: options.content } : {}),
      })
      documents = [...documents, document]
    } else if (options.content !== undefined && existing.savedContent === undefined) {
      documents = documents.map(document => document !== existing ? document : Object.freeze({
        ...document, savedContent: options.content,
        draft: document.draft ?? options.content!,
        dirty: (document.draft ?? options.content) !== options.content,
      }))
    }
    if (documents !== previous.documents || previous.activePath !== path || !previous.visible) {
      this.commit(sessionId, { ...previous, documents, activePath: path, visible: true })
    }
    return true
  }

  setActivePath(path: string, sessionId = this.snapshot.sessionId): boolean {
    const previous = this.session(sessionId)
    if (!previous || !previous.documents.some(document => document.path === path)) return false
    if (previous.activePath !== path) this.commit(sessionId!, { ...previous, activePath: path })
    return true
  }

  /** Hiding the editor preserves documents, selection, and all unsaved drafts. */
  setVisible(visible: boolean, sessionId = this.snapshot.sessionId): boolean {
    const previous = this.session(sessionId)
    if (!previous) return false
    if (previous.visible !== visible) this.commit(sessionId!, { ...previous, visible })
    return true
  }

  /** False means missing document or dirty refusal; rejection is completely non-mutating. */
  closeFile(path: string, options: CloseCentralEditorFileOptions = {}, sessionId = this.snapshot.sessionId): boolean {
    const previous = this.session(sessionId)
    const index = previous?.documents.findIndex(document => document.path === path) ?? -1
    if (!previous || index < 0) return false
    if (previous.documents[index]!.dirty && options.force !== true) return false
    const documents = previous.documents.filter(document => document.path !== path)
    const activePath = previous.activePath === path
      ? (documents[Math.min(index, documents.length - 1)]?.path ?? null)
      : previous.activePath
    this.commit(sessionId!, { ...previous, documents, activePath, visible: documents.length > 0 && previous.visible })
    return true
  }

  /** First load establishes the baseline without replacing input typed before it arrived. */
  initializeContent(path: string, content: string, sessionId = this.snapshot.sessionId): boolean {
    return this.updateDocument(path, sessionId, document => {
      if (document.savedContent !== undefined) return document
      const draft = document.draft ?? content
      return { ...document, savedContent: content, draft, dirty: draft !== content }
    })
  }

  updateDraft(path: string, draft: string, sessionId = this.snapshot.sessionId): boolean {
    return this.updateDocument(path, sessionId, document => {
      const dirty = draft !== document.savedContent
      if (document.draft === draft && document.dirty === dirty) return document
      return { ...document, draft, dirty }
    })
  }

  /**
   * Pass the text actually submitted to the successful write, NOT the latest draft.
   * A later edit stays dirty relative to that committed text; this never overwrites it.
   */
  markSaved(path: string, submittedContent: string, sessionId = this.snapshot.sessionId): boolean {
    return this.updateDocument(path, sessionId, document => {
      const draft = document.draft ?? submittedContent
      const dirty = draft !== submittedContent
      if (document.savedContent === submittedContent && document.draft === draft && document.dirty === dirty) return document
      return { ...document, savedContent: submittedContent, draft, dirty }
    })
  }

  private session(sessionId: string | undefined): CentralEditorSnapshot | undefined {
    return sessionId === undefined ? undefined : this.sessions.get(sessionId)
  }

  private updateDocument(path: string, sessionId: string | undefined, update: (document: CentralEditorDocument) => CentralEditorDocument): boolean {
    const previous = this.session(sessionId)
    const document = previous?.documents.find(candidate => candidate.path === path)
    if (!previous || !document) return false
    const next = update(document)
    if (next !== document) {
      this.commit(sessionId!, { ...previous, documents: previous.documents.map(candidate => candidate === document ? Object.freeze(next) : candidate) })
    }
    return true
  }

  private commit(sessionId: string, next: CentralEditorSnapshot): void {
    const frozen = freezeSnapshot(next)
    this.sessions.set(sessionId, frozen)
    if (this.snapshot.sessionId === sessionId) {
      this.snapshot = frozen
      this.emit()
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export function createCentralEditorStore(): CentralEditorStore {
  return new CentralEditorStore()
}
