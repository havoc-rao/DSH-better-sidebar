/**
 * The git tab's custom settings panel (`settings.render`): the AI commit
 * draft configuration. The user picks
 * - the LLM provider/model (the catalog is fetched live from the host's
 *   `ctx.llm` through the `llm.catalog` route; model ids are advisory, so
 *   the model row is a free-text input with a datalist of advertised ids),
 * - the commit reference template (conventional / gitmoji / plain /
 *   custom) — the custom variant reveals a textarea with the user's own
 *   format instructions,
 * - how many recent commit subjects are imported as the style reference.
 * Every change persists immediately through `updatePluginSetting` (the
 * shared settings-seam plumbing), so the Git panel picks it up on the next
 * draft without any save step.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSettingsRenderProps } from './service.ts'
import { api } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'
import {
  COMMIT_HISTORY_REFS_MAX,
  COMMIT_HISTORY_REFS_MIN,
  COMMIT_TEMPLATES,
  GIT_COMMIT_SETTING_KEYS,
  commitCustomTemplateOf,
  commitHistoryRefsOf,
  commitLlmModelOf,
  commitLlmProviderOf,
  commitTemplateOf,
  type LlmCatalog,
} from '../commit-draft-shared.ts'

/** The details-input id the model row's datalist connects to. */
const MODEL_LIST_ID = 'git-commit-model-list'

export function GitCommitSettings(props: SidebarSettingsRenderProps): ReactNode {
  const { pluginSettings, updatePluginSetting } = props
  const [catalog, setCatalog] = useState<LlmCatalog | null>(null)
  const [catalogFailed, setCatalogFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.llmCatalog()
      .then(list => { if (!cancelled) setCatalog(list) })
      .catch(() => { if (!cancelled) setCatalogFailed(true) })
    return () => { cancelled = true }
  }, [])

  const provider = commitLlmProviderOf(pluginSettings)
  const model = commitLlmModelOf(pluginSettings)
  const template = commitTemplateOf(pluginSettings)
  const customTemplate = commitCustomTemplateOf(pluginSettings)
  const historyRefs = commitHistoryRefsOf(pluginSettings)
  const providers = catalog?.providers ?? []
  const models = providers.find(row => row.id === provider)?.models ?? []
  const templateMeta = COMMIT_TEMPLATES.find(row => row.id === template)

  const set = (key: string, value: unknown): void => { updatePluginSetting(key, value) }

  return (
    <div className={css.gitSettings}>
      {catalogFailed && <div className={css.gitSettingsHint}>{t('gitLlmUnavailable')}</div>}
      {!catalogFailed && catalog !== null && !catalog.available && (
        <div className={css.gitSettingsHint}>{t('gitLlmUnavailable')}</div>
      )}
      {!catalogFailed && catalog === null && <div className={css.gitSettingsHint}>{t('loading')}</div>}

      <label className={css.gitSettingsRow}>
        <span className={css.gitSettingsLabel}>{t('gitLlmProvider')}</span>
        <select
          className={css.gitSettingsSelect}
          value={provider}
          onChange={(event) => { set(GIT_COMMIT_SETTING_KEYS.provider, event.target.value) }}
        >
          {providers.length === 0 && <option value="">—</option>}
          {provider !== '' && !providers.some(row => row.id === provider) && (
            <option value={provider}>{provider}</option>
          )}
          {providers.map(row => (
            <option key={row.id} value={row.id}>{row.name}</option>
          ))}
        </select>
      </label>

      <label className={css.gitSettingsRow}>
        <span className={css.gitSettingsLabel}>{t('gitLlmModel')}</span>
        <input
          className={css.gitSettingsInput}
          list={MODEL_LIST_ID}
          value={model}
          placeholder={t('gitLlmModelPlaceholder')}
          onChange={(event) => { set(GIT_COMMIT_SETTING_KEYS.model, event.target.value) }}
        />
        <datalist id={MODEL_LIST_ID}>
          {models.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </datalist>
      </label>

      <label className={css.gitSettingsRow}>
        <span className={css.gitSettingsLabel}>{t('gitTemplate')}</span>
        <select
          className={css.gitSettingsSelect}
          value={template}
          onChange={(event) => { set(GIT_COMMIT_SETTING_KEYS.template, event.target.value) }}
        >
          {COMMIT_TEMPLATES.map(row => (
            <option key={row.id} value={row.id}>{t(row.labelKey)}</option>
          ))}
        </select>
        {templateMeta !== undefined && (
          <span className={css.gitSettingsDesc}>{t(templateMeta.descKey)}</span>
        )}
      </label>

      {template === 'custom' && (
        <label className={css.gitSettingsRow}>
          <span className={css.gitSettingsLabel}>{t('gitCustomTemplate')}</span>
          <textarea
            className={css.gitSettingsTextarea}
            value={customTemplate}
            placeholder={t('gitCustomTemplatePlaceholder')}
            onChange={(event) => { set(GIT_COMMIT_SETTING_KEYS.customTemplate, event.target.value) }}
          />
        </label>
      )}

      <label className={css.gitSettingsRow}>
        <span className={css.gitSettingsLabel}>{t('gitHistoryRefs')}</span>
        <Input
          className={css.gitSettingsInput}
          type="number"
          min={COMMIT_HISTORY_REFS_MIN}
          max={COMMIT_HISTORY_REFS_MAX}
          value={String(historyRefs)}
          onChange={(event) => {
            const parsed = Number(event.target.value)
            if (!Number.isFinite(parsed)) return
            const clamped = Math.min(COMMIT_HISTORY_REFS_MAX, Math.max(COMMIT_HISTORY_REFS_MIN, Math.round(parsed)))
            set(GIT_COMMIT_SETTING_KEYS.historyRefs, clamped)
          }}
        />
        <span className={css.gitSettingsDesc}>{t('gitHistoryRefsDesc')}</span>
      </label>
    </div>
  )
}