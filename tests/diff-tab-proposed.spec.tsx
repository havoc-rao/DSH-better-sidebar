/**
 * The `proposed` diff ref (feature `planDiff`): a caller-supplied raw unified
 * patch renders through the shared DiffFiles stack with NO git call — the
 * additive seam an external plugin uses to preview a plan's per-commit diff.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DiffTab } from '../src/client/DiffTab.tsx'
import type { SidebarDiffRef } from '../src/client/state.ts'
import { api } from '../src/client/api.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,2 @@',
  ' const a = 1',
  '+const b = 2',
  '',
].join('\n')

async function flushEffects(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

afterEach(() => { vi.restoreAllMocks() })

describe('DiffTab proposed patch (feature planDiff)', () => {
  it('renders a caller-supplied patch with no git call', async () => {
    const gitDiff = vi.spyOn(api, 'gitDiff')
    const commitDiff = vi.spyOn(api, 'gitCommitDiff')
    const ref: SidebarDiffRef = {
      kind: 'proposed',
      id: 'plan:1:commit:2',
      title: 'Commit 2 of 3',
      patch: PATCH,
    }

    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: 'C:/repo', diff: ref }))
      })
      await flushEffects()

      // The patch content reached the shared diff renderer...
      expect(container.textContent).toContain('a.ts')
      expect(container.textContent).toContain('const b = 2')
      // ...and the header carries the caller's title verbatim.
      expect(container.textContent).toContain('Commit 2 of 3')
      // ...with no repository I/O at all.
      expect(gitDiff).not.toHaveBeenCalled()
      expect(commitDiff).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('diffLoadError')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('shows the empty state for a blank proposed patch', async () => {
    const ref: SidebarDiffRef = { kind: 'proposed', id: 'plan:empty', title: 'Empty plan', patch: '' }
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: 'C:/repo', diff: ref }))
      })
      await flushEffects()
      expect(container.textContent).toContain('Empty plan')
      expect(container.textContent).not.toContain('diffLoadError')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
