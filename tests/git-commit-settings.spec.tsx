// @vitest-environment jsdom
/** Git commit settings choose-box regression: mirrors DSH ModelSelect. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { GitCommitSettings } from '../src/client/GitCommitSettings.tsx'
import { api } from '../src/client/api.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

afterEach(() => { vi.restoreAllMocks() })

async function mount(
  updatePluginSetting: (key: string, value: unknown) => void,
  pluginSettings: Record<string, unknown> = {},
): Promise<{
  host: HTMLDivElement
  root: Root
}> {
  vi.spyOn(api, 'llmCatalog').mockResolvedValue({
    available: true,
    providers: [{
      id: 'openai',
      name: 'OpenAI-compatible',
      models: [
        { id: 'gpt-5.4', name: 'GPT 5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT 5.4 Mini' },
      ],
    }, {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    }],
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(GitCommitSettings, { pluginSettings, updatePluginSetting }))
    await Promise.resolve()
  })
  return { host, root }
}

describe('GitCommitSettings choose boxes', () => {
  it('groups models by provider and commits the complete provider/model route', async () => {
    const update = vi.fn()
    const view = await mount(update)
    try {
      const triggers = view.host.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')
      expect(triggers).toHaveLength(2)
      expect(triggers[0]!.textContent).toContain('Select model')

      await act(async () => { triggers[0]!.click() })
      const menu = view.host.querySelector<HTMLElement>('[role="menu"]')!
      expect(menu.textContent).toContain('OpenAI-compatible')
      expect(menu.textContent).toContain('DeepSeek')
      expect(menu.textContent).toContain('GPT 5.4 Mini')
      expect(menu.textContent).toContain('gpt-5.4-mini')

      const option = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        .find(button => button.textContent?.includes('GPT 5.4 Mini'))!
      await act(async () => { option.click() })
      expect(update).toHaveBeenNthCalledWith(1, 'commitLlmProvider', 'openai')
      expect(update).toHaveBeenNthCalledWith(2, 'commitLlmModel', 'gpt-5.4-mini')
      expect(view.host.querySelector('[role="menu"]')).toBeNull()
    } finally {
      act(() => { view.root.unmount() })
      view.host.remove()
    }
  })

  it('uses the same checked-option choose box for the commit template', async () => {
    const update = vi.fn()
    const view = await mount(update)
    try {
      const trigger = view.host.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')[1]!
      expect(trigger.textContent).toContain('Conventional Commits')
      await act(async () => { trigger.click() })

      const options = [...view.host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      expect(options[0]!.getAttribute('aria-checked')).toBe('true')
      const gitmoji = options.find(button => button.textContent?.includes('Gitmoji'))!
      expect(gitmoji.textContent).toContain('emoji prefix')
      await act(async () => { gitmoji.click() })
      expect(update).toHaveBeenCalledWith('commitTemplate', 'gitmoji')
    } finally {
      act(() => { view.root.unmount() })
      view.host.remove()
    }
  })

  it('tests the selected provider/model with a real probe route and reports latency', async () => {
    vi.spyOn(api, 'llmProbe').mockResolvedValue({ message: 'OK', latencyMs: 123 })
    const view = await mount(vi.fn(), {
      commitLlmProvider: 'openai',
      commitLlmModel: 'gpt-5.4',
    })
    try {
      const button = [...view.host.querySelectorAll<HTMLButtonElement>('button')]
        .find(candidate => candidate.textContent === 'Test connection')!
      await act(async () => { button.click() })
      expect(api.llmProbe).toHaveBeenCalledWith(
        { provider: 'openai', model: 'gpt-5.4' },
        expect.any(AbortSignal),
      )
      expect(view.host.textContent).toContain('Connected (123ms): OK')
    } finally {
      act(() => { view.root.unmount() })
      view.host.remove()
    }
  })
})
