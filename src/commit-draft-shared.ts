/**
 * Shared pure vocabulary of the AI commit-message draft feature (consumed by
 * both halves and the tests): the selectable reference templates, the plugin
 * setting keys under the `git` descriptor, the value accessors, and the wire
 * payload types. This file MUST stay dependency-free — it enters the client
 * bundle and the host bundle alike.
 */

/** The selectable commit reference templates (settings row + prompt). */
export const COMMIT_TEMPLATES = [
  {
    id: 'conventional',
    labelKey: 'gitTemplateConventional',
    descKey: 'gitTemplateConventionalDesc',
  },
  {
    id: 'gitmoji',
    labelKey: 'gitTemplateGitmoji',
    descKey: 'gitTemplateGitmojiDesc',
  },
  {
    id: 'plain',
    labelKey: 'gitTemplatePlain',
    descKey: 'gitTemplatePlainDesc',
  },
  {
    id: 'custom',
    labelKey: 'gitTemplateCustom',
    descKey: 'gitTemplateCustomDesc',
  },
] as const

export type CommitTemplateId = typeof COMMIT_TEMPLATES[number]['id']

/** The template used before the user picks one (and the fallback for a stale id). */
export const COMMIT_TEMPLATE_DEFAULT: CommitTemplateId = 'conventional'

/** How many recent commit subjects are imported as the style reference
 *  (0 disables the import). Clamped to this window by the host route. */
export const COMMIT_HISTORY_REFS_DEFAULT = 8
export const COMMIT_HISTORY_REFS_MIN = 0
export const COMMIT_HISTORY_REFS_MAX = 30

/** Cap of the user-written custom template instructions (prompt hygiene). */
export const COMMIT_CUSTOM_TEMPLATE_MAX = 2000

/**
 * The watched-branches (重点关注) setting: a list of local branch names whose
 * tips get divergence markers in the history graph (row rings + top/bottom
 * bubbles). Lives in the `git` descriptor's pluginSettings blob, same as the
 * commit-draft rows.
 */
export const WATCHED_BRANCHES_KEY = 'watchedBranches'
/** Upper bound on the watch list (polls fetch one tip per entry). */
export const WATCHED_BRANCHES_MAX = 8

/** The watched branch names of one `git` pluginSettings blob (deduped, capped). */
export function watchedBranchesOf(blob: Record<string, unknown> | undefined): string[] {
  const raw = blob?.[WATCHED_BRANCHES_KEY]
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') continue
    if (names.includes(item)) continue
    names.push(item)
    if (names.length >= WATCHED_BRANCHES_MAX) break
  }
  return names
}

/** PluginSettings keys under the `git` descriptor (the gear panel rows). */
export const GIT_COMMIT_SETTING_KEYS = {
  provider: 'commitLlmProvider',
  model: 'commitLlmModel',
  template: 'commitTemplate',
  customTemplate: 'commitCustomTemplate',
  historyRefs: 'commitHistoryRefs',
} as const

/** One model the catalog advertises for a provider (advisory per dsh-llm). */
export interface LlmCatalogModel {
  id: string
  name: string
}

/** One LLM provider row of the catalog (live `ctx.llm.listProviders()` + models). */
export interface LlmCatalogProvider {
  id: string
  name: string
  models: LlmCatalogModel[]
}

/** The `llm.catalog` wire shape; `available: false` when `ctx.llm` is absent. */
export interface LlmCatalog {
  available: boolean
  providers: LlmCatalogProvider[]
}

/** The `git.commit-draft` request (session scope is added by the api layer). */
export interface CommitDraftRequest {
  /** Reference template id; missing/unknown falls back to `conventional`. */
  template?: string
  /** User-written instructions used when `template === 'custom'`. */
  customTemplate?: string
  provider: string
  model: string
  /** Style-reference window (clamped host-side to 0..30). */
  historyRefs?: number
}

/** The `git.commit-draft` response. */
export interface CommitDraftResult {
  /** The drafted commit message (subject + body), trimmed. */
  message: string
  fileCount: number
  insertions: number
  deletions: number
  /** Whether the staged patch forwarded to the model was capped. */
  patchTruncated: boolean
  provider: string
  model: string
  template: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** The selected template id of one `git` pluginSettings blob (default when absent/stale). */
export function commitTemplateOf(blob: Record<string, unknown> | undefined): CommitTemplateId {
  const id = str(blob?.[GIT_COMMIT_SETTING_KEYS.template])
  return (COMMIT_TEMPLATES as readonly { id: string }[]).some(template => template.id === id)
    ? id as CommitTemplateId
    : COMMIT_TEMPLATE_DEFAULT
}

/** The selected LLM provider of one `git` pluginSettings blob ('' = unset). */
export function commitLlmProviderOf(blob: Record<string, unknown> | undefined): string {
  return str(blob?.[GIT_COMMIT_SETTING_KEYS.provider])
}

/** The selected LLM model of one `git` pluginSettings blob ('' = unset). */
export function commitLlmModelOf(blob: Record<string, unknown> | undefined): string {
  return str(blob?.[GIT_COMMIT_SETTING_KEYS.model])
}

/** The user-written custom template instructions ('' = none). */
export function commitCustomTemplateOf(blob: Record<string, unknown> | undefined): string {
  return str(blob?.[GIT_COMMIT_SETTING_KEYS.customTemplate]).slice(0, COMMIT_CUSTOM_TEMPLATE_MAX)
}

/** The style-reference window of one `git` pluginSettings blob (clamped). */
export function commitHistoryRefsOf(blob: Record<string, unknown> | undefined): number {
  const value = num(blob?.[GIT_COMMIT_SETTING_KEYS.historyRefs], COMMIT_HISTORY_REFS_DEFAULT)
  return Math.min(COMMIT_HISTORY_REFS_MAX, Math.max(COMMIT_HISTORY_REFS_MIN, Math.round(value)))
}