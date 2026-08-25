import { describe, expect, it } from 'vitest'
import { parseNumstat } from '../src/git.ts'
import {
  COMMIT_TEMPLATES,
  composeCommitDraftPrompt,
  resolveCommitTemplate,
  STAGED_DIFF_CAP,
  type CommitDraftContext,
} from '../src/commit-draft.ts'
import {
  COMMIT_CUSTOM_TEMPLATE_MAX,
  COMMIT_HISTORY_REFS_MAX,
  COMMIT_TEMPLATE_DEFAULT,
  COMMIT_TEMPLATES as SHARED_TEMPLATES,
  GIT_COMMIT_SETTING_KEYS,
  commitCustomTemplateOf,
  commitHistoryRefsOf,
  commitLlmModelOf,
  commitLlmProviderOf,
  commitTemplateOf,
} from '../src/commit-draft-shared.ts'

describe('staged numstat parsing', () => {
  it('parses added/deleted counts and paths with spaces', () => {
    expect(parseNumstat('12\t3\tsrc/a.ts\n0\t7\tREADME file.md\n')).toEqual([
      { path: 'src/a.ts', added: 12, deleted: 3 },
      { path: 'README file.md', added: 0, deleted: 7 },
    ])
  })

  it('reports null counts for binary entries and skips blank lines', () => {
    expect(parseNumstat('-\t-\tassets/icon.png\n\n')).toEqual([
      { path: 'assets/icon.png', added: null, deleted: null },
    ])
  })

  it('keeps tabs inside a path intact', () => {
    expect(parseNumstat('1\t2\tweird\tname.ts\n')).toEqual([
      { path: 'weird\tname.ts', added: 1, deleted: 2 },
    ])
  })
})

describe('commit template resolution', () => {
  it('resolves the built-in templates to their instructions', () => {
    for (const template of COMMIT_TEMPLATES) {
      const resolved = resolveCommitTemplate(template.id, undefined)
      expect(resolved.id).toBe(template.id)
      expect(resolved.instructions.length).toBeGreaterThan(20)
    }
    expect(resolveCommitTemplate('conventional', undefined).instructions).toContain('Conventional Commits')
    expect(resolveCommitTemplate('gitmoji', undefined).instructions).toContain('Gitmoji')
  })

  it('falls back to the default template for an unknown id', () => {
    const resolved = resolveCommitTemplate('totally-unknown', 'ignored')
    expect(resolved.id).toBe(COMMIT_TEMPLATES[0]!.id)
  })

  it('uses the user text for the custom template and caps it', () => {
    const long = 'x'.repeat(COMMIT_CUSTOM_TEMPLATE_MAX + 500)
    const resolved = resolveCommitTemplate('custom', long)
    expect(resolved.id).toBe('custom')
    expect(resolved.instructions.length).toBeLessThanOrEqual(COMMIT_CUSTOM_TEMPLATE_MAX)
    expect(resolved.instructions).toBe('x'.repeat(COMMIT_CUSTOM_TEMPLATE_MAX))
  })

  it('falls back to a generic instruction when the custom text is empty', () => {
    const resolved = resolveCommitTemplate('custom', '   ')
    expect(resolved.id).toBe('custom')
    expect(resolved.instructions).toContain('concise')
  })
})

describe('commit draft prompt composition', () => {
  const context: CommitDraftContext = {
    branch: 'feat/sidebar',
    refs: ['feat: add git panel', 'fix: correct layout width'],
    stat: ' 2 files changed, 12 insertions(+), 3 deletions(-)',
    patch: 'diff --git a/src/a.ts b/src/a.ts\n+new line\n-old line',
    patchTruncated: false,
    fileCount: 2,
    insertions: 12,
    deletions: 3,
  }

  it('carries branch, overview, stat, patch and style-reference subjects', () => {
    const prompt = composeCommitDraftPrompt(context, 'Use Conventional Commits.')
    expect(prompt.system).toContain('ONLY the commit message text')
    expect(prompt.system).toContain('language')
    expect(prompt.user).toContain('feat/sidebar')
    expect(prompt.user).toContain('2 file(s) changed, +12 −3')
    expect(prompt.user).toContain(context.stat)
    expect(prompt.user).toContain('+new line')
    expect(prompt.user).toContain('Use Conventional Commits.')
    expect(prompt.user).toContain('- feat: add git panel')
    expect(prompt.user).toContain('- fix: correct layout width')
  })

  it('marks the patch as truncated at the cap and falls back without refs', () => {
    const big = 'x'.repeat(STAGED_DIFF_CAP + 100)
    // buildCommitContext already caps the patch and appends the marker; the
    // composer renders whatever context it receives verbatim.
    const capped = `${big.slice(0, STAGED_DIFF_CAP)}\n… (diff truncated)`
    const prompt = composeCommitDraftPrompt({ ...context, patch: capped, patchTruncated: true, refs: [] }, 'plain rules')
    expect(prompt.user).toContain('(diff truncated)')
    expect(prompt.user).toContain('(no history yet)')
  })
})

describe('shared commit-draft vocabulary', () => {
  it('exposes the same template ids on both halves', () => {
    expect(SHARED_TEMPLATES.map(t => t.id).sort()).toEqual(
      ['conventional', 'custom', 'gitmoji', 'plain'],
    )
  })

  it('reads and defaults the git pluginSettings blob', () => {
    expect(commitTemplateOf(undefined)).toBe(COMMIT_TEMPLATE_DEFAULT)
    expect(commitTemplateOf({ [GIT_COMMIT_SETTING_KEYS.template]: 'gitmoji' })).toBe('gitmoji')
    expect(commitTemplateOf({ [GIT_COMMIT_SETTING_KEYS.template]: 'stale-id' })).toBe(COMMIT_TEMPLATE_DEFAULT)
    expect(commitLlmProviderOf(undefined)).toBe('')
    expect(commitLlmProviderOf({ [GIT_COMMIT_SETTING_KEYS.provider]: 'deepseek' })).toBe('deepseek')
    expect(commitLlmModelOf({ [GIT_COMMIT_SETTING_KEYS.model]: 'deepseek-chat' })).toBe('deepseek-chat')
    expect(commitCustomTemplateOf({ [GIT_COMMIT_SETTING_KEYS.customTemplate]: 'abc' })).toBe('abc')
    expect(commitHistoryRefsOf(undefined)).toBe(8)
    expect(commitHistoryRefsOf({ [GIT_COMMIT_SETTING_KEYS.historyRefs]: 2.7 })).toBe(3)
    expect(commitHistoryRefsOf({ [GIT_COMMIT_SETTING_KEYS.historyRefs]: 99 })).toBe(COMMIT_HISTORY_REFS_MAX)
    expect(commitHistoryRefsOf({ [GIT_COMMIT_SETTING_KEYS.historyRefs]: -5 })).toBe(0)
  })
})