/**
 * The Git commit agent's first-class section in the Side card settings
 * page: the AI commit draft configuration. The user picks
 * - the LLM provider/model (the catalog is fetched live from the host's
 *   `ctx.llm` through the `llm.catalog` route and rendered as one exact
 *   "model · provider" route, grouped by provider like DSH ModelSelect),
 * - the commit reference template (conventional / gitmoji / plain /
 *   custom) — the custom variant reveals a textarea with the user's own
 *   format instructions,
 * - how many recent commit subjects are imported as the style reference.
 * Every change persists immediately through `updatePluginSetting` (the
 * shared plugin-settings plumbing), so the Git panel picks it up on the next
 * draft without any save step.
 */
import {
  useEffect, useId, useRef, useState,
  type FocusEvent, type KeyboardEvent, type ReactNode,
} from 'react'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
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
} from '../agents/commit-draft-shared.ts'

/** The top-level settings page only needs the plugin-owned value seam. */
export type GitCommitSettingsProps = Pick<SidebarSettingsRenderProps, 'pluginSettings' | 'updatePluginSetting'>

interface ChooseOption {
  id: string
  label: string
  description?: string
}

interface ChooseGroup {
  id: string
  label?: string
  options: readonly ChooseOption[]
}

/**
 * DSH ModelSelect-style choose box: compact route trigger, elevated menu,
 * optional provider group headings and a trailing check on the selected row.
 * The menu stays local to this settings component so the client bundle does
 * not value-import another DSH plugin.
 */
function ChooseBox(props: {
  label: string
  valueLabel: string
  valueMeta?: string
  selectedId?: string
  groups: readonly ChooseGroup[]
  disabled?: boolean
  busy?: boolean
  emptyText: string
  onSelect: (id: string) => void
}) {
  const { label, valueLabel, valueMeta, selectedId, groups, disabled, busy, emptyText, onSelect } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
      return
    }
    if (!open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    moveFocus(event.key === 'ArrowDown' ? 1 : -1)
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null): void => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.gitChooseRoot} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.gitChooseTrigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={[valueLabel, valueMeta].filter(Boolean).join(' · ')}
        disabled={disabled}
        onClick={() => { setOpen(now => !now) }}
      >
        <span className={css.gitChooseValue}>{valueLabel}</span>
        {valueMeta !== undefined && valueMeta !== '' && (
          <>
            <span className={css.gitChooseDot}> · </span>
            <span className={css.gitChooseMeta}>{valueMeta}</span>
          </>
        )}
        <IconChevronDownOutline14 className={clsx(css.gitChooseChevron, open && css.gitChooseChevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.gitChooseMenu}
          role="menu"
          aria-label={label}
          aria-busy={busy}
        >
          {groups.map(group => (
            <section
              key={group.id}
              role="group"
              aria-labelledby={group.label === undefined ? undefined : `${id}-${group.id}`}
              className={css.gitChooseGroup}
            >
              {group.label !== undefined && (
                <div id={`${id}-${group.id}`} className={css.gitChooseGroupTitle}>{group.label}</div>
              )}
              {group.options.map(option => {
                const selected = option.id === selectedId
                return (
                  <button
                    key={option.id}
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={clsx(css.gitChooseOption, selected && css.gitChooseSelected)}
                    title={option.label}
                    onClick={() => {
                      onSelect(option.id)
                      close(true)
                    }}
                  >
                    <span className={css.gitChooseOptionCopy}>
                      <span className={css.gitChooseOptionName}>{option.label}</span>
                      {option.description !== undefined && (
                        <span className={css.gitChooseOptionDesc}>{option.description}</span>
                      )}
                    </span>
                    <span className={css.gitChooseCheck}>
                      {selected ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                )
              })}
            </section>
          ))}
          {groups.every(group => group.options.length === 0) && (
            <div className={css.gitChooseEmpty}>{emptyText}</div>
          )}
        </div>
      )}
    </div>
  )
}

export function GitCommitSettings(props: GitCommitSettingsProps): ReactNode {
  const { pluginSettings, updatePluginSetting } = props
  const [catalog, setCatalog] = useState<LlmCatalog | null>(null)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [probe, setProbe] = useState<null | { kind: 'testing' | 'success' | 'error'; text?: string }>(null)
  const probeAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.llmCatalog()
      .then(list => { if (!cancelled) setCatalog(list) })
      .catch(() => { if (!cancelled) setCatalogFailed(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => () => { probeAbortRef.current?.abort() }, [])

  const provider = commitLlmProviderOf(pluginSettings)
  const model = commitLlmModelOf(pluginSettings)
  const template = commitTemplateOf(pluginSettings)
  const customTemplate = commitCustomTemplateOf(pluginSettings)
  const historyRefs = commitHistoryRefsOf(pluginSettings)
  const providers = catalog?.providers ?? []
  const templateMeta = COMMIT_TEMPLATES.find(row => row.id === template)
  const modelGroups: ChooseGroup[] = providers.map(group => ({
    id: group.id,
    label: group.name,
    options: group.models.map(row => ({
      id: `${group.id}\u0000${row.id}`,
      label: row.name,
      description: row.id === row.name ? undefined : row.id,
    })),
  }))
  const selectedModel = providers
    .find(group => group.id === provider)
    ?.models.find(row => row.id === model)
  const modelLabel = selectedModel?.name ?? (model || t('gitLlmModelPlaceholder'))
  const providerLabel = providers.find(group => group.id === provider)?.name ?? provider
  const templateGroups: ChooseGroup[] = [{
    id: 'templates',
    options: COMMIT_TEMPLATES.map(row => ({
      id: row.id,
      label: t(row.labelKey),
      description: t(row.descKey),
    })),
  }]

  const set = (key: string, value: unknown): void => { updatePluginSetting(key, value) }

  const testConnection = async (): Promise<void> => {
    if (provider === '' || model === '' || probe?.kind === 'testing') return
    probeAbortRef.current?.abort()
    const controller = new AbortController()
    probeAbortRef.current = controller
    setProbe({ kind: 'testing' })
    try {
      const result = await api.llmProbe({ provider, model }, controller.signal)
      if (controller.signal.aborted) return
      setProbe({
        kind: 'success',
        text: t('gitLlmProbeSuccess', { ms: result.latencyMs, message: result.message }),
      })
    } catch (error) {
      if (controller.signal.aborted) return
      setProbe({
        kind: 'error',
        text: t('gitLlmProbeFailed', { message: error instanceof Error ? error.message : String(error) }),
      })
    } finally {
      if (probeAbortRef.current === controller) probeAbortRef.current = null
    }
  }

  return (
    <div className={css.gitSettings}>
      {catalogFailed && <div className={css.gitSettingsHint}>{t('gitLlmUnavailable')}</div>}
      {!catalogFailed && catalog !== null && !catalog.available && (
        <div className={css.gitSettingsHint}>{t('gitLlmUnavailable')}</div>
      )}
      {!catalogFailed && catalog === null && <div className={css.gitSettingsHint}>{t('loading')}</div>}

      <div className={css.gitSettingsRow}>
        <span className={css.gitSettingsLabel}>{t('gitLlmProvider')} / {t('gitLlmModel')}</span>
        <ChooseBox
          label={`${t('gitLlmProvider')} / ${t('gitLlmModel')}`}
          valueLabel={modelLabel}
          valueMeta={providerLabel}
          selectedId={provider === '' || model === '' ? undefined : `${provider}\u0000${model}`}
          groups={modelGroups}
          disabled={catalogFailed || catalog?.available === false}
          busy={catalog === null}
          emptyText={t('gitLlmUnavailable')}
          onSelect={(id) => {
            const separator = id.indexOf('\u0000')
            if (separator < 0) return
            setProbe(null)
            set(GIT_COMMIT_SETTING_KEYS.provider, id.slice(0, separator))
            set(GIT_COMMIT_SETTING_KEYS.model, id.slice(separator + 1))
          }}
        />
        <div className={css.gitProbeRow}>
          <button
            type="button"
            className={css.gitProbeButton}
            disabled={provider === '' || model === '' || probe?.kind === 'testing'}
            onClick={() => { void testConnection() }}
          >
            {probe?.kind === 'testing' ? t('gitLlmProbeTesting') : t('gitLlmProbe')}
          </button>
          {probe?.text !== undefined && (
            <span
              className={clsx(css.gitProbeResult, probe.kind === 'success' ? css.gitProbeSuccess : css.gitProbeError)}
              role={probe.kind === 'error' ? 'alert' : 'status'}
            >
              {probe.text}
            </span>
          )}
        </div>
      </div>

      <div className={css.gitSettingsRow}>
        <span className={css.gitSettingsLabel}>{t('gitTemplate')}</span>
        <ChooseBox
          label={t('gitTemplate')}
          valueLabel={templateMeta === undefined ? template : t(templateMeta.labelKey)}
          selectedId={template}
          groups={templateGroups}
          emptyText="—"
          onSelect={(id) => { set(GIT_COMMIT_SETTING_KEYS.template, id) }}
        />
      </div>

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
