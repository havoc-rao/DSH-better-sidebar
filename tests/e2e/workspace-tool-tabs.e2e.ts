/**
 * Real-host workspace Files/Git synchronization, through public UI only.
 * Creates sessions from each workspace's own rail action, not the global New
 * session button (which could silently use a different selected workspace).
 * A second Page shares browser storage and exercises real storage events.
 * No host internals, localStorage writes, test-only services, or server startup.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, sendFirstMessage } from './host'

let api: APIRequestContext
let workspaceA: string
let workspaceB: string
const pathA = mkdtempSync(join(tmpdir(), 'dsh-e2e-tool-tabs-a-'))
const pathB = mkdtempSync(join(tmpdir(), 'dsh-e2e-tool-tabs-b-'))
const pane = (page: Page): Locator => page.locator('[data-sidebar-right-panel]:visible').first()
const toolTab = (page: Page, kind: 'files' | 'git'): Locator => pane(page)
  .locator('[data-dockkit-strip] [role="tab"]')
  .filter({ hasText: kind === 'files' ? /Files|文件/ : /Git/ })

async function visibleSession(page: Page): Promise<string | undefined> {
  const seat = page.locator('[data-sidebar-right-session]:visible').first()
  return await seat.count() ? (await seat.getAttribute('data-sidebar-right-session')) ?? undefined : undefined
}
async function boot(page: Page): Promise<void> {
  // Stamped navigation uses the shared helper's pre-exchanged auth cookie;
  // token redirects must not discard these query parameters.
  await gotoPage(page, { workspaceToolTabsLane: '1' })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
}
async function expandSidebar(page: Page): Promise<void> {
  const expand = page.locator('[data-sidebar-right-expand]:visible').first()
  if (await expand.count()) await expand.click()
  await expect(pane(page)).toBeVisible({ timeout: 30_000 })
}
async function createConversation(page: Page, workspaceId: string): Promise<string> {
  const before = await visibleSession(page)
  const workspace = page.locator(`[data-row-key="workspace:${workspaceId}"]`)
  await expect(workspace).toBeVisible({ timeout: 60_000 })
  if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
  await workspace.hover()
  await workspace.getByRole('button', { name: /New session in|新建会话/ }).click()
  await expect.poll(async () => {
    const sid = await visibleSession(page)
    return sid !== undefined && sid !== before ? sid : ''
  }, { timeout: 60_000 }).not.toBe('')
  const sid = await visibleSession(page)
  if (!sid) throw new Error('new conversation did not acquire a native sidebar seat')
  // Creating a keyless session can raise Get started again after navigation.
  await dismissOnboarding(page)
  // Give the conversation a durable rail row for subsequent page selection.
  await sendFirstMessage(page)
  return sid
}
async function selectConversation(page: Page, workspaceId: string, sessionId: string): Promise<void> {
  const workspace = page.locator(`[data-row-key="workspace:${workspaceId}"]`)
  await expect(workspace).toBeVisible({ timeout: 60_000 })
  if (await workspace.getAttribute('aria-expanded') !== 'true') await workspace.click()
  const row = page.locator(`[data-row-key="session:${sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(row).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
  await expect.poll(() => visibleSession(page), { timeout: 30_000 }).toBe(sessionId)
}
async function openTool(page: Page, kind: 'files' | 'git'): Promise<void> {
  await expandSidebar(page)
  if (await toolTab(page, kind).count()) {
    await toolTab(page, kind).click()
    return
  }
  const guide = pane(page).locator('[data-sidebar-right-guide]:visible')
  if (await guide.count() === 0) await pane(page).locator('[data-dockkit-add-tab]').first().click()
  await expect(guide).toBeVisible({ timeout: 30_000 })
  await pane(page).locator(`[data-sidebar-right-guide-entry="${kind}"]`).click()
  await expect(toolTab(page, kind)).toHaveCount(1, { timeout: 30_000 })
}
async function closeTool(page: Page, kind: 'files' | 'git'): Promise<void> {
  const tab = toolTab(page, kind)
  await expect(tab).toHaveCount(1, { timeout: 30_000 })
  await tab.hover()
  await tab.locator('[data-dockkit-tab-close]').click()
  await expect(toolTab(page, kind)).toHaveCount(0, { timeout: 30_000 })
}

test.beforeAll(async () => {
  api = await createHostApi()
  for (const path of [pathA, pathB]) {
    writeFileSync(join(path, 'workspace-tool-tabs.txt'), `workspace ${basename(path)}\n`)
    execFileSync('git', ['init', '-q'], { cwd: path })
  }
  workspaceA = (await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: pathA }))
    .value.workspace.workspaceId
  workspaceB = (await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: pathB }))
    .value.workspace.workspaceId
})
test.afterAll(async () => { await api?.dispose() })

test('tools inherit within a workspace and across pages, closes propagate, other workspaces stay isolated', async ({ page, context }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  const watch = (target: Page): void => {
    target.on('pageerror', error => errors.push(String(error)))
    target.on('console', message => {
      if (message.type() === 'error' && /subscriber failed|workspace tool restore failed|native register .* error/.test(message.text())) errors.push(message.text())
    })
  }
  watch(page)
  await boot(page)
  const sessionA = await createConversation(page, workspaceA)
  await openTool(page, 'files')
  await expect(pane(page).locator('[role="button"][title$="workspace-tool-tabs.txt"]:visible'))
    .toHaveCount(1, { timeout: 30_000 })
  await openTool(page, 'git')
  await expect(pane(page).locator('[data-message-box] textarea')).toBeVisible({ timeout: 30_000 })

  // Fresh same-workspace seat: no guide clicks or tab reconstruction by the test.
  const sessionB = await createConversation(page, workspaceA)
  expect(sessionB).not.toBe(sessionA)
  await expandSidebar(page)
  await expect(toolTab(page, 'files')).toHaveCount(1, { timeout: 30_000 })
  await expect(toolTab(page, 'git')).toHaveCount(1, { timeout: 30_000 })

  const other = await context.newPage()
  watch(other)
  try {
    await boot(other)
    await selectConversation(other, workspaceA, sessionB)
    await expandSidebar(other)
    await expect(toolTab(other, 'files')).toHaveCount(1, { timeout: 30_000 })
    await expect(toolTab(other, 'git')).toHaveCount(1, { timeout: 30_000 })

    // Distinct native session on the first page proves this is workspace state,
    // not two views of one session's already-persisted layout.
    await selectConversation(page, workspaceA, sessionA)
    await expandSidebar(page)
    await closeTool(other, 'git')
    await expect(toolTab(page, 'git')).toHaveCount(0, { timeout: 30_000 })
    await closeTool(other, 'files')
    // Closing the final tool may collapse either panel; assert absence in its
    // retained session container, not only :visible (which could falsely pass).
    await expect(page.locator(`[data-sidebar-right-session="${sessionA}"] [data-dockkit-strip] [role="tab"]`)
      .filter({ hasText: /Files|文件|Git/ })).toHaveCount(0, { timeout: 30_000 })

    // A stale session switch must not turn saved occurrences back into opens.
    await selectConversation(page, workspaceA, sessionB)
    await expandSidebar(page)
    await expect(toolTab(page, 'files')).toHaveCount(0)
    await expect(toolTab(page, 'git')).toHaveCount(0)
    await openTool(page, 'files')
    await openTool(page, 'git')

    // Independently created workspace has no shared tools, despite identical
    // file names and the same browser/profile origin.
    await createConversation(page, workspaceB)
    await expandSidebar(page)
    await expect(pane(page).locator('[data-sidebar-right-guide]')).toBeVisible({ timeout: 30_000 })
    await expect(toolTab(page, 'files')).toHaveCount(0)
    await expect(toolTab(page, 'git')).toHaveCount(0)
    await selectConversation(page, workspaceA, sessionB)
    await expandSidebar(page)
    await expect(toolTab(page, 'files')).toHaveCount(1, { timeout: 30_000 })
    await expect(toolTab(page, 'git')).toHaveCount(1, { timeout: 30_000 })
    expect(errors, 'uncaught page errors').toEqual([])
  } finally {
    await other.close()
  }
})
