/** Run uses one fresh persistent interactive PTY, authoritative cwd and retained replay; never startup input. */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { NodePtyModule } from '../src/pty-deps.ts'
import { buildWorkspaceTerminalApi, resolveTerminalWorkspace, WorkspaceTerminalManager } from '../src/workspace-terminal.ts'

class MockPty {
  events = new EventEmitter()
  pid = 123
  write = vi.fn()
  kill = vi.fn()
  resize = vi.fn()
  onData(fn: (data: string) => void) { this.events.on('data', fn); return { dispose: () => this.events.off('data', fn) } }
  onExit(fn: (event: { exitCode: number }) => void) { this.events.on('exit', fn); return { dispose: () => this.events.off('exit', fn) } }
}
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN
  bufferedAmount = 0
  send = vi.fn()
  close = vi.fn()
}
const dirs: string[] = []
const managers: WorkspaceTerminalManager[] = []
afterEach(() => {
  managers.splice(0).forEach(manager => manager.disposeAll())
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.restoreAllMocks()
})
function emitStart(nodePty: { spawn: { mock: { calls: unknown[][] } } }, pty: MockPty, index = 0) {
  const call = nodePty.spawn.mock.calls[index] as [string, string[]]
  const token = /633;dsh;([a-f0-9]+);/.exec(readFileSync(call[1][1]!, 'utf8'))![1]
  pty.events.emit('data', `\x1b]633;dsh;${token};start\x07`)
  return token
}
function setup(cap = 8) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sidebar-run-'))); dirs.push(cwd)
  const processes: MockPty[] = []
  const nodePty = { spawn: vi.fn(() => { const pty = new MockPty(); processes.push(pty); return pty }) }
  let now = 100
  const probe = vi.fn(async () => ({ activity: 'idle' as const, reason: 'fixture' }))
  const manager = new WorkspaceTerminalManager('/bin/bash', nodePty as unknown as NodePtyModule, cap, 64, 1024, { now: () => now, probe })
  managers.push(manager)
  const ctx = { sessions: { get: (id: string) => id === 'missing' ? undefined : { header: { cwd } } }, get: () => undefined }
  return { cwd, processes, nodePty, manager, ctx, probe, setNow: (value: number) => { now = value } }
}
const posix = describe.skipIf(process.platform === 'win32')
const operationId = (timestamp = 100, suffix = 0) => `${timestamp}:00000000-0000-4000-8000-${suffix.toString(16).padStart(12, '0')}`
posix('idempotent command operations', () => {
  it('replays concurrent/response-lost requests and completed output without another spawn', async () => {
    const { ctx, manager, processes, nodePty } = setup(1)
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    const payload = { sessionId: 'one', command: 'side effect', title: 'Run', operationId: operationId() }
    const results = await Promise.all(Array.from({ length: 8 }, () => api['workspace-terminal.run'](payload)))
    expect(new Set(results.map(info => info.terminalId)).size).toBe(1)
    processes[0]!.events.emit('data', 'saved output')
    processes[0]!.events.emit('exit', { exitCode: 7 })
    expect(await api['workspace-terminal.run'](payload)).toMatchObject({ terminalId: results[0]!.terminalId, exited: true, exitCode: 7 })
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    expect(manager.readOutput(workspace, results[0]!.terminalId).data).toContain('saved output')
    expect(nodePty.spawn).toHaveBeenCalledTimes(1)
  })

  it('rejects changed command/title for a retained operation', async () => {
    const { ctx, manager, nodePty } = setup()
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    const payload = { sessionId: 'one', command: 'echo first', operationId: operationId() }
    await api['workspace-terminal.run'](payload)
    for (const change of [{ command: 'echo second' }, { title: 'different' }]) {
      await expect(api['workspace-terminal.run']({ ...payload, ...change })).rejects.toMatchObject({ code: 'conflict', status: 409 })
    }
    expect(nodePty.spawn).toHaveBeenCalledTimes(1)
  })

  it('binds identity to session and workspace, and keeps deliberate new operations independent', async () => {
    const { ctx, manager, nodePty } = setup()
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    const payload = { sessionId: 'one', command: 'pwd', operationId: operationId() }
    const first = await api['workspace-terminal.run'](payload)
    const second = await api['workspace-terminal.run']({ ...payload, sessionId: 'two' })
    const third = await api['workspace-terminal.run']({ ...payload, operationId: operationId(100, 1) })
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    const fourth = manager.run({ ...workspace, key: 'different-workspace' }, 'one', 'pwd', undefined, undefined, [], operationId())
    expect(new Set([first, second, third, fourth].map(info => info.terminalId)).size).toBe(4)
    expect(nodePty.spawn).toHaveBeenCalledTimes(4)
  })

  it('never repeats a terminated or expired operation, while retaining pinned results beyond token expiry', async () => {
    const { ctx, manager, processes, setNow, nodePty } = setup()
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    const payload = { sessionId: 'one', command: 'effect', operationId: operationId() }
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    const first = await api['workspace-terminal.run'](payload)
    manager.terminate(workspace, first.terminalId)
    await expect(api['workspace-terminal.run'](payload)).rejects.toThrow('no longer retained')
    const pinnedPayload = { ...payload, operationId: operationId(100, 1) }
    const pinned = await api['workspace-terminal.run'](pinnedPayload)
    manager.pin(workspace, pinned.terminalId, true)
    processes[1]!.events.emit('exit', { exitCode: 0 })
    setNow(11 * 60_000)
    expect((await api['workspace-terminal.run'](pinnedPayload)).terminalId).toBe(pinned.terminalId)
    await expect(api['workspace-terminal.run'](payload)).rejects.toThrow('expired')
    manager.pin(workspace, pinned.terminalId, false)
    await manager.cleanup(workspace)
    await expect(api['workspace-terminal.run'](pinnedPayload)).rejects.toThrow('expired')
    expect(nodePty.spawn).toHaveBeenCalledTimes(2)
  })

  it('bounds operation tombstones without evicting valid replay protection', async () => {
    const { ctx, manager, nodePty, setNow } = setup()
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    for (let i = 0; i < 64 * 4; i++) {
      const info = await api['workspace-terminal.run']({ sessionId: 'one', command: 'effect', operationId: operationId(100, i) })
      manager.terminate(workspace, info.terminalId)
    }
    await expect(api['workspace-terminal.run']({ sessionId: 'one', command: 'effect', operationId: operationId(100, 256) })).rejects.toThrow('operation-history-limit')
    expect(nodePty.spawn).toHaveBeenCalledTimes(256)
    setNow(11 * 60_000)
    await api['workspace-terminal.run']({ sessionId: 'one', command: 'new effect', operationId: operationId(11 * 60_000, 257) })
    expect(nodePty.spawn).toHaveBeenCalledTimes(257)
  })

  it('allows retry after a failed spawn without poisoning operation admission', async () => {
    const { ctx, manager, nodePty } = setup()
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    const payload = { sessionId: 'one', command: 'effect', operationId: operationId() }
    nodePty.spawn.mockImplementationOnce(() => { throw new Error('spawn failed') })
    await expect(api['workspace-terminal.run'](payload)).rejects.toThrow('spawn failed')
    await api['workspace-terminal.run'](payload)
    expect(nodePty.spawn).toHaveBeenCalledTimes(2)
  })
})
posix('direct workspace command execution', () => {
  it('allocates independent PTYs on every request, preserving multiline/control bytes in argv only', async () => {
    const { ctx, manager, nodePty, processes } = setup()
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    const existing = manager.create(workspace, 'one')
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    const command = "printf '%s\\n' 'hello world'\nprintf '%s' '\x03\x1b[A'\nexit 7"
    const [first, second] = await Promise.all([
      api['workspace-terminal.run']({ sessionId: 'one', command, title: 'Selected command' }),
      api['workspace-terminal.run']({ sessionId: 'one', command }),
    ])
    expect(new Set([existing.terminalId, first.terminalId, second.terminalId]).size).toBe(3)
    expect(nodePty.spawn).toHaveBeenCalledTimes(3)
    const call = nodePty.spawn.mock.calls[1] as unknown as [string, string[], { cwd: string }]
    expect(call).toEqual(['/bin/bash', ['--rcfile', expect.any(String), '-i'], expect.objectContaining({ cwd: workspace.cwd })])
    expect(readFileSync(join(call[1][1]!, '..', 'command'), 'utf8')).toBe(command)
    expect(first).toMatchObject({ title: 'Selected command', cwd: workspace.cwd, createdBySessionId: 'one', activity: 'busy' })
    for (const pty of processes) expect(pty.write).not.toHaveBeenCalled()
    expect((await manager.ensure(workspace, 'one')).terminalId).toBe(existing.terminalId)
  })

  it('retains output, terminal identity and completion details after exit for replay', async () => {
    const { ctx, manager, processes, setNow, nodePty } = setup()
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    const info = await api['workspace-terminal.run']({ sessionId: 'one', command: 'printf result; exit 7' })
    emitStart(nodePty, processes[0]!)
    processes[0]!.events.emit('data', 'result')
    expect(manager.list(workspace)[0]).toMatchObject({ activity: 'busy', activityReason: 'command-process-running' })
    setNow(250)
    processes[0]!.events.emit('exit', { exitCode: 7 })
    expect((await api['workspace-terminal.list']({ sessionId: 'one' })).terminals[0]).toMatchObject({
      terminalId: info.terminalId, exited: true, exitCode: 7, activity: 'exited',
      commandStartedAt: 100, commandFinishedAt: 250, commandExitCode: 7, commandDurationMs: 150,
    })
    expect(manager.readOutput(workspace, info.terminalId).data).toBe('result\r\n[process exited with code 7]\r\n')
    const socket = new Socket()
    manager.attach(workspace, info.terminalId, socket as never)
    expect(socket.send).toHaveBeenCalledWith('result\r\n[process exited with code 7]\r\n')
    expect(socket.close).toHaveBeenCalledWith(1000, 'terminal-exited')
    expect(processes[0]!.kill).not.toHaveBeenCalled()
  })

  it('does not acquire a running command as an interactive shell or reclaim it as idle', async () => {
    const { ctx, manager, processes, probe, setNow } = setup()
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    const command = manager.run(workspace, 'one', 'sleep 3600')
    setNow(60 * 60_000)
    expect(await manager.cleanup(workspace)).toEqual({ removed: 0 })
    expect(probe).not.toHaveBeenCalled()
    expect(processes[0]!.kill).not.toHaveBeenCalled()
    expect((await manager.ensure(workspace, 'one')).terminalId).not.toBe(command.terminalId)
  })

  it('completes initial command independently, retaining the same shell, replay and later exit metadata', async () => {
    const { ctx, manager, nodePty, processes, setNow } = setup()
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    const info = manager.run(workspace, 'one', 'printf initial; false')
    const call = nodePty.spawn.mock.calls[0] as unknown as [string, string[]]
    const token = emitStart(nodePty, processes[0]!)
    setNow(250)
    const marker = `\x1b]633;dsh;${token};end;1\x07`
    processes[0]!.events.emit('data', `initial${marker.slice(0, 15)}`)
    processes[0]!.events.emit('data', `${marker.slice(15)}prompt> `)
    expect(manager.list(workspace)[0]).toMatchObject({ exited: false, commandExitCode: 1, commandFinishedAt: 250, commandDurationMs: 150 })
    expect(manager.readOutput(workspace, info.terminalId).data).toBe('initialprompt> ')
    expect(existsSync(call[1][1]!)).toBe(false)
    expect((await manager.ensure(workspace, 'one')).terminalId).toBe(info.terminalId)
    setNow(500)
    processes[0]!.events.emit('exit', { exitCode: 0 })
    expect(manager.list(workspace)[0]).toMatchObject({ exited: true, exitCode: 0, commandExitCode: 1, commandFinishedAt: 250 })
    expect(nodePty.spawn).toHaveBeenCalledOnce()
    expect(processes[0]!.write).not.toHaveBeenCalled()
  })

  it.each([['-i'], ['-ic'], ['-c', 'other'], ['script.sh'], ['--'], ['-s'], ['-File', 'init.ps1']])('rejects ambiguous shell startup arguments %j', async (...args) => {
    const { ctx, manager, nodePty } = setup()
    const api = buildWorkspaceTerminalApi(ctx as never, manager, () => ({ shellArgs: args }))
    await expect(api['workspace-terminal.run']({ sessionId: 'one', command: 'echo safe' })).rejects.toThrow('terminal-run-unsupported')
    expect(nodePty.spawn).not.toHaveBeenCalled()
  })

  it('rejects unknown shell command semantics instead of falling back to input', async () => {
    const { ctx, manager, nodePty } = setup()
    const api = buildWorkspaceTerminalApi(ctx as never, manager, () => ({ shell: process.execPath }))
    await expect(api['workspace-terminal.run']({ sessionId: 'one', command: 'echo safe' })).rejects.toThrow('requires bash or zsh')
    expect(nodePty.spawn).not.toHaveBeenCalled()
  })

  it('accepts the exact byte boundary without trimming or rewriting command text', async () => {
    const { ctx, manager, nodePty } = setup()
    const command = ' ' + 'x'.repeat(32766) + '\n'
    await buildWorkspaceTerminalApi(ctx as never, manager)['workspace-terminal.run']({ sessionId: 'one', command })
    const call = nodePty.spawn.mock.calls[0] as unknown as [string, string[]]
    expect(readFileSync(join(call[1][1]!, '..', 'command'), 'utf8')).toBe(command)
  })

  it('does not invent command completion when startup config exits before start marker', async () => {
    const { ctx, manager, processes } = setup()
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    manager.run(workspace, 'one', 'never reached')
    processes[0]!.events.emit('exit', { exitCode: 0 })
    const info = manager.list(workspace)[0]!
    expect(info.exited).toBe(true)
    expect(info.commandStartedAt).toBeUndefined()
    expect(info.commandFinishedAt).toBeUndefined()
    expect(info.commandExitCode).toBeUndefined()
  })

  it('does not retain phantom records when native spawn fails', async () => {
    const { ctx, manager, nodePty } = setup()
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    nodePty.spawn.mockImplementationOnce(() => { throw new Error('native spawn failed') })
    await expect(buildWorkspaceTerminalApi(ctx as never, manager)['workspace-terminal.run']({ sessionId: 'one', command: 'pwd' })).rejects.toThrow('native spawn failed')
    expect(manager.list(workspace)).toEqual([])
  })

  it('enforces process quotas without reuse or injection into the existing shell', async () => {
    const { ctx, manager, processes, nodePty } = setup(1)
    const workspace = await resolveTerminalWorkspace(ctx as never, 'one')
    manager.create(workspace, 'one')
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    await expect(api['workspace-terminal.run']({ sessionId: 'one', command: 'echo safe' })).rejects.toThrow('workspace-live-limit')
    expect(nodePty.spawn).toHaveBeenCalledTimes(1)
    expect(processes[0]!.write).not.toHaveBeenCalled()
  })
})

describe('workspace run input boundary', () => {
  it.each([123, '', 'uuid-only', '100:bad', '100:00000000-0000-4000-8000-000000000000\0'])('rejects invalid operation id %#', async operationId => {
    const { ctx, manager, nodePty } = setup()
    await expect(buildWorkspaceTerminalApi(ctx as never, manager)['workspace-terminal.run']({ sessionId: 'one', command: 'pwd', operationId })).rejects.toMatchObject({ code: 'bad-request' })
    expect(nodePty.spawn).not.toHaveBeenCalled()
  })

  it('rejects old and future operations before spawn', async () => {
    const { ctx, manager, nodePty, setNow } = setup()
    setNow(20 * 60_000)
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    for (const id of [operationId(100), operationId(30 * 60_000)]) {
      await expect(api['workspace-terminal.run']({ sessionId: 'one', command: 'pwd', operationId: id })).rejects.toMatchObject({ code: 'conflict', status: 409 })
    }
    expect(nodePty.spawn).not.toHaveBeenCalled()
  })

  it.each([undefined, null, 123, '', ' \n\t', 'a\0b', 'x'.repeat(32769), '你'.repeat(10923)])('rejects invalid command case %# before spawn', async command => {
    const { ctx, manager, nodePty } = setup()
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    await expect(api['workspace-terminal.run']({ sessionId: 'one', command })).rejects.toMatchObject({ code: 'bad-request', status: 400 })
    expect(nodePty.spawn).not.toHaveBeenCalled()
  })

  it('refuses browser cwd and missing authoritative header, even with a valid supplied directory', async () => {
    const { cwd, ctx, manager, nodePty } = setup()
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    await expect(api['workspace-terminal.run']({ sessionId: 'one', command: 'pwd', cwd })).rejects.toThrow('cwd is not accepted')
    await expect(api['workspace-terminal.run']({ sessionId: 'missing', command: 'pwd' })).rejects.toThrow('authoritative')
    expect(nodePty.spawn).not.toHaveBeenCalled()
  })

  it('uses the persisted authoritative header for cold sessions and closes it', async () => {
    const { cwd, manager, nodePty } = setup()
    const close = vi.fn()
    const ctx = { sessions: { get: () => undefined }, get: (name: string) => name === 'sessionPersistence' ? { open: async () => ({ header: { cwd }, close }) } : undefined }
    const api = buildWorkspaceTerminalApi(ctx as never, manager)
    if (process.platform === 'win32') await expect(api['workspace-terminal.run']({ sessionId: 'cold', command: 'pwd' })).rejects.toThrow('not supported on Windows')
    else {
      expect((await api['workspace-terminal.run']({ sessionId: 'cold', command: 'pwd' })).cwd).toBe(cwd)
      expect(nodePty.spawn.mock.calls[0]).toEqual(['/bin/bash', ['--rcfile', expect.any(String), '-i'], expect.objectContaining({ cwd })])
    }
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([123, 'x'.repeat(257), 'bad\0title'])('rejects invalid title %#', async title => {
    const { ctx, manager, nodePty } = setup()
    await expect(buildWorkspaceTerminalApi(ctx as never, manager)['workspace-terminal.run']({ sessionId: 'one', command: 'pwd', title })).rejects.toMatchObject({ code: 'bad-request' })
    expect(nodePty.spawn).not.toHaveBeenCalled()
  })

  it('surfaces missing native dependencies without another execution backend', async () => {
    const { ctx } = setup()
    await expect(buildWorkspaceTerminalApi(ctx as never, null)['workspace-terminal.run']({ sessionId: 'one', command: 'pwd' })).rejects.toMatchObject({ status: 503, message: 'pty-deps-missing' })
  })

  it('explicitly rejects Windows cmd/PowerShell command semantics without spawn or write', async () => {
    const { ctx, manager, nodePty } = setup()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    for (const shell of ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe']) {
      await expect(buildWorkspaceTerminalApi(ctx as never, manager, () => ({ shell }))['workspace-terminal.run']({ sessionId: 'one', command: 'echo "hello"\necho done' })).rejects.toThrow('not supported on Windows')
    }
    expect(nodePty.spawn).not.toHaveBeenCalled()
  })
})
