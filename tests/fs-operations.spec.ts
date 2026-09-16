import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { copyWorkspaceEntry, moveWorkspaceEntry, renameWorkspaceEntry, removeWorkspaceEntry, writeWorkspaceUpload } from '../src/fs-operations.ts'

/** The test workspace root (each suite gets its own temp tree). */
const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upload-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Names of leftover temp files under `dir` (must be empty after every run). */
function tmpLeftovers(dir: string): string[] {
  return readdirSync(dir).filter(name => name.includes('.dsh-upload-'))
}

/** Turn a string into the async-iterable chunk shape the route receives. */
function chunksOf(text: string): AsyncIterable<string | Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      // Split on two-byte boundaries so UTF-8 multi-byte sequences cross
      // chunk edges (streaming must reassemble them as raw bytes, not text).
      for (let i = 0; i < text.length; i += 2) yield text.slice(i, i + 2)
    },
  }
}

describe('writeWorkspaceUpload', () => {
  it('writes a file under the upload directory and returns its size', async () => {
    const { path, size } = await writeWorkspaceUpload({
      cwd: root,
      dir: root,
      relativePath: 'a.txt',
      chunks: chunksOf('hello 世界'),
      limit: 1024,
    })
    expect(path).toBe(join(root, 'a.txt'))
    expect(size).toBe(Buffer.byteLength('hello 世界'))
    expect(readFileSync(path, 'utf8')).toBe('hello 世界')
  })

  it('creates nested directories on demand (folder uploads)', async () => {
    const { path } = await writeWorkspaceUpload({
      cwd: root,
      dir: root,
      relativePath: 'docs/nested/deep.txt',
      chunks: chunksOf('x'),
      limit: 1024,
    })
    expect(existsSync(path)).toBe(true)
  })

  it('resolves relativePaths against the chosen directory', async () => {
    const { path } = await writeWorkspaceUpload({
      cwd: root,
      dir: join(root, 'docs'),
      relativePath: 'b.txt',
      chunks: chunksOf('y'),
      limit: 1024,
    })
    expect(path).toBe(join(root, 'docs', 'b.txt'))
  })

  it('refuses traversal, empty segments, and absolute relativePaths', async () => {
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: '../evil.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: './a.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: 'a/../b.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: '//', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    // Empty segments are refused, not silently collapsed.
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: 'a//b.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: 'a/b/', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    // Absolute paths (POSIX and Windows separators) are refused, not re-anchored.
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: '/x.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: '\\x.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('refuses an upload directory outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upload-outside-'))
    try {
      await expect(writeWorkspaceUpload({
        cwd: root, dir: outside, relativePath: 'x.txt', chunks: chunksOf('x'), limit: 1024,
      })).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses upload directories and targets that resolve outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upload-symlink-outside-'))
    const link = join(root, 'upload-link')
    try {
      symlinkSync(outside, link)
      await expect(writeWorkspaceUpload({
        cwd: root, dir: link, relativePath: 'x.txt', chunks: chunksOf('x'), limit: 1024,
      })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(writeWorkspaceUpload({
        cwd: root, dir: root, relativePath: 'upload-link/x.txt', chunks: chunksOf('x'), limit: 1024,
      })).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      rmSync(link, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses oversized uploads without leaving a target or temp file', async () => {
    const target = join(root, 'big.bin')
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: 'big.bin', chunks: chunksOf('1234567890'), limit: 4,
    })).rejects.toMatchObject({ code: 'too-large' })
    expect(existsSync(target)).toBe(false)
    expect(tmpLeftovers(root)).toEqual([])
  })

  it('keeps concurrent uploads to the same target independent', async () => {
    const target = join(root, 'race.txt')
    await Promise.all([
      writeWorkspaceUpload({ cwd: root, dir: root, relativePath: 'race.txt', chunks: chunksOf('first'), limit: 1024 }),
      writeWorkspaceUpload({ cwd: root, dir: root, relativePath: 'race.txt', chunks: chunksOf('second'), limit: 1024 }),
    ])
    // Both renames succeed (unique temp names, no EEXIST cross-talk); the last
    // rename wins and the losers leave nothing behind.
    expect(['first', 'second']).toContain(readFileSync(target, 'utf8'))
    expect(tmpLeftovers(root)).toEqual([])
  })

  it('does not overwrite an existing file on a failed (oversized) retry', async () => {
    const target = join(root, 'keep.txt')
    await writeWorkspaceUpload({ cwd: root, dir: root, relativePath: 'keep.txt', chunks: chunksOf('original'), limit: 1024 })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: 'keep.txt', chunks: chunksOf('0123456789'), limit: 2,
    })).rejects.toMatchObject({ code: 'too-large' })
    expect(readFileSync(target, 'utf8')).toBe('original')
  })
})

describe('renameWorkspaceEntry', () => {
  it('renames a file within its directory', async () => {
    writeFileSync(join(root, 'old-name.txt'), 'x')
    const { path } = await renameWorkspaceEntry({ cwd: root, path: join(root, 'old-name.txt'), name: 'new-name.txt' })
    // The returned path is CANONICAL (realpath-resolved ancestors — on macOS
    // the tmpdir's /var becomes /private/var), so assert the shape, not the
    // lexical spelling.
    expect(path.endsWith('new-name.txt')).toBe(true)
    expect(existsSync(join(root, 'old-name.txt'))).toBe(false)
    expect(existsSync(join(root, 'new-name.txt'))).toBe(true)
  })

  it('renames a directory (recursive content moves with it)', async () => {
    mkdirSync(join(root, 'olddir/nested'), { recursive: true })
    writeFileSync(join(root, 'olddir/nested/deep.txt'), 'x')
    await renameWorkspaceEntry({ cwd: root, path: join(root, 'olddir'), name: 'newdir' })
    expect(readFileSync(join(root, 'newdir/nested/deep.txt'), 'utf8')).toBe('x')
  })

  it('is a no-op for the same name (destination-exists refusal must not bite)', async () => {
    writeFileSync(join(root, 'same.txt'), 'x')
    await renameWorkspaceEntry({ cwd: root, path: join(root, 'same.txt'), name: 'same.txt' })
    expect(existsSync(join(root, 'same.txt'))).toBe(true)
  })

  it('refuses single-segment violations (empty, dot, traversal, separators)', async () => {
    writeFileSync(join(root, 'r.txt'), 'x')
    for (const name of ['', '.', '..', 'a/b', 'a\\b']) {
      await expect(renameWorkspaceEntry({ cwd: root, path: join(root, 'r.txt'), name }))
        .rejects.toMatchObject({ code: 'bad-request' })
    }
  })

  it('refuses an existing destination instead of clobbering it', async () => {
    writeFileSync(join(root, 'src.txt'), 'src')
    writeFileSync(join(root, 'dst.txt'), 'dst')
    await expect(renameWorkspaceEntry({ cwd: root, path: join(root, 'src.txt'), name: 'dst.txt' }))
      .rejects.toMatchObject({ code: 'fs-error', status: 409 })
    expect(readFileSync(join(root, 'dst.txt'), 'utf8')).toBe('dst')
  })

  it('refuses the workspace root and missing sources', async () => {
    await expect(renameWorkspaceEntry({ cwd: root, path: root, name: 'nope' }))
      .rejects.toMatchObject({ code: 'fs-error' })
    await expect(renameWorkspaceEntry({ cwd: root, path: join(root, 'missing.txt'), name: 'x' }))
      .rejects.toMatchObject({ code: 'fs-error' })
  })

  it('renames a symlink ROW, not its target', async () => {
    writeFileSync(join(root, 'target.txt'), 't')
    symlinkSync(join(root, 'target.txt'), join(root, 'alias.txt'))
    await renameWorkspaceEntry({ cwd: root, path: join(root, 'alias.txt'), name: 'alias2.txt' })
    expect(existsSync(join(root, 'alias.txt'))).toBe(false)
    expect(existsSync(join(root, 'alias2.txt'))).toBe(true)
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('t')
  })
})

describe('removeWorkspaceEntry', () => {
  it('unlinks a file', async () => {
    writeFileSync(join(root, 'gone.txt'), 'x')
    await removeWorkspaceEntry({ cwd: root, path: join(root, 'gone.txt') })
    expect(existsSync(join(root, 'gone.txt'))).toBe(false)
  })

  it('removes a directory recursively', async () => {
    mkdirSync(join(root, 'tree/sub'), { recursive: true })
    writeFileSync(join(root, 'tree/sub/leaf.txt'), 'x')
    await removeWorkspaceEntry({ cwd: root, path: join(root, 'tree') })
    expect(existsSync(join(root, 'tree'))).toBe(false)
  })

  it('unlinks a symlink row without touching (or recursing into) its target', async () => {
    mkdirSync(join(root, 'realdir'), { recursive: true })
    writeFileSync(join(root, 'realdir/keep.txt'), 'x')
    symlinkSync(join(root, 'realdir'), join(root, 'linkdir'))
    await removeWorkspaceEntry({ cwd: root, path: join(root, 'linkdir') })
    expect(existsSync(join(root, 'linkdir'))).toBe(false)
    expect(readFileSync(join(root, 'realdir/keep.txt'), 'utf8')).toBe('x')
  })

  it('refuses the workspace root and missing paths', async () => {
    await expect(removeWorkspaceEntry({ cwd: root, path: root }))
      .rejects.toMatchObject({ code: 'fs-error' })
    await expect(removeWorkspaceEntry({ cwd: root, path: join(root, 'no-such.txt') }))
      .rejects.toMatchObject({ code: 'fs-error' })
  })
})

describe('moveWorkspaceEntry', () => {
  it('moves a file across directories', async () => {
    mkdirSync(join(root, 'dest'), { recursive: true })
    writeFileSync(join(root, 'movable.txt'), 'm')
    const { path } = await moveWorkspaceEntry({ cwd: root, path: join(root, 'movable.txt'), dir: join(root, 'dest') })
    expect(path.endsWith(join('dest', 'movable.txt'))).toBe(true)
    expect(existsSync(join(root, 'movable.txt'))).toBe(false)
    expect(readFileSync(join(root, 'dest/movable.txt'), 'utf8')).toBe('m')
  })

  it('moves a directory with its whole subtree (into the workspace root)', async () => {
    mkdirSync(join(root, 'inner/src/nested'), { recursive: true })
    writeFileSync(join(root, 'inner/src/nested/deep.txt'), 'deep')
    const { path } = await moveWorkspaceEntry({ cwd: root, path: join(root, 'inner/src'), dir: root })
    // A move to the workspace root is legal (drops on the tree body).
    expect(path.endsWith(join(root, 'src'))).toBe(true)
    expect(existsSync(join(root, 'inner/src'))).toBe(false)
    expect(readFileSync(join(root, 'src/nested/deep.txt'), 'utf8')).toBe('deep')
  })

  it('is a no-op for the same parent directory', async () => {
    writeFileSync(join(root, 'stay.txt'), 's')
    const { path } = await moveWorkspaceEntry({ cwd: root, path: join(root, 'stay.txt'), dir: root })
    expect(path.endsWith('stay.txt')).toBe(true)
    expect(existsSync(join(root, 'stay.txt'))).toBe(true)
  })

  it('refuses an existing destination instead of clobbering it', async () => {
    mkdirSync(join(root, 'dest'), { recursive: true })
    writeFileSync(join(root, 'clash.txt'), 'src')
    writeFileSync(join(root, 'dest/clash.txt'), 'dst')
    await expect(moveWorkspaceEntry({ cwd: root, path: join(root, 'clash.txt'), dir: join(root, 'dest') }))
      .rejects.toMatchObject({ code: 'fs-error', status: 409 })
    expect(readFileSync(join(root, 'dest/clash.txt'), 'utf8')).toBe('dst')
  })

  it('refuses moving a directory into itself or a descendant', async () => {
    mkdirSync(join(root, 'box/inner'), { recursive: true })
    for (const dir of [join(root, 'box'), join(root, 'box/inner')]) {
      await expect(moveWorkspaceEntry({ cwd: root, path: join(root, 'box'), dir }))
        .rejects.toMatchObject({ code: 'fs-error', message: expect.stringContaining('into itself') })
    }
    expect(existsSync(join(root, 'box/inner'))).toBe(true)
  })

  it('refuses the workspace root, missing sources, and non-directory destinations', async () => {
    await expect(moveWorkspaceEntry({ cwd: root, path: root, dir: root }))
      .rejects.toMatchObject({ code: 'fs-error' })
    await expect(moveWorkspaceEntry({ cwd: root, path: join(root, 'missing.txt'), dir: root }))
      .rejects.toMatchObject({ code: 'fs-error' })
    writeFileSync(join(root, 'not-a-dir.txt'), 'x')
    await expect(moveWorkspaceEntry({ cwd: root, path: join(root, 'not-a-dir.txt'), dir: join(root, 'not-a-dir.txt') }))
      .rejects.toMatchObject({ code: 'fs-error', message: expect.stringContaining('not a directory') })
    await expect(moveWorkspaceEntry({ cwd: root, path: join(root, 'not-a-dir.txt'), dir: join(root, 'ghost-dir') }))
      .rejects.toMatchObject({ code: 'fs-error' })
  })

  it('moves a symlink ROW, not its target', async () => {
    mkdirSync(join(root, 'dest'), { recursive: true })
    writeFileSync(join(root, 'target.txt'), 't')
    symlinkSync(join(root, 'target.txt'), join(root, 'alias.txt'))
    const { path } = await moveWorkspaceEntry({ cwd: root, path: join(root, 'alias.txt'), dir: join(root, 'dest') })
    expect(path.endsWith(join('dest', 'alias.txt'))).toBe(true)
    expect(existsSync(join(root, 'alias.txt'))).toBe(false)
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('t')
  })

  it('refuses a destination outside the workspace while the fence is armed', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-sidebar-outside-'))
    try {
      writeFileSync(join(root, 'fenced.txt'), 'f')
      await expect(moveWorkspaceEntry({ cwd: root, path: join(root, 'fenced.txt'), dir: outside }))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(moveWorkspaceEntry({ cwd: root, path: join(root, 'fenced.txt'), dir: outside, fence: false }))
        .resolves.toMatchObject({})
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('copyWorkspaceEntry', () => {
  it('copies a file into another directory and leaves the source untouched', async () => {
    mkdirSync(join(root, 'dest'), { recursive: true })
    writeFileSync(join(root, 'copied.txt'), 'c')
    const { path } = await copyWorkspaceEntry({ cwd: root, path: join(root, 'copied.txt'), dir: join(root, 'dest') })
    expect(path.endsWith(join('dest', 'copied.txt'))).toBe(true)
    expect(readFileSync(join(root, 'copied.txt'), 'utf8')).toBe('c')
    expect(readFileSync(join(root, 'dest/copied.txt'), 'utf8')).toBe('c')
  })

  it('copies a directory recursively', async () => {
    mkdirSync(join(root, 'tree/nested'), { recursive: true })
    writeFileSync(join(root, 'tree/nested/leaf.txt'), 'leaf')
    const { path } = await copyWorkspaceEntry({ cwd: root, path: join(root, 'tree'), dir: join(root, 'dest') })
    expect(path.endsWith(join('dest', 'tree'))).toBe(true)
    expect(readFileSync(join(root, 'dest/tree/nested/leaf.txt'), 'utf8')).toBe('leaf')
    expect(readFileSync(join(root, 'tree/nested/leaf.txt'), 'utf8')).toBe('leaf')
  })

  it('copies a symlink row as a LINK (never dereferenced)', async () => {
    mkdirSync(join(root, 'dest-copy'), { recursive: true })
    writeFileSync(join(root, 'target-copy.txt'), 't')
    symlinkSync(join(root, 'target-copy.txt'), join(root, 'alias-copy.txt'))
    await copyWorkspaceEntry({ cwd: root, path: join(root, 'alias-copy.txt'), dir: join(root, 'dest-copy') })
    expect(existsSync(join(root, 'dest-copy/alias-copy.txt'))).toBe(true)
    expect(existsSync(join(root, 'alias-copy.txt'))).toBe(true)
    // The copy is a link whose target is the SAME original file, not a new
    // content clone — a dereferencing copy would double the inode.
    expect(readFileSync(join(root, 'dest-copy/alias-copy.txt'), 'utf8')).toBe('t')
  })

  it('refuses an existing destination (including a same-directory copy)', async () => {
    writeFileSync(join(root, 'dup.txt'), 'x')
    await expect(copyWorkspaceEntry({ cwd: root, path: join(root, 'dup.txt'), dir: root }))
      .rejects.toMatchObject({ code: 'fs-error', status: 409 })
    mkdirSync(join(root, 'dest'), { recursive: true })
    writeFileSync(join(root, 'taken.txt'), 'src')
    writeFileSync(join(root, 'dest/taken.txt'), 'dst')
    await expect(copyWorkspaceEntry({ cwd: root, path: join(root, 'taken.txt'), dir: join(root, 'dest') }))
      .rejects.toMatchObject({ code: 'fs-error', status: 409 })
    expect(readFileSync(join(root, 'dest/taken.txt'), 'utf8')).toBe('dst')
  })

  it('refuses the workspace root and self/descendant copies', async () => {
    mkdirSync(join(root, 'box/inner'), { recursive: true })
    await expect(copyWorkspaceEntry({ cwd: root, path: root, dir: join(root, 'box') }))
      .rejects.toMatchObject({ code: 'fs-error' })
    for (const dir of [join(root, 'box'), join(root, 'box/inner')]) {
      await expect(copyWorkspaceEntry({ cwd: root, path: join(root, 'box'), dir }))
        .rejects.toMatchObject({ code: 'fs-error', message: expect.stringContaining('into itself') })
    }
  })
})
