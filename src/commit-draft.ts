/**
 * AI commit-message drafting (host half): the "script" that formats the
 * STAGED changes of the current repository into an LLM-friendly bundle —
 * a `--stat` overview, the full staged patch (capped), and the most recent
 * commit subjects imported as a style reference — then composes the model
 * request from a user-chosen reference template and streams one completion
 * through the harness LLM service (`ctx.get('llm')`). Every boundary
 * degrades gracefully: no repo → git-error; nothing staged → null context
 * (the route answers no-staged-changes); no `llm` service → llm-unavailable;
 * a failed/aborted stream → llm-error.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as git from './git.ts'
import { SidebarError } from './wire.ts'
import {
  COMMIT_CUSTOM_TEMPLATE_MAX,
  COMMIT_HISTORY_REFS_MAX,
  type LlmCatalog,
  type LlmCatalogProvider,
} from './commit-draft-shared.ts'

/** Cap of the staged patch forwarded to the model (prompt hygiene). */
export const STAGED_DIFF_CAP = 24_000

/** The model request timeout (aborts the stream; route answers llm-error). */
export const COMMIT_DRAFT_TIMEOUT_MS = 90_000

/** One selectable reference template: the format instructions injected into
 *  the prompt (the settings row renders id/title/desc from the shared
 *  vocabulary — only the model-facing instructions live here). */
export interface CommitTemplate {
  id: string
  instructions: string
}

const FALLBACK_INSTRUCTIONS = 'Write a clear, concise commit message that accurately summarizes the change.'

/** The built-in templates; `custom` is resolved separately (user text). */
export const COMMIT_TEMPLATES: readonly CommitTemplate[] = [
  {
    id: 'conventional',
    instructions: [
      'Follow the Conventional Commits format:',
      '<type>(<scope>): <subject>',
      '',
      '- type ∈ {feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert}',
      '- scope: the affected module/file, omitted when unclear',
      '- subject: a short imperative summary (≤ 72 chars, lowercase, no trailing period)',
      '- body: a blank line, then bullet points ("- ") explaining what changed and why',
      '- add a "BREAKING CHANGE: <desc>" footer when the change breaks compatibility',
    ].join('\n'),
  },
  {
    id: 'gitmoji',
    instructions: [
      'Prefix the subject with a Gitmoji matching the change kind (✨ feat, 🐛 fix, 📝 docs, ♻️ refactor, ⚡ perf, 🎨 style, 🧪 test, ➕ build, 🚀 chore), then a Conventional Commits subject:',
      '<gitmoji> <type>(<scope>): <subject>',
      '',
      '- subject: a short imperative summary (≤ 72 chars, lowercase, no trailing period)',
      '- body: a blank line, then a short bullet list ("- ") of the key changes',
    ].join('\n'),
  },
  {
    id: 'plain',
    instructions: [
      'Write one concise subject line (imperative mood, ≤ 72 chars, no trailing period),',
      'then an optional blank line and a short bullet list ("- ") of the key changes and reasons.',
    ].join(' '),
  },
]

/** Resolve one template to its model instructions: `custom` uses the user's
 *  text (empty → a generic fallback), anything unknown → the default. */
export function resolveCommitTemplate(id: string | undefined, custom: string | undefined): { id: string; instructions: string } {
  if (id === 'custom') {
    const text = (custom ?? '').trim().slice(0, COMMIT_CUSTOM_TEMPLATE_MAX)
    return { id: 'custom', instructions: text === '' ? FALLBACK_INSTRUCTIONS : text }
  }
  return COMMIT_TEMPLATES.find(template => template.id === id) ?? COMMIT_TEMPLATES[0]!
}

/**
 * The formatted staged-change bundle one draft request carries: the stat
 * overview, the capped patch, the style-reference subjects, and the totals
 * the UI shows beside the draft.
 */
export interface CommitDraftContext {
  branch: string
  /** Recent commit subjects, newest first (the style reference). */
  refs: string[]
  /** `git diff --cached --stat` output. */
  stat: string
  /** `git diff --cached` output, capped at {@link STAGED_DIFF_CAP}. */
  patch: string
  patchTruncated: boolean
  fileCount: number
  insertions: number
  deletions: number
}

/**
 * Gather and format the staged changes of the repository at `cwd`
 * (stat + capped patch + style-reference subjects + totals). Returns null
 * when nothing is staged; throws git-error when `cwd` is not a repository.
 */
export async function buildCommitContext(cwd: string, historyRefs: number): Promise<CommitDraftContext | null> {
  const repo = await git.isGitRepo(cwd)
  if (!repo) throw new SidebarError('git-error', 'not a git repository')
  const numstat = await git.stagedNumstat(cwd)
  if (numstat.length === 0) return null
  let fileCount = 0
  let insertions = 0
  let deletions = 0
  for (const row of numstat) {
    fileCount += 1
    insertions += row.added ?? 0
    deletions += row.deleted ?? 0
  }
  const [branch, stat, patch, refs] = await Promise.all([
    git.currentBranch(cwd).catch(() => 'HEAD'),
    git.stagedStat(cwd),
    git.diff(cwd, undefined, true),
    // A repository with no commits yet has no history to import — degrade to
    // an empty reference instead of failing the draft.
    git.recentSubjects(cwd, Math.min(historyRefs, COMMIT_HISTORY_REFS_MAX)).catch(() => []),
  ])
  const capped = patch.length > STAGED_DIFF_CAP
  return {
    branch,
    refs,
    stat: stat.trim(),
    patch: capped ? `${patch.slice(0, STAGED_DIFF_CAP)}\n… (diff truncated)` : patch,
    patchTruncated: capped,
    fileCount,
    insertions,
    deletions,
  }
}

/** The composed model request texts of one draft. */
export interface CommitDraftPrompt {
  system: string
  user: string
}

/**
 * Compose the system + user texts from the formatted context and one
 * template's instructions. The language follows the repository: the model
 * is told to match the reference history / diff language instead of being
 * pinned to one locale.
 */
export function composeCommitDraftPrompt(context: CommitDraftContext, instructions: string): CommitDraftPrompt {
  const system = [
    'You are an expert at writing concise, accurate git commit messages.',
    'You are given the STAGED changes of a git repository (overview, --stat and full diff) plus recent commit subjects as a style reference.',
    'Produce ONLY the commit message text itself — no explanations, no Markdown code fences, no preamble and no trailing commentary.',
    'Match the language of the reference history and the diff (Chinese when the repository commits are Chinese, otherwise English).',
  ].join(' ')
  const user = [
    `branch: ${context.branch}`,
    `overview: ${context.fileCount} file(s) changed, +${context.insertions} −${context.deletions}`,
    '',
    instructions,
    '',
    '── staged changes (--stat) ──',
    context.stat,
    '',
    '── staged changes (full diff) ──',
    context.patch,
    '',
    '── recent commits (style reference) ──',
    ...(context.refs.length > 0 ? context.refs.map(ref => `- ${ref}`) : ['(no history yet)']),
    '',
    'Commit message:',
  ]
  return { system, user: user.join('\n') }
}

/** Stream one draft completion through the harness LLM service; resolves
 *  with the trimmed message text. A failed or aborted stream (and an empty
 *  reply) throw {@link SidebarError} `llm-error`. */
export async function draftCommitMessage(
  llm: LlmRuntime,
  route: { provider: string; model: string },
  prompt: CommitDraftPrompt,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), COMMIT_DRAFT_TIMEOUT_MS)
  try {
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      system: prompt.system,
      temperature: 0.6,
      maxTokens: 1024,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: prompt.user }],
          source: { kind: 'user' },
        }),
      ],
      signal: controller.signal,
    }
    let text = ''
    try {
      for await (const chunk of llm.stream(options) as AsyncIterable<StreamChunk>) {
        if (chunk.type === 'text-delta') {
          text += chunk.text
          continue
        }
        if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          const failure = chunk.reason.failure
          throw new SidebarError(
            'llm-error',
            failure.message !== '' ? failure.message : String(failure.code ?? 'unknown'),
            502,
          )
        }
      }
    } catch (error) {
      // The runtime normalizes adapter throws to terminal finish chunks, but
      // a defensive net keeps a raw throw from leaking as a 500 internal.
      if (error instanceof SidebarError) throw error
      throw new SidebarError('llm-error', error instanceof Error ? error.message : String(error), 502)
    }
    const message = text.trim()
    if (message === '') throw new SidebarError('llm-error', 'the model returned an empty message', 502)
    return message
  } finally {
    clearTimeout(timer)
  }
}

/** The live provider/model catalog the settings panel offers (empty when the
 *  LLM service is absent or no provider is registered). */
export async function catalogOf(llm: LlmRuntime | undefined): Promise<LlmCatalog> {
  if (llm === undefined) return { available: false, providers: [] }
  const providers: LlmCatalogProvider[] = []
  for (const provider of llm.listProviders()) {
    const models = await llm.listModels(provider.id).catch(() => [])
    providers.push({
      id: provider.id,
      name: provider.name,
      models: models.map(model => ({ id: model.id, name: model.name })),
    })
  }
  return { available: true, providers }
}