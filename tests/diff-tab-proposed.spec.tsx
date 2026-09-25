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

  it('renders the truncation + source notice for caller-declared metadata (and omits it when untruncated)', async () => {
    const renderRef = async (diff: SidebarDiffRef): Promise<{ container: HTMLDivElement; unmount: () => void }> => {
      const container = document.createElement('div')
      document.body.append(container)
      const root: Root = createRoot(container)
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: 'C:/repo', diff }))
      })
      await flushEffects()
      return {
        container,
        unmount: (): void => {
          act(() => { root.unmount() })
          container.remove()
        },
      }
    }
    const truncated = await renderRef({
      kind: 'proposed',
      id: 'plan:1:commit:2',
      title: 'Commit 2 of 3',
      patch: PATCH,
      truncated: true,
      sourceRef: 'plan p rev 2',
    })
    try {
      // The notice bar surfaces both the snapshot banner, the caller's
      // source label and the truncation marker.
      expect(truncated.container.textContent).toContain('Plan snapshot · read-only text preview, no git is run')
      expect(truncated.container.textContent).toContain('plan p rev 2')
      expect(truncated.container.textContent).toContain('Diff preview truncated (partial)')
    } finally {
      truncated.unmount()
    }
    const untruncated = await renderRef({
      kind: 'proposed',
      id: 'plan:1:commit:2',
      title: 'Commit 2 of 3',
      patch: PATCH,
      sourceRef: 'plan p rev 2',
    })
    try {
      // Same source label, but no truncated flag → the truncation segment
      // must not render.
      expect(untruncated.container.textContent).toContain('plan p rev 2')
      expect(untruncated.container.textContent).not.toContain('Diff preview truncated')
    } finally {
      untruncated.unmount()
    }
  })

  it('opens a changed file from its header via onOpenFile', async () => {
    const onOpenFile = vi.fn()
    const ref: SidebarDiffRef = { kind: 'proposed', id: 'plan:1:commit:2', title: 'Commit 2 of 3', patch: PATCH }
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: 'C:/repo', diff: ref, onOpenFile }))
      })
      await flushEffects()
      const openButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open file"]')
      expect(openButton).not.toBeNull()
      act(() => { openButton!.click() })
      expect(onOpenFile).toHaveBeenCalledTimes(1)
      expect(onOpenFile).toHaveBeenCalledWith('src/a.ts')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('renders an explicit notice for a non-empty unparseable patch with no git call', async () => {
    const gitDiff = vi.spyOn(api, 'gitDiff')
    const commitDiff = vi.spyOn(api, 'gitCommitDiff')
    const ref: SidebarDiffRef = {
      kind: 'proposed',
      id: 'plan:garbage',
      title: 'Garbage plan',
      patch: 'not a unified diff\njust text',
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: 'C:/repo', diff: ref }))
      })
      await flushEffects()
      // DiffFiles renders nothing for a zero-file parse — the explicit
      // unparseable notice must surface instead of a blank pane.
      expect(container.textContent).toContain('Cannot parse this diff text')
      expect(gitDiff).not.toHaveBeenCalled()
      expect(commitDiff).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('diffLoadError')
      expect(container.textContent).toContain('Garbage plan')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('opens the changed file at a clicked row\'s new-side line via onOpenRow', async () => {
    const onOpenFile = vi.fn()
    const onOpenRow = vi.fn()
    const ref: SidebarDiffRef = { kind: 'proposed', id: 'plan:1:commit:2', title: 'Commit 2 of 3', patch: PATCH }
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: 'C:/repo', diff: ref, onOpenFile, onOpenRow }))
      })
      await flushEffects()

      // The hunk rows carry the open affordance: title from the new i18n
      // key, keyboard reachability, and a click that opens at the row's
      // NEW-side line.
      const addRow = container.querySelector<HTMLElement>('[data-kind="add"]')
      const ctxRow = container.querySelector<HTMLElement>('[data-kind="context"]')
      expect(addRow).not.toBeNull()
      expect(ctxRow).not.toBeNull()
      expect(addRow!.getAttribute('title')).toBe('Open file at line 2')
      expect(addRow!.getAttribute('tabindex')).toBe('0')

      act(() => { ctxRow!.click() })
      expect(onOpenRow).toHaveBeenCalledTimes(1)
      expect(onOpenRow).toHaveBeenCalledWith('src/a.ts', 1)
      expect(onOpenFile).not.toHaveBeenCalled()

      act(() => { addRow!.click() })
      expect(onOpenRow).toHaveBeenCalledTimes(2)
      expect(onOpenRow).toHaveBeenLastCalledWith('src/a.ts', 2)

      // Keyboard: Enter on a focused row opens it too.
      act(() => { addRow!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      expect(onOpenRow).toHaveBeenCalledTimes(3)
      expect(onOpenRow).toHaveBeenLastCalledWith('src/a.ts', 2)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }

    // A deleted row has no new-side line: the open carries `null`.
    const delRef: SidebarDiffRef = {
      kind: 'proposed',
      id: 'plan:1:commit:3',
      title: 'Commit 3 of 3',
      patch: [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1111111..2222222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,1 @@',
        ' const a = 1',
        '-const b = 2',
        '',
      ].join('\n'),
    }
    const container2 = document.createElement('div')
    document.body.append(container2)
    const root2: Root = createRoot(container2)
    try {
      await act(async () => {
        root2.render(createElement(DiffTab, { sessionId: 'session', cwd: 'C:/repo', diff: delRef, onOpenRow }))
      })
      await flushEffects()
      const delRow = container2.querySelector<HTMLElement>('[data-kind="del"]')
      expect(delRow).not.toBeNull()
      act(() => { delRow!.click() })
      expect(onOpenRow).toHaveBeenCalledTimes(4)
      expect(onOpenRow).toHaveBeenLastCalledWith('src/a.ts', null)
    } finally {
      act(() => { root2.unmount() })
      container2.remove()
    }
  })

  it('keeps rows non-openable when onOpenRow is absent', async () => {
    const ref: SidebarDiffRef = { kind: 'proposed', id: 'plan:1:commit:2', title: 'Commit 2 of 3', patch: PATCH }
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(DiffTab, { sessionId: 'session', cwd: 'C:/repo', diff: ref }))
      })
      await flushEffects()
      const addRow = container.querySelector<HTMLElement>('[data-kind="add"]')
      const ctxRow = container.querySelector<HTMLElement>('[data-kind="context"]')
      // No open title, no keyboard reachability, no click handling — the
      // row renders exactly as before (the pre-existing suites over
      // DiffRows/DiffFiles pin the rest of the DOM).
      expect(addRow!.getAttribute('title')).toBeNull()
      expect(addRow!.getAttribute('tabindex')).toBeNull()
      expect(ctxRow!.getAttribute('title')).toBeNull()
      expect(ctxRow!.getAttribute('tabindex')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
