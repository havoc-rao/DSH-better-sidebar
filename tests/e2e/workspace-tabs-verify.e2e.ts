/**
 * Workspace-bound windows (workspace-tabs feature) functional lane:
 * drives the REAL sidebar in headless Chromium through bind/unbind of a
 * file window and a terminal, and verifies the behaviors the unit tests
 * pin at the store level:
 *
 *  1. bind a file window via the tab context menu → the pin appears (the
 *     stub renders pinned in the panel the tab was bound from, with the
 *     pin glyph), the original local tab is gone;
 *  2. unbind (keep in session) → the pin disappears and a plain local tab
 *     materializes in its place;
 *  3. a bound TERMINAL keeps its running process across BOTH transitions:
 *     type a marker command, bind (the stub re-attaches to the SAME pty —
 *     the transcript replay still shows the marker), switch to the
 *     workspace's second session (the shared window renders there too),
 *     switch back, unbind (the local tab re-attaches to the SAME pty —
 *     the marker is still on screen);
 *  4. the command-title feature rides along: after `echo PIN-SURVIVES`
 *     the terminal tab's title settles to `echo` (first token).
 *
 * Runs like the mount lane: the server is booted by `scripts/e2e-mount.sh`
 * (DSH_E2E_URL injected). Self-scoped to its OWN workspace
 * (WS-TABS-VERIFY), so it coexists with the mount lane's seeding in the
 * same server instance. Any crash surfaces as a pageerror / plugin
 * console error / error strip and fails the lane.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, request, type APIRequestContext } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted and point this lane at it (see scripts/e2e-mount.sh)')
}

/** This lane's own workspace (a distinct path + renamed title, so the
 *  session-row selectors below never collide with the mount lane's data). */
const WS_PATH = join(tmpdir(), 'dsh-e2e-ws-tabs')
const WS_TITLE = 'WS-TABS-VERIFY'
/** The file opened through the Files window tree and bound/unbound. */
const SEEDED_FILE = 'verify.txt'
/** The terminal marker: its echo must survive bind AND unbind (the same
 *  pty process lives on; a respawned shell would not show it). */
const MARKER = 'PIN-SURVIVES'

/** The plugin's crash markers (mirror of tests/e2e/mount.e2e.ts). */
const CRASH_STRIP_PATTERNS = [/^dsh-better-sidebar:/, /^\[dsh-better-sidebar\]/]

let api: APIRequestContext
/** Monotonic rpcId: the gateway dedupes repeated ids, so two identical
 *  calls (e.g. creating two sessions) must carry distinct ids. */
let rpcSeq = 0

/** One host unary RPC (the same envelope the UI uses). */
async function rpc<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  rpcSeq += 1
  const response = await api.post(`${BASE_URL}/api/${method}`, {
    data: { type: 'client-request', rpcId: `e2e-${method}-${rpcSeq}`, method, payload },
  })
  expect(response.ok(), `${method}: ${response.status()} ${await response.text()}`).toBe(true)
  const body = (await response.json()) as { result: { ok: true; value: T } | { ok: false; error: unknown } }
  expect(body.result.ok, `${method} rejected: ${JSON.stringify(body.result)}`).toBe(true)
  return (body.result as { value: T }).value
}

/** Seed this lane's workspace: one workspace (renamed to a distinctive
 *  title) with TWO sessions in it — the cross-session stub sync needs a
 *  sibling session to switch to. Both sessions get a user message: a
 *  BLANK session only renders while it is the current one (the workspace
 *  browser hides non-current blank rows), so un-blanking both keeps both
 *  rows always visible and clickable. */
async function seedWorkspaceTabs(): Promise<void> {
  mkdirSync(WS_PATH, { recursive: true })
  writeFileSync(join(WS_PATH, SEEDED_FILE), 'workspace-tabs verify lane\n')
  const { workspace } = await rpc<{ workspace: { workspaceId: string } }>('workspace.create', { path: WS_PATH })
  await rpc('workspace.rename', { workspaceId: workspace.workspaceId, title: WS_TITLE })
  const first = await rpc<{ sessionId: string }>('session.create', { workspaceId: workspace.workspaceId })
  const second = await rpc<{ sessionId: string }>('session.create', { workspaceId: workspace.workspaceId })
  await rpc('session.prompt', {
    sessionId: first.sessionId, mode: 'queue', content: [{ type: 'text', text: 'verify-session-1' }],
  })
  await rpc('session.prompt', {
    sessionId: second.sessionId, mode: 'queue', content: [{ type: 'text', text: 'verify-session-2' }],
  })
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
  await seedWorkspaceTabs()
})

test.afterAll(async () => {
  await api?.dispose()
})

test('workspace bind/unbind: pin in the bound area, cross-session sync, terminal process survives', async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })

  // Dismiss the keyless-boot onboarding takeovers (see mount.e2e.ts).
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e-ws-tabs] no onboarding takeover appeared; proceeding')
  }
  for (let round = 0; round < 8; round++) {
    let dismissed = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if ((await button.count()) === 0) continue
      try {
        await button.click({ timeout: 4_000 })
        dismissed = true
        await page.waitForTimeout(1_000)
      } catch {
        // Masked by the takeover stacked above it; retry next round.
      }
    }
    if (!dismissed) break
  }

  const assertNoCrash = async (): Promise<void> => {
    await expect.poll(async () => pageErrors, { timeout: 5_000 }).toEqual([])
    const strips = await sidebar.locator('div').evaluateAll(
      (nodes, patterns) => nodes.filter((node) => {
        const text = (node.textContent ?? '').trim()
        return patterns.some((pattern) => pattern.test(text))
      }).length,
      CRASH_STRIP_PATTERNS,
    )
    expect(strips, 'a dsh-better-sidebar error strip is present in the sidebar').toBe(0)
  }

  // ── Session rows: the workspace browser lives in the HOST's left
  // sidebar (outside the plugin's right panel), so these selectors are
  // PAGE-scoped. The two prompted sessions are located by their prompt
  // text — the browser may also show the boot's blank current session as
  // an extra "New Session" row, so position-based selection is unreliable.
  const groupRow = page.locator('[role="treeitem"][aria-expanded]', { hasText: WS_TITLE })
  await expect(groupRow).toHaveCount(1, { timeout: 60_000 })
  if ((await groupRow.getAttribute('aria-expanded')) === 'false') {
    await groupRow.click()
  }
  const sessionA = page.locator('[role="treeitem"][aria-selected]', { hasText: 'verify-session-1' })
  const sessionB = page.locator('[role="treeitem"][aria-selected]', { hasText: 'verify-session-2' })
  await expect(sessionA, 'session 1 row must render (non-blank, prompted)').toHaveCount(1, { timeout: 30_000 })
  await expect(sessionB, 'session 2 row must render (non-blank, prompted)').toHaveCount(1, { timeout: 30_000 })

  // Pin the flow to session A: the boot may have left a blank session
  // current, so switch explicitly, then expand the (collapsed) panel.
  await sessionA.click()
  const firstExpand = sidebar.getByRole('button', { name: 'Expand sidebar' })
  await expect(firstExpand).toHaveCount(1)
  await firstExpand.click()
  await expect
    .poll(async () => (
      await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
    ), { timeout: 90_000 })
    .not.toBe('')

  // ── 1. File window: bind → pin, unbind → local tab ─────────────────────
  const filesTab = sidebar.locator('[title="Files"][draggable="true"]').first()
  await expect(filesTab).toHaveCount(1, { timeout: 60_000 })
  await filesTab.click()
  const fileRow = sidebar.locator(`[role="button"][title$="${SEEDED_FILE}"]:visible`)
  await expect(fileRow, `the seeded "${SEEDED_FILE}" must appear in the files window's tree`).toHaveCount(1, { timeout: 30_000 })
  await fileRow.click({ position: { x: 8, y: 8 } })
  const pathInput = sidebar.locator('input[placeholder^="File path"]:visible')
  await expect(pathInput, 'the file opened in place in the files window').toHaveValue(new RegExp(`${SEEDED_FILE}$`), { timeout: 30_000 })

  const fileTab = sidebar.locator(`[title="${SEEDED_FILE}"][draggable="true"]`).first()
  await expect(fileTab).toHaveCount(1, { timeout: 30_000 })
  await fileTab.click({ button: 'right' })
  const bindItem = page.getByRole('menuitem', { name: /Bind to workspace/ })
  await expect(bindItem, 'the bind menu item must appear on a session-local tab').toHaveCount(1)
  await bindItem.click()
  // The reparent/bind settles asynchronously (HTTP + reconcile) — poll.
  await expect(sidebar.locator('[class*="tabPin"]:visible'), 'the pinned stub shows the pin glyph').toHaveCount(1, { timeout: 15_000 })
  // Exactly one visible "verify.txt" remains: the STUB (its title resolves
  // the live definition from the store). If the original tab had stayed
  // and the stub were elsewhere (e.g. a closed bottom box), the visible
  // count would be 1 WITHOUT a visible pin — the pin + single visible tab
  // together prove the original was replaced by the stub.
  await expect(sidebar.locator(`[title="${SEEDED_FILE}"][draggable="true"]:visible`)).toHaveCount(1, { timeout: 15_000 })
  await assertNoCrash()

  // Unbind (keep in session): the pin leaves, a plain local tab returns.
  const stubTab = sidebar.locator(`[title="${SEEDED_FILE}"][draggable="true"]:visible`).first()
  await stubTab.click({ button: 'right' })
  const unbindItem = page.getByRole('menuitem', { name: /Unbind from workspace/ })
  await expect(unbindItem).toHaveCount(1)
  await unbindItem.click()
  await expect(sidebar.locator('[class*="tabPin"]:visible'), 'the pin left the strip after unbind').toHaveCount(0, { timeout: 15_000 })
  await expect(sidebar.locator(`[title="${SEEDED_FILE}"][draggable="true"]:visible`), 'a local file tab materialized in place of the stub').toHaveCount(1, { timeout: 15_000 })
  await assertNoCrash()

  // ── 2. Terminal: the running process survives bind AND unbind ───────────
  const newTabButton = sidebar.getByRole('button', { name: 'New tab' }).first()
  await newTabButton.click()
  const terminalItem = page.getByRole('menuitem', { name: 'Terminal' })
  await expect(terminalItem).toHaveCount(1)
  await terminalItem.click()
  const xterm = sidebar.locator('.xterm:visible')
  await expect(xterm, 'the terminal surface mounted').toHaveCount(1, { timeout: 30_000 })
  await xterm.click()
  await page.keyboard.type(`echo ${MARKER}`)
  await page.keyboard.press('Enter')
  await expect(sidebar.locator('.xterm-rows'), 'the echo marker appears in the terminal').toContainText(MARKER, { timeout: 30_000 })
  // The command-title feature: the tab title settles to the first token.
  const terminalTab = sidebar.locator('[title="echo"][draggable="true"]').first()
  await expect(terminalTab, 'the terminal tab title follows the running command (first token)').toHaveCount(1, { timeout: 15_000 })

  // Bind the terminal: the stub re-attaches to the SAME pty (shared key);
  // the transcript replay must still show the marker — a respawned shell
  // would be blank.
  await terminalTab.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Bind to workspace/ }).click()
  await expect(sidebar.locator('[class*="tabPin"]:visible'), 'the terminal pin appeared after bind').toHaveCount(1, { timeout: 15_000 })
  await expect(sidebar.locator('.xterm-rows'), 'the marker survived the BIND (same process, transcript replay)').toContainText(MARKER, { timeout: 30_000 })
  await assertNoCrash()

  // The shared window renders in the workspace's SECOND session too.
  await sessionB.click()
  const secondExpand = sidebar.getByRole('button', { name: 'Expand sidebar' })
  if ((await secondExpand.count()) === 1) {
    await secondExpand.click()
  }
  await expect(sidebar.locator('[class*="tabPin"]:visible'), 'the pinned terminal renders in the sibling session').toHaveCount(1, { timeout: 30_000 })
  await expect(sidebar.locator('.xterm-rows'), 'the sibling session attaches to the same process').toContainText(MARKER, { timeout: 30_000 })
  await assertNoCrash()

  // Back to session 1; unbind the terminal (keep in session): the local
  // tab re-attaches to the SAME process — the marker must survive.
  await sessionA.click()
  const backExpand = sidebar.getByRole('button', { name: 'Expand sidebar' })
  if ((await backExpand.count()) === 1) {
    await backExpand.click()
  }
  await sidebar.locator('[class*="tabPin"]:visible').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Unbind from workspace/ }).click()
  await expect(sidebar.locator('[class*="tabPin"]:visible'), 'the pin left after unbinding the terminal').toHaveCount(0, { timeout: 15_000 })
  await expect(sidebar.locator('.xterm-rows'), 'the marker survived the UNBIND (same process re-attached)').toContainText(MARKER, { timeout: 30_000 })
  await assertNoCrash()

  // No plugin-prefixed or unhandled console errors may escape the lane.
  const pluginErrors = consoleErrors.filter((text) => /dsh-better-sidebar|Unhandled/.test(text))
  expect(pluginErrors, 'plugin-prefixed or unhandled console errors during the workspace-tabs lane').toEqual([])
  expect(pageErrors, 'pageerrors during the workspace-tabs lane').toEqual([])

  await page.screenshot({ path: 'test-results/workspace-tabs-verify-final.png' })
})
