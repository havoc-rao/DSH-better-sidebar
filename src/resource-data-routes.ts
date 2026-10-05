/** Isolated resource routes: legacy fs/git semantics are deliberately untouched.
 * Conditional saves are NOT filesystem CAS: external writers, aliases and other
 * host instances can still race the last content check and rename.
 */
import { constants } from 'node:fs'
import { access, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { TextDecoder } from 'node:util'
import * as git from './git.ts'
import { invalidateDirectoryCache } from './fs-tree.ts'
import { SidebarError, requireString } from './wire.ts'

export const RESOURCE_PATCH_BYTE_LIMIT = 4 * 1024 * 1024
export type ResourceTextRead =
  | { kind: 'text'; content: string; truncated: boolean; writable: boolean; byteLength: number }
  | { kind: 'binary'; byteLength: number }
export interface ResourceDiffFile {
  oldPath: string | null
  newPath: string | null
  change: 'added' | 'deleted' | 'modified' | 'renamed' | 'mode'
  editableAbsolutePath?: string
}
export interface ResourceStrictDiff {
  requestedSide: 'staged' | 'unstaged'
  patch: string
  empty: boolean
  binary: boolean
  truncated: boolean
  untracked?: { content: string | null; binary: boolean; truncated: boolean }
  files: ResourceDiffFile[]
}

function failure(error: unknown): never {
  if (error instanceof SidebarError) throw error
  const code = (error as NodeJS.ErrnoException)?.code
  throw new SidebarError(code === 'ENOENT' ? 'not-found' : code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'fs-error', error instanceof Error ? error.message : String(error), code === 'ENOENT' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 400)
}
function absolute(raw: string): string {
  if (!isAbsolute(raw) || raw.includes('\0')) throw new SidebarError('invalid-path', 'an absolute path without NUL is required')
  return resolve(raw)
}
function stringField(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null)?.[key]
  if (typeof value !== 'string') throw new SidebarError('bad-request', `missing or invalid "${key}"`)
  return value
}
function identity(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
async function readDocument(path: string, limit: number): Promise<ResourceTextRead> {
  try {
    const handle = await open(path, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new SidebarError('invalid-path', 'document must be a regular file')
      // One extra byte detects growth after stat without reading unbounded data.
      const buffer = Buffer.alloc(limit + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length)
        if (result.bytesRead === 0) break
        length += result.bytesRead
      }
      const truncated = info.size > limit || length > limit
      const bytes = buffer.subarray(0, Math.min(length, limit))
      if (bytes.includes(0)) return { kind: 'binary', byteLength: Math.max(info.size, length) }
      let content: string
      try {
        // Streaming decode permits a cut UTF-8 codepoint only on truncated reads.
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated })
      } catch { return { kind: 'binary', byteLength: Math.max(info.size, length) } }
      const writable = !truncated && await access(path, constants.W_OK).then(() => true, () => false)
      return { kind: 'text', content, truncated, writable, byteLength: Math.max(info.size, length) }
    } finally { await handle.close() }
  } catch (error) { failure(error) }
}

// Shared across route builders/sessions; canonical path queues serialize aliases
// resolved at admission, not all possible future filesystem alias changes.
const writes = new Map<string, Promise<unknown>>()
async function serialize<T>(path: string, run: () => Promise<T>): Promise<T> {
  const key = identity(path)
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
  writes.set(key, pending)
  try { return await pending } finally { if (writes.get(key) === pending) writes.delete(key) }
}
async function checkContent(path: string, expected: string, limit: number): Promise<void> {
  const current = await readDocument(path, limit)
  if (current.kind === 'binary') throw new SidebarError('conflict', 'current document is binary or invalid UTF-8', 409)
  if (current.truncated) throw new SidebarError('too-large', 'current document exceeds the text read limit', 413)
  if (current.content !== expected) throw new SidebarError('conflict', 'document content changed since the complete read', 409)
  if (!current.writable) throw new SidebarError('permission-denied', 'document is not writable', 403)
}

/** Bounded at the stdout stream, never accumulate unlimited output then slice.
 * stderr is separately capped; killing on overflow yields a truncated prefix.
 */
export function runResourceGit(cwd: string, args: string[], limit = RESOURCE_PATCH_BYTE_LIMIT): Promise<{ bytes: Buffer; truncated: boolean }> {
  return new Promise((accept, reject) => {
    const child = spawn('git', ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30_000)
    child.stdout.on('data', (chunk: Buffer) => {
      const room = limit - size
      if (room > 0) { const kept = chunk.subarray(0, room); chunks.push(kept); size += kept.length }
      if (chunk.length > room) { truncated = true; child.kill('SIGKILL') }
    })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.subarray(0, 8192 - stderr.length).toString('utf8') })
    child.on('error', error => { clearTimeout(timer); reject(new SidebarError('git-error', error.message)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(new SidebarError('git-error', 'git request timed out'))
      else if (truncated || code === 0) accept({ bytes: Buffer.concat(chunks, size), truncated })
      else reject(new SidebarError('git-error', stderr.trim() || `git exited with ${String(code)}`))
    })
  })
}

/** --raw -z uses lossless NUL paths, avoiding quoted-patch path heuristics. */
export function resourceDiffMetadata(bytes: Buffer, root: string, unchangedContentPaths?: ReadonlySet<string>): ResourceDiffFile[] {
  // A stream cap may cut a filename or either half of a rename pair. Only
  // NUL-terminated tokens can be identities, never the trailing partial token.
  const end = bytes.lastIndexOf(0)
  const tokens: Array<string | null> = end < 0 ? [] : bytes.subarray(0, end + 1).toString('latin1').split('\0').slice(0, -1).map(token => {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(token, 'latin1')) }
    catch { return null }
  })
  const files: ResourceDiffFile[] = []
  for (let i = 0; i < tokens.length; i++) {
    const header = tokens[i]
    if (header === null || header === undefined) continue
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDRCT])\d*$/.exec(header)
    if (!match) continue
    const first = tokens[++i]
    const rename = match[5] === 'R' || match[5] === 'C'
    const second = rename ? tokens[++i] : first
    if (first === undefined || second === undefined) break
    if (!first || !second) continue
    const oldPath = match[5] === 'A' ? null : first
    const newPath = match[5] === 'D' ? null : second
    const change = match[5] === 'A' ? 'added' : match[5] === 'D' ? 'deleted' : rename ? 'renamed' : match[1] !== match[2] && (unchangedContentPaths === undefined ? match[3] === match[4] : unchangedContentPaths.has(first)) ? 'mode' : 'modified'
    const target = newPath === null ? undefined : resolve(root, newPath)
    const rel = target === undefined ? '..' : relative(root, target)
    files.push({ oldPath, newPath, change, ...(target !== undefined && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? { editableAbsolutePath: target } : {}) })
  }
  return files
}

/** Only complete 0/0 numstat records prove a mode-only change. Rename
 * numstat records carry two extra NUL paths; neither is a mode candidate. */
function unchangedPaths(bytes: Buffer): Set<string> {
  const end = bytes.lastIndexOf(0)
  const paths = new Set<string>()
  if (end < 0) return paths
  const tokens = bytes.subarray(0, end + 1).toString('latin1').split('\0').slice(0, -1)
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i]!
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(record)
    if (!match) continue
    if (match[3] === '') { i += 2; continue }
    if (match[1] !== '0' || match[2] !== '0') continue
    try { paths.add(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(match[3]!, 'latin1'))) }
    catch { /* Invalid filesystem bytes are never editable path identities. */ }
  }
  return paths
}

export function buildResourceDataApi(options: {
  cwdOf(payload: unknown): Promise<{ sessionId: string; cwd: string }>
  readLimit: number
}): Record<string, (payload: unknown) => Promise<unknown>> {
  return {
    'document.read': async payload => {
      await options.cwdOf(payload)
      return readDocument(absolute(requireString(payload, 'path')), options.readLimit)
    },
    'document.write': async payload => {
      await options.cwdOf(payload)
      const path = absolute(requireString(payload, 'path'))
      const content = stringField(payload, 'content')
      const expected = stringField(payload, 'expectedContent')
      if (content.includes('\0') || Buffer.from(content, 'utf8').toString('utf8') !== content) throw new SidebarError('invalid-path', 'replacement must be valid UTF-8 text without NUL')
      if (Buffer.byteLength(content) > options.readLimit || Buffer.byteLength(expected) > options.readLimit) throw new SidebarError('too-large', 'document exceeds the text read limit', 413)
      let canonical: string
      try { canonical = await realpath(path) } catch (error) { failure(error) }
      return serialize(canonical, async () => {
        const tmp = `${canonical}.dsh-document-${randomUUID()}.tmp`
        try {
          await checkContent(canonical, expected, options.readLimit)
          const info = await open(canonical, 'r').then(async handle => { try { return await handle.stat() } finally { await handle.close() } })
          await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx', mode: info.mode })
          if (identity(await realpath(path)) !== identity(canonical)) throw new SidebarError('conflict', 'document path target changed', 409)
          await checkContent(canonical, expected, options.readLimit)
          await rename(tmp, canonical)
          invalidateDirectoryCache(dirname(path))
          return {}
        } catch (error) { failure(error) }
        finally { await rm(tmp, { force: true }).catch(() => {}) }
      })
    },
    'git.diff-strict': async payload => {
      const { cwd } = await options.cwdOf(payload)
      const record = payload as { repoRoot?: unknown; ref?: unknown }
      const ref = record.ref as { kind?: unknown; repoRoot?: unknown; worktree?: unknown; path?: unknown; staged?: unknown; untracked?: unknown } | null
      if (ref?.kind !== 'worktree' || typeof ref.staged !== 'boolean') throw new SidebarError('bad-request', 'a worktree ref with boolean staged is required')
      const scopeRoot = record.repoRoot === undefined ? undefined : absolute(stringField(record, 'repoRoot'))
      const refRoot = ref.repoRoot === undefined ? undefined : absolute(stringField(ref, 'repoRoot'))
      if (scopeRoot && refRoot && identity(scopeRoot) !== identity(refRoot)) throw new SidebarError('invalid-scope', 'scope and ref repoRoot disagree')
      const selected = refRoot ?? scopeRoot
      // Unlike legacy repoRoot(), strict requests cannot silently choose another root.
      if (selected && !(await git.repoRoots(cwd)).some(root => identity(root) === identity(selected))) throw new SidebarError('invalid-scope', 'repoRoot is not an authorized session repository')
      const requested = ref.worktree === undefined ? undefined : absolute(stringField(ref, 'worktree'))
      let checkout: string
      // The selected root has already passed the authoritative session-root
      // allowlist. Validate the checkout against THAT repository's inventory,
      // not a sibling discovered from a container cwd.
      try { checkout = await git.resolveWorktree(selected ?? cwd, requested) } catch (error) { throw new SidebarError('invalid-scope', error instanceof Error ? error.message : String(error)) }
      const root = await git.repoRoot(checkout, requested === undefined ? selected : undefined).catch((error: unknown) => {
        throw new SidebarError('git-error', error instanceof Error ? error.message : String(error))
      })
      const path = ref.path === undefined ? undefined : stringField(ref, 'path')
      if (path !== undefined && (path.includes('\0') || path === '')) throw new SidebarError('invalid-path', 'invalid Git path')
      const target = path === undefined ? undefined : resolve(root, path)
      const rel = target === undefined ? undefined : relative(root, target)
      if (rel !== undefined && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new SidebarError('invalid-path', 'Git path must be inside the requested repository')
      const suffix = rel === undefined ? [] : ['--', `:(literal)${rel}`]
      const side = ref.staged ? ['--cached'] : []
      const common = ['--no-ext-diff', '--no-textconv', '--no-color', ...side]
      const [patch, raw, numstat] = await Promise.all([
        runResourceGit(root, ['diff', ...common, '-U3', ...suffix]),
        runResourceGit(root, ['diff', ...common, '--raw', '-z', '--abbrev=40', ...suffix]),
        runResourceGit(root, ['diff', ...common, '--numstat', '-z', ...suffix]),
      ])
      let text = ''
      let invalidUtf8 = false
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(patch.bytes, { stream: patch.truncated }) }
      catch { invalidUtf8 = true }
      const result: ResourceStrictDiff = { requestedSide: ref.staged ? 'staged' : 'unstaged', patch: text, empty: patch.bytes.length === 0 && raw.bytes.length === 0, binary: invalidUtf8 || /^(?:Binary files .* differ|GIT binary patch)$/m.test(text), truncated: patch.truncated || raw.truncated || numstat.truncated, files: resourceDiffMetadata(raw.bytes, root, unchangedPaths(numstat.bytes)) }
      if (!ref.staged && target !== undefined && result.empty) {
        const untracked = await runResourceGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', `:(literal)${rel!}`])
        result.truncated ||= untracked.truncated
        const completeEnd = untracked.bytes.lastIndexOf(0)
        const completePaths = completeEnd < 0 ? [] : untracked.bytes.subarray(0, completeEnd + 1).toString('utf8').split('\0').slice(0, -1)
        if (completePaths.includes(rel!)) {
          const document = await readDocument(target, options.readLimit)
          const binary = document.kind === 'binary'
          const truncated = document.kind === 'text' && document.truncated
          result.untracked = { content: document.kind === 'text' ? document.content : null, binary, truncated }
          result.binary = binary
          result.truncated ||= truncated
          result.empty = false
          result.files = [{ oldPath: null, newPath: rel!, change: 'added', editableAbsolutePath: target }]
        }
      }
      return result
    },
  }
}
