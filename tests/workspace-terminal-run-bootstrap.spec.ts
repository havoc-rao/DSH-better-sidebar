/** Real interactive shells run exact startup code once, then accept input in the same process.
 * No native PTY dependency is needed: interactive shells also work over piped stdin. */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareTerminalRun, type TerminalRunBootstrap } from '../src/workspace-terminal-run.ts'
import { ZshMarkerParser } from '../src/zsh-integration.ts'

const bootstraps: TerminalRunBootstrap[] = []
const homes: string[] = []
afterEach(() => {
  bootstraps.splice(0).forEach(bootstrap => bootstrap.dispose())
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function prepare(shell: string, command: string) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-run-test-')); homes.push(home)
  writeFileSync(join(home, '.bashrc'), 'export RC_CHAINED=bash\n')
  writeFileSync(join(home, '.zshenv'), 'export ENV_CHAINED=yes\n')
  writeFileSync(join(home, '.zshrc'), 'export RC_CHAINED=zsh\n')
  const bootstrap = prepareTerminalRun(shell, [], command, { ...process.env, HOME: home, ZDOTDIR: home })
  bootstraps.push(bootstrap)
  return bootstrap
}
describe.skipIf(process.platform === 'win32')('interactive Run bootstrap', () => {
  for (const shell of ['/bin/bash', '/bin/zsh'].filter(existsSync)) {
    it(`${shell} preserves startup state, heredocs, output and process identity after completion`, async () => {
      const bootstrap = prepare(shell, "export RUN_STATE=kept\nprintf 'FIRST_PID=%s\\n' $$\ncat <<'END'\nheredoc 'quote' ; $not_expanded\nEND\nfalse")
      const parser = new ZshMarkerParser(bootstrap.token)
      const child = spawn(shell, bootstrap.args, { env: bootstrap.env })
      let output = '', raw = '', sent = false
      const exited = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })
      child.stdout.on('data', (data: Buffer) => {
        raw += data.toString()
        parser.feed(data.toString(), text => { output += text }, (kind, code) => {
          if (kind !== 'end' || sent) return
          expect(code).toBe(1)
          sent = true
          child.stdin.end("printf 'SECOND_PID=%s STATE=%s RC=%s ENV=%s\\n' $$ \"$RUN_STATE\" \"$RC_CHAINED\" \"$ENV_CHAINED\"\nexit 0\n")
        })
      })
      // If startup never completes, kill rather than hanging the test runner.
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000)
      try {
        expect(await exited).toBe(0)
        expect(sent).toBe(true)
        expect(output).toContain("heredoc 'quote' ; $not_expanded")
        const first = /FIRST_PID=(\d+)/.exec(output)![1]
        expect(output).toContain(`SECOND_PID=${first} STATE=kept RC=${shell.endsWith('zsh') ? 'zsh ENV=yes' : 'bash ENV='}`)
        expect(output.match(/FIRST_PID=/g)).toHaveLength(1)
        expect(raw).not.toContain('builtin source')
        expect(output).not.toContain('633;dsh;')
      } finally { clearTimeout(timer); child.kill() }
    }, 6000)

    it.each([['kill -INT $$', 130], ['exec >/dev/null; false', 1]])(`${shell} completes interrupted or redirected startup %s`, async (command, expected) => {
      const bootstrap = prepare(shell, command as string)
      const child = spawn(shell, bootstrap.args, { env: bootstrap.env })
      const parser = new ZshMarkerParser(bootstrap.token)
      let completion: number | undefined, output = ''
      child.stderr.on('data', data => { output += data.toString() })
      child.stdout.on('data', data => parser.feed(data.toString(), () => {}, (kind, code) => {
        if (kind !== 'end') return
        completion = code
        child.stdin.end("printf 'SAME_SHELL_ALIVE:%s\\n' $$ >&2\nexit 0\n")
      }))
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      try {
        const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
        expect(code).toBe(0)
        // macOS bash 3.2 reports 128 for interrupted rc input; zsh reports 130.
        if (command === 'kill -INT $$' && shell.endsWith('bash')) expect([128, 130]).toContain(completion)
        else expect(completion).toBe(expected)
        expect(output).toContain(`SAME_SHELL_ALIVE:${child.pid}`)
      } finally { clearTimeout(timer); child.kill() }
    }, 5000)

    it(`${shell} invokes the first original prompt callback with the command status`, async () => {
      const bootstrap = prepare(shell, 'false')
      const home = bootstrap.env.HOME!
      writeFileSync(join(home, shell.endsWith('bash') ? '.bashrc' : '.zshrc'), shell.endsWith('bash')
        ? `PROMPT_COMMAND='printf "USER_PROMPT:%s\\n" "$?" >&2'\n`
        : `precmd() { printf 'USER_PROMPT:%s\\n' "$?" >&2; }\nprecmd_functions+=(user_extra)\nuser_extra() { printf 'EXTRA_HOOK\\n' >&2; }\n`)
      const child = spawn(shell, bootstrap.args, { env: bootstrap.env })
      child.stdin.end('exit 0\n')
      let output = ''
      child.stderr.on('data', data => { output += data.toString() })
      await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', () => resolve()) })
      expect(output).toContain('USER_PROMPT:1')
      if (shell.endsWith('zsh')) expect(output).toContain('EXTRA_HOOK')
    })

    it(`${shell} respects explicit command exit without creating a successor`, async () => {
      const bootstrap = prepare(shell, 'printf closing; exit 7')
      const child = spawn(shell, bootstrap.args, { env: bootstrap.env })
      child.stdin.end()
      let output = ''
      child.stdout.on('data', data => { output += data.toString() })
      const exitCode = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
      expect(exitCode).toBe(7)
      expect(output).toContain('closing')
      expect(output).not.toContain(';end;')
      bootstrap.dispose()
      expect(existsSync(bootstrap.directory)).toBe(false)
    })
  }
  it.skipIf(!existsSync('/bin/zsh'))('preserves zsh NO_RCS while still executing initial command', async () => {
    const bootstrap = prepare('/bin/zsh', `printf 'RCS=%s RC=%s\\n' "$options[rcs]" "$RC_CHAINED"`)
    writeFileSync(join(bootstrap.env.HOME!, '.zshenv'), 'unsetopt rcs\n')
    const child = spawn('/bin/zsh', bootstrap.args, { env: bootstrap.env })
    child.stdin.end('exit 0\n')
    let output = ''
    child.stdout.on('data', data => { output += data.toString() })
    await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', () => resolve()) })
    expect(output).toContain('RCS=off RC=')
    expect(output).not.toContain('RC=zsh')
  })

  it('keeps command bytes outside argv and rc source, refusing ambiguous startup modes', () => {
    const command = "printf '%s' 'opaque';\n# exact bytes\n"
    const bootstrap = prepare('/bin/bash', command)
    expect(readFileSync(join(bootstrap.directory, 'command'), 'utf8')).toBe(command)
    expect(readFileSync(join(bootstrap.directory, 'bashrc'), 'utf8')).not.toContain(command)
    expect(bootstrap.args).not.toContain(command)
    for (const shell of ['/bin/sh', '/bin/fish', '/bin/dash']) expect(() => prepareTerminalRun(shell, [], 'true')).toThrow('terminal-run-unsupported')
    for (const args of [['-l'], ['--norc'], ['-f'], ['-i']]) expect(() => prepareTerminalRun('/bin/zsh', args, 'true')).toThrow('terminal-run-unsupported')
  })
})
