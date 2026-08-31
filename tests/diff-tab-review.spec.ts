/**
 * The review diff surface (the produced-files row's "review" button):
 * `loadReviewPatch` combines the uncommitted diff of EXACTLY the produced
 * paths, classifying untracked new files via `git status` (git diff never
 * lists them, so they render as full-file additions from their content);
 * `synthesizeAdditionPatch` is the pure section builder for those.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { api } from '../src/client/api.ts'
import { parseUnifiedDiff } from '../src/client/DiffView.tsx'
import { loadReviewPatch, synthesizeAdditionPatch } from '../src/client/DiffTab.tsx'
import { t } from '../src/client/locales.ts'

/** A review ref for the produced paths (session-relative in the tests). */
const review = (paths: string[]): { kind: 'review'; paths: string[] } => ({ kind: 'review', paths })

/** A git status snapshot rooted at /repo with the given porcelain rows. */
const status = (entries: { path: string; xy: string }[]) => ({
  isRepo: true,
  root: '/repo',
  entries,
})

beforeEach(() => { vi.restoreAllMocks() })

describe('synthesizeAdditionPatch', () => {
  it('renders one file of pure additions that DiffView parses (added badge)', () => {
    const text = synthesizeAdditionPatch('/repo/src/new.ts', 'line1\nline2\n', '/repo')
    const parsed = parseUnifiedDiff(text)
    expect(parsed.files).toHaveLength(1)
    const file = parsed.files[0]!
    expect(file.oldPath).toBe('/dev/null')
    expect(file.newPath).toBe('b/src/new.ts')
    expect(file.hunks[0]!.lines.map(line => line.kind)).toEqual(['add', 'add'])
    expect(file.hunks[0]!.lines.map(line => line.text)).toEqual(['line1', 'line2'])
    expect(file.hunks[0]!.lines.map(line => line.newNum)).toEqual([1, 2])
  })

  it('keeps the absolute path when no repo root is given', () => {
    const parsed = parseUnifiedDiff(synthesizeAdditionPatch('/repo/x.ts', 'a\n'))
    expect(parsed.files[0]!.newPath).toBe('b//repo/x.ts')
  })
})

describe('loadReviewPatch', () => {
  const scope = { sessionId: 's', cwd: '/repo' }

  it('throws notRepo when the workspace is not a git repository', async () => {
    vi.spyOn(api, 'gitStatus').mockResolvedValue({ isRepo: false, root: undefined, entries: [] })
    await expect(loadReviewPatch(scope, review(['a.ts']))).rejects.toThrow(t('notRepo'))
  })

  it('combines changed files in produced order (unstaged side first)', async () => {
    vi.spyOn(api, 'gitStatus').mockResolvedValue(status([
      { path: 'src/a.ts', xy: ' M' },
      { path: 'src/c.ts', xy: ' M' },
    ]))
    const gitDiff = vi.spyOn(api, 'gitDiff')
      .mockResolvedValueOnce({ diff: 'PATCH-A' })
      .mockResolvedValueOnce({ diff: 'PATCH-C' })
    const result = await loadReviewPatch(scope, review(['src/a.ts', 'src/c.ts']))
    expect(result.diff).toBe('PATCH-A\nPATCH-C')
    expect(gitDiff).toHaveBeenCalledTimes(2)
    expect(gitDiff).toHaveBeenNthCalledWith(1, { sessionId: 's', cwd: '/repo' }, '/repo/src/a.ts', false, undefined)
  })

  it('falls back to the staged side when the unstaged diff is empty', async () => {
    vi.spyOn(api, 'gitStatus').mockResolvedValue(status([{ path: 'src/staged.ts', xy: 'M ' }]))
    const gitDiff = vi.spyOn(api, 'gitDiff')
      .mockResolvedValueOnce({ diff: '' })
      .mockResolvedValueOnce({ diff: 'STAGED-PATCH' })
    const result = await loadReviewPatch(scope, review(['src/staged.ts']))
    expect(result.diff).toBe('STAGED-PATCH')
    expect(gitDiff).toHaveBeenNthCalledWith(1, { sessionId: 's', cwd: '/repo' }, '/repo/src/staged.ts', false, undefined)
    expect(gitDiff).toHaveBeenNthCalledWith(2, { sessionId: 's', cwd: '/repo' }, '/repo/src/staged.ts', true, undefined)
  })

  it('renders an untracked produced file as a full-file addition from its content', async () => {
    vi.spyOn(api, 'gitStatus').mockResolvedValue(status([{ path: 'src/new.ts', xy: '??' }]))
    vi.spyOn(api, 'fsRead').mockResolvedValue({ kind: 'text', content: 'hello\n', truncated: false })
    const gitDiff = vi.spyOn(api, 'gitDiff').mockResolvedValue({ diff: 'SHOULD-NOT-HAPPEN' })
    const result = await loadReviewPatch(scope, review(['src/new.ts']))
    const parsed = parseUnifiedDiff(result.diff)
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0]!.newPath).toBe('b/src/new.ts')
    expect(parsed.files[0]!.hunks[0]!.lines[0]!.text).toBe('hello')
    // Untracked paths never hit git diff — the content IS the change.
    expect(gitDiff).not.toHaveBeenCalled()
  })

  it('skips produced paths that carry no uncommitted change', async () => {
    vi.spyOn(api, 'gitStatus').mockResolvedValue(status([]))
    vi.spyOn(api, 'gitDiff').mockResolvedValue({ diff: '' })
    const result = await loadReviewPatch(scope, review(['src/clean.ts']))
    expect(result.diff).toBe('')
  })

  it('surfaces the first failure when every path fails', async () => {
    vi.spyOn(api, 'gitStatus').mockResolvedValue(status([{ path: 'src/broken.ts', xy: ' M' }]))
    vi.spyOn(api, 'gitDiff').mockRejectedValue(new Error('boom'))
    await expect(loadReviewPatch(scope, review(['src/broken.ts']))).rejects.toThrow('boom')
  })
})