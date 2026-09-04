import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Context } from '../src/context-types.ts'
import { parseNumstat } from '../src/git.ts'
import {
  COMMIT_TEMPLATES,
  buildCommitContext,
  composeCommitDraftPrompt,
  dominantLanguageOf,
  draftCommitMessage,
  probeLlmConnection,
  resolveCommitTemplate,
  STAGED_DIFF_CAP,
  type CommitDraftContext,
} from '../src/agents/git-commit-agent.ts'
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
} from '../src/agents/commit-draft-shared.ts'

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

describe('dominant commit language detection', () => {
  it('returns the strict-majority script family of the history', () => {
    expect(dominantLanguageOf([])).toBeUndefined()
    expect(dominantLanguageOf(['feat: add panel', 'refactor: cleanup', 'fix: typo'])).toBe('en')
    expect(dominantLanguageOf(['feat: 添加面板', 'fix: 修正布局', 'docs: 更新说明', 'chore: 清理'])).toBe('zh')
    // Kana wins over Han: Japanese is Han + kana, Han alone reads as Chinese.
    expect(dominantLanguageOf(['feat: 日本語の対応を追加', 'fix: 表示崩れを修正'])).toBe('ja')
    expect(dominantLanguageOf(['feat: 한국어 지원', 'fix: 오타 수정'])).toBe('ko')
    expect(dominantLanguageOf(['feat: исправить баг', 'fix: правка'])).toBe('ru')
  })

  it('returns undefined for ties, weak pluralities and unclassifiable subjects', () => {
    expect(dominantLanguageOf(['feat: a', 'feat: 中'])).toBeUndefined()
    expect(dominantLanguageOf(['feat: a', 'feat: 中', 'テスト追加'])).toBeUndefined()
    expect(dominantLanguageOf(['🚀', '🎉'])).toBeUndefined()
    expect(dominantLanguageOf(['', '   '])).toBeUndefined()
  })
})

describe('commit draft prompt composition', () => {
  const context: CommitDraftContext = {
    source: 'staged',
    branch: 'feat/sidebar',
    refs: ['feat: add git panel', 'fix: correct layout width'],
    language: undefined,
    status: 'src/a.ts\nsrc/b.ts',
    stat: ' 2 files changed, 12 insertions(+), 3 deletions(-)',
    patch: 'diff --git a/src/a.ts b/src/a.ts\n+new line\n-old line',
    patchTruncated: false,
    statusTruncated: false,
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

  it('carries the detected dominant language as an explicit instruction', () => {
    const zh = composeCommitDraftPrompt({ ...context, language: 'zh' }, 'plain rules')
    expect(zh.system).toContain('Chinese (Simplified)')
    expect(zh.system).toContain('past commits')
    const en = composeCommitDraftPrompt({ ...context, language: 'en' }, 'plain rules')
    expect(en.system).toContain('English')
    // No confident majority: the model follows a clearly dominant history or
    // falls back to concise English (the default that always applied before).
    const ambiguous = composeCommitDraftPrompt({ ...context, language: undefined }, 'plain rules')
    expect(ambiguous.system).toContain('clearly dominant')
    expect(ambiguous.system).toContain('concise English')
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

  it('tells an empty-index agent to summarize the working tree conservatively', () => {
    const prompt = composeCommitDraftPrompt({
      ...context,
      source: 'working-tree',
      status: ' M src/a.ts\n?? src/new.ts',
      stat: '',
      patch: '',
    }, 'plain rules')
    expect(prompt.system).toContain('index is empty')
    expect(prompt.system).toContain('tentative commit-message-style summary')
    expect(prompt.user).toContain('?? src/new.ts')
    expect(prompt.user).toContain('summarize conservatively')
  })
})

describe('commit context collection', () => {
  it('falls back to porcelain status when the index is empty, then prefers the index after git add', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'better-sidebar-commit-agent-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd })
      writeFileSync(join(cwd, 'new-file.ts'), 'export const answer = 42\n')

      const working = await buildCommitContext(cwd, 0)
      expect(working).toMatchObject({ source: 'working-tree', fileCount: 1 })
      expect(working?.status).toContain('?? new-file.ts')
      expect(working?.patch).toBe('')

      execFileSync('git', ['add', 'new-file.ts'], { cwd })
      const staged = await buildCommitContext(cwd, 0)
      expect(staged).toMatchObject({ source: 'staged', fileCount: 1, insertions: 1, deletions: 0 })
      expect(staged?.patch).toContain('+export const answer = 42')
      // No past commits exist yet — nothing to infer a language from.
      expect(staged?.language).toBeUndefined()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('uses tracked unstaged file contents when the index is empty', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'better-sidebar-commit-agent-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd })
      writeFileSync(join(cwd, 'tracked.ts'), 'export const answer = 41\n')
      execFileSync('git', ['add', 'tracked.ts'], { cwd })
      execFileSync('git', [
        '-c', 'user.name=Commit Agent Test',
        '-c', 'user.email=commit-agent@example.test',
        'commit', '-qm', 'test: seed repository',
      ], { cwd })
      writeFileSync(join(cwd, 'tracked.ts'), 'export const answer = 42\n')

      const context = await buildCommitContext(cwd, 0)
      expect(context).toMatchObject({
        source: 'working-tree',
        fileCount: 1,
        insertions: 1,
        deletions: 1,
      })
      expect(context?.status).toContain(' M tracked.ts')
      expect(context?.stat).toContain('1 insertion(+), 1 deletion(-)')
      expect(context?.patch).toContain('-export const answer = 41')
      expect(context?.patch).toContain('+export const answer = 42')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('auto-adapts to the dominant language of the user\'s past commits', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'better-sidebar-commit-agent-lang-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd })
      const commit = (subject: string): void => {
        execFileSync('git', [
          '-c', 'user.name=Commit Agent Test',
          '-c', 'user.email=commit-agent@example.test',
          'commit', '-qm', subject,
        ], { cwd })
      }
      writeFileSync(join(cwd, 'tracked.ts'), 'export const answer = 1\n')
      execFileSync('git', ['add', 'tracked.ts'], { cwd })
      commit('feat: 初始化项目导航')
      writeFileSync(join(cwd, 'tracked.ts'), 'export const answer = 2\n')
      execFileSync('git', ['add', 'tracked.ts'], { cwd })
      commit('fix: 修正头部布局偏移')
      writeFileSync(join(cwd, 'tracked.ts'), 'export const answer = 3\n')

      // historyRefs = 0 disables the style-refs import, but the wider language
      // sample still sees both Chinese subjects → the prompt gets the zh line.
      const context = await buildCommitContext(cwd, 0)
      expect(context?.refs).toEqual([])
      expect(context?.language).toBe('zh')
      const prompt = composeCommitDraftPrompt(context!, 'plain rules')
      expect(prompt.system).toContain('Chinese (Simplified)')
      expect(prompt.user).toContain('(no history yet)')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('commit agent-loop runner', () => {
  it('creates a hidden tool-free one-shot child and reads its final assistant message', async () => {
    const section = vi.fn()
    const suppressRuntimeContext = vi.fn()
    const restrict = vi.fn()
    const on = vi.fn(() => vi.fn())
    const resolveModelInfo = vi.fn(async () => ({
      provider: 'provider',
      id: 'model',
      name: 'Model',
      reasoning: { efforts: [{ id: 'off', name: 'Off' }] },
    }))
    const followup = vi.fn()
    const dispose = vi.fn(async () => {})
    const agent = {
      session: {
        events: [{
          type: 'assistant/message',
          seq: 1,
          time: 1,
          data: {
            turn: 1,
            step: 1,
            message: { role: 'assistant', content: [{ type: 'text', text: 'feat(git): summarize changes' }] },
          },
        }],
      },
      followup,
      whenIdle: vi.fn(async () => {}),
      cancel: vi.fn(),
    }
    let options: CreateAgentOptions | undefined
    const create = vi.fn(async (input: CreateAgentOptions) => {
      options = input
      await input.setup?.({
        systemPrompt: { section, suppressRuntimeContext },
        tools: { restrict },
        on,
      } as unknown as CordisContext)
      return { agent, dispose }
    })
    const ctx = {
      get: (name: string) => name === 'agents' ? { create }
        : name === 'llm' ? { resolveModelInfo }
          : undefined,
      sessions: { get: () => ({ header: { delegationDepth: 2 } }) },
    } as unknown as Context

    await expect(draftCommitMessage(
      ctx,
      'parent-session',
      '/repo',
      { provider: 'provider', model: 'model' },
      { system: 'exact system', user: 'repository data' },
    )).resolves.toBe('feat(git): summarize changes')

    expect(options?.meta).toMatchObject({
      cwd: '/repo',
      parentSession: 'parent-session',
      origin: 'subagent',
      delegationDepth: 3,
    })
    expect(options?.agentOptions).toEqual({ provider: 'provider', model: 'model' })
    expect(resolveModelInfo).toHaveBeenCalledWith('provider', 'model', expect.any(AbortSignal))
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ text: 'exact system', complete: true }))
    expect(suppressRuntimeContext).toHaveBeenCalledOnce()
    expect(restrict).toHaveBeenCalledWith({ allow: [] })
    expect(on).toHaveBeenCalledWith('agent/request', expect.any(Function))
    expect(followup).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe('LLM connectivity probe', () => {
  it('accepts a provider route only after it returns visible text', async () => {
    let request: Record<string, unknown> | undefined
    const llm = {
      resolveModelInfo: vi.fn(async () => ({
        provider: 'p', id: 'm', name: 'M',
        reasoning: { efforts: [{ id: 'off', name: 'Off' }] },
      })),
      stream: async function* (options: Record<string, unknown>) {
        request = options
        yield { type: 'text-delta', index: 0, text: 'OK' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as unknown as LlmRuntime
    await expect(probeLlmConnection(llm, { provider: 'p', model: 'm' }))
      .resolves.toMatchObject({ message: 'OK' })
    expect(request).toMatchObject({ provider: 'p', model: 'm', reasoningEffort: 'off' })
    expect(request).not.toHaveProperty('temperature')
    expect(request).not.toHaveProperty('maxTokens')
  })

  it('preserves the adapter failure code for an empty response', async () => {
    const llm = {
      resolveModelInfo: vi.fn(async () => ({ provider: 'p', id: 'm', name: 'M' })),
      stream: async function* () {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: 'EMPTY_RESPONSE', message: 'model returned a completed response with no content' },
          },
        }
      },
    } as unknown as LlmRuntime
    await expect(probeLlmConnection(llm, { provider: 'p', model: 'm' }))
      .rejects.toThrow('[EMPTY_RESPONSE] model returned a completed response with no content')
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
