/**
 * Opt-in real-host Run lane (no replacement GUI and no LLM):
 * CODE_BLOCK_RUN_FIXTURE=1 bash scripts/e2e-mount.sh --grep 'code-block Run'
 * The scratch-only fixture records a completed assistant shell fence through
 * public Session services. Real Run requests and PTY WebSockets are never mocked.
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, sidebarApi } from './host'

const SESSION_ID = 'session-e2e-code-block-run'
const COMMAND = "printf 'RUN_CWD='; pwd; printf 'RUN_OUTPUT_OK\\n'"
const WORKSPACE = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-code-block-run')

test('code-block Run opens an isolated workspace terminal without sending chat', async ({ page }) => {
  test.skip(!process.env.CODE_BLOCK_RUN_FIXTURE, 'Enable scratch-only assistant data fixture with CODE_BLOCK_RUN_FIXTURE=1')
  test.skip(process.platform === 'win32', 'Windows command execution is explicitly outside this feature scope')
  const api = await createHostApi()
  const pageErrors: string[] = []
  const runRequests: Array<Record<string, unknown>> = []
  const chatWrites: string[] = []
  let terminalOutput = ''
  const outputByTerminal = new Map<string, string>()
  let terminalId: string | undefined
  const createRequests: string[] = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  page.on('request', req => {
    const path = new URL(req.url()).pathname
    if (path === '/sidebar/api/workspace-terminal.run') runRequests.push(req.postDataJSON() as Record<string, unknown>)
    if (path === '/sidebar/api/workspace-terminal.create') createRequests.push(path)
    if (req.method() === 'POST' && /^\/api\/session\/(?:prompt|send|submit)/.test(path)) chatWrites.push(path)
  })
  page.on('websocket', socket => {
    const url = new URL(socket.url())
    if (url.pathname !== '/sidebar/ws/terminal') return
    const id = url.searchParams.get('terminalId') ?? ''
    socket.on('framereceived', event => {
      const output = typeof event.payload === 'string' ? event.payload : event.payload.toString('utf8')
      terminalOutput += output
      outputByTerminal.set(id, (outputByTerminal.get(id) ?? '') + output)
    })
  })
  try {
    mkdirSync(WORKSPACE, { recursive: true })
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE })
    await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId, sessionId: SESSION_ID })
    await gotoPage(page)
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await dismissOnboarding(page)
    const row = page.locator(`[data-row-key="session:${SESSION_ID}"]`)
    await expect(row).toBeVisible({ timeout: 60_000 })
    await row.click()
    const block = page.locator('.md-code-block').filter({ hasText: 'RUN_OUTPUT_OK' }).first()
    await expect(block).toBeVisible({ timeout: 60_000 })
    const run = block.getByRole('button', { name: /^(Run in a separate terminal|在独立终端运行)$/ })
    await expect(run).toBeVisible()
    // No process is started merely by rendering the source/registered action.
    const before = await api.post(sidebarApi('workspace-terminal.list'), { data: { sessionId: SESSION_ID } })
    expect(before.ok()).toBe(true)
    const beforeBody = await before.json() as { ok: boolean; value: { terminals: Array<{ terminalId: string }> } }
    expect(beforeBody.ok).toBe(true)
    const existingIds = beforeBody.value.terminals.map(info => info.terminalId)
    expect(runRequests).toHaveLength(0)
    const conversation = page.locator('[data-slot="conversation.chat.flow"]').filter({ hasText: 'Run fixture command:' }).first()
    const messagesBefore = await conversation.textContent()
    const responseWait = page.waitForResponse(response => new URL(response.url()).pathname === '/sidebar/api/workspace-terminal.run')
    await run.click()
    const response = await responseWait
    const body = await response.json() as { ok: boolean; value?: { terminalId: string; title: string; cwd: string; createdBySessionId: string }; error?: unknown }
    // Keep actual host errors (including posix_spawnp/PTY sandbox refusals) in
    // the report, rather than skipping or faking a successful terminal.
    expect(body, JSON.stringify(body)).toMatchObject({ ok: true, value: { cwd: realpathSync(WORKSPACE), createdBySessionId: SESSION_ID } })
    terminalId = body.value!.terminalId
    expect(existingIds).not.toContain(terminalId)
    expect(runRequests).toEqual([{ sessionId: SESSION_ID, command: `${COMMAND}\n`,
      operationId: expect.stringMatching(/^\d+:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    }])
    const panel = page.locator('[data-dsh-bottom-panel]')
    await expect(panel).toBeVisible({ timeout: 30_000 })
    const terminals = panel.locator('[data-dsh-bottom-terminal]')
    await expect(terminals.first()).toBeAttached({ timeout: 30_000 })
    await expect.poll(() => terminalOutput, { timeout: 30_000 }).toContain(`RUN_CWD=${realpathSync(WORKSPACE)}`)
    await expect.poll(() => terminalOutput, { timeout: 30_000 }).toContain('RUN_OUTPUT_OK')
    await expect(terminals).toHaveCount(1)
    const terminal = terminals.first()
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-terminal-state', 'connected')
    await expect(terminal.locator('.xterm-rows')).toContainText('RUN_OUTPUT_OK')
    // Completion is a shell-command event, NOT a PTY exit. Wait for its
    // authoritative metadata before sending the next input into the same PTY.
    await expect.poll(async () => {
      const response = await api.post(sidebarApi('workspace-terminal.list'), { data: { sessionId: SESSION_ID } })
      const result = await response.json() as { value: { terminals: Array<{ terminalId: string; exited: boolean; commandExitCode?: number }> } }
      return result.value.terminals.find(info => info.terminalId === terminalId)
    }).toMatchObject({ terminalId, exited: false, commandExitCode: 0 })
    const screen = await terminal.locator('.xterm-screen').elementHandle()
    await terminal.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type("printf 'INTERACTIVE_%s\\n' STILL_ALIVE")
    await page.keyboard.press('Enter')
    await expect.poll(() => outputByTerminal.get(terminalId!) ?? '').toContain('INTERACTIVE_STILL_ALIVE')
    await expect(terminal.locator('.xterm-rows')).toContainText('INTERACTIVE_STILL_ALIVE')
    await expect(terminal.locator('.xterm-rows')).toContainText('RUN_OUTPUT_OK')
    expect(await screen!.evaluate(node => node.isConnected)).toBe(true)
    await expect(terminals).toHaveCount(1)
    expect(createRequests).toEqual([])
    expect(terminalOutput).not.toContain('[process exited with code')
    await expect(conversation).toHaveText(messagesBefore ?? '')
    expect(chatWrites).toEqual([])
    expect(runRequests).toHaveLength(1)
    expect(pageErrors).toEqual([])
  } finally {
    if (terminalId !== undefined) await api.post(sidebarApi('workspace-terminal.terminate'), { data: { sessionId: SESSION_ID, terminalId } })
    await api.dispose()
  }
})
