import { expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { prepareZshIntegration, ZshMarkerParser } from '../src/zsh-integration.ts'

it('consumes only exact per-shell markers across arbitrary chunks and bounds incomplete data', () => {
  const parser = new ZshMarkerParser('abc'), output: string[] = [], markers: string[] = []
  const text = 'before\x1b]633;dsh;abc;prompt\x07after\x1b]633;dsh;wrong;prompt\x07'
  for (const char of text) parser.feed(char, value => output.push(value), kind => markers.push(kind))
  expect(markers).toEqual(['prompt'])
  expect(output.join('')).toBe('beforeafter\x1b]633;dsh;wrong;prompt\x07')
  parser.feed('\x1b]633;dsh;abc;' + 'x'.repeat(10000), value => output.push(value), kind => markers.push(kind))
  expect(output.join('').length).toBeGreaterThan(10000)
})

it('parses split command-end status and preserves malformed or unbounded markers as output', () => {
  for (const code of [0, 1, 127, 255]) {
    const wire = `\x1b]633;dsh;abc;end;${code}\x07`
    for (let split = 0; split <= wire.length; split++) {
      const parser = new ZshMarkerParser('abc'), output: string[] = [], events: unknown[] = []
      const feed = (text: string) => parser.feed(text, value => output.push(value), (kind, exitCode) => events.push([kind, exitCode]))
      feed(wire.slice(0, split)); feed(wire.slice(split))
      expect(events).toEqual([['end', code]])
      expect(output.join('')).toBe('')
    }
  }
  for (const code of ['-1', '256', 'NaN', '1.2', '', '1234', '9'.repeat(10000)]) {
    const parser = new ZshMarkerParser('abc'), output: string[] = [], marker = () => { throw new Error('malformed marker consumed') }
    const wire = `\x1b]633;dsh;abc;end;${code}\x07`
    for (const char of wire) parser.feed(char, value => output.push(value), marker)
    expect(output.join('')).toBe(wire)
  }
})

const require = createRequire(import.meta.url)
let pty: typeof import('node-pty') | undefined
try { pty = require('node-pty') } catch { /* optional native runtime */ }
it.skipIf(!existsSync('/bin/zsh') || !['darwin', 'linux'].includes(process.platform))('generated zsh wrappers are syntactically valid and preserve one-shot ZLE guards', () => {
  const integration = prepareZshIntegration('/bin/zsh', [])!
  try {
    execFileSync('/bin/zsh', ['-n', join(integration.directory, '.zshenv')])
    execFileSync('/bin/zsh', ['-n', join(integration.directory, '.zshrc')])
    const script = readFileSync(join(integration.directory, '.zshrc'), 'utf8')
    expect(script).toContain('$CONTEXT == start')
    expect(script).toContain('TRAP*')
    expect(script).toContain('zle -F -L')
    expect(script).toMatch(/_precmd\(\) \{\n  local _dsh_[a-f0-9]+_exit=\$\?\n/)
    expect(script).toContain(';end;%s')
    expect(script).toMatch(/if \(\( _dsh_[a-f0-9]+_running \)\); then/)
  } finally { integration.dispose() }
})
const supported = ['darwin', 'linux'].includes(process.platform) && existsSync('/bin/zsh') && !!pty
it.skipIf(!supported)('real zsh preserves user rc/hooks, emits ZLE prompt proof, and never emits prompt inside read', async context => {
  // Capability probe is separate from integration behavior: native modules can load but fail to spawn.
  try {
    const probe = pty!.spawn('/bin/zsh', ['-f', '-c', 'exit'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: tmpdir(), env: process.env as Record<string, string> })
    probe.kill()
  } catch (error) { context.skip(`native PTY spawn unavailable: ${String(error)}`); return }
  const home = mkdtempSync(join(tmpdir(), 'dsh-zsh-test-'))
  writeFileSync(join(home, '.zshenv'), 'export DSH_RC_ENV=preserved\n')
  writeFileSync(join(home, '.zshrc'), `PROMPT='fixture> '\nRPROMPT=''\nprint -r -- USER_RC\n`)
  const integration = prepareZshIntegration('/bin/zsh', [], { ...process.env, HOME: home, ZDOTDIR: home })!
  const parser = new ZshMarkerParser(integration.token)
  let output = '', prompts = 0, starts = 0
  const ends: number[] = []
  const terminal = pty!.spawn('/bin/zsh', ['-i'], { cwd: home, env: integration.env as Record<string, string>, cols: 80, rows: 24, name: 'xterm-256color' })
  const disposable = terminal.onData(data => parser.feed(data, value => { output += value }, (kind, code) => { if (kind === 'prompt') prompts++; else if (kind === 'start') starts++; else if (kind === 'end') ends.push(code!) }))
  const until = async (condition: () => boolean) => {
    const end = Date.now() + 5000
    while (!condition()) { if (Date.now() > end) throw new Error(`zsh timeout: ${JSON.stringify(output)}`); await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  try {
    await until(() => prompts >= 1)
    expect(output).toContain('USER_RC')
    expect(ends).toEqual([]) // startup prompt is not a command completion
    const initial = prompts
    terminal.write('\r')
    await until(() => prompts > initial)
    expect(starts).toBe(0); expect(ends).toEqual([])
    terminal.write('false\r')
    await until(() => ends.length === 1)
    expect(ends).toEqual([1])
    await until(() => prompts > initial + 1)
    terminal.write('true\r')
    await until(() => ends.length === 2 && prompts > initial + 2)
    expect(ends).toEqual([1, 0])
    const before = prompts
    terminal.write("read 'answer?READ_WAIT> '; print -r -- READ_DONE:$answer:$DSH_RC_ENV\r")
    await until(() => output.includes('READ_WAIT> ') && starts > 0)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(prompts).toBe(before)
    terminal.write('hello\r')
    await until(() => prompts > before && output.includes('READ_DONE:hello:preserved'))
    expect(output).not.toContain(integration.token)
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toContain("PROMPT='fixture> '")
  } finally {
    disposable.dispose(); terminal.kill(); integration.dispose()
    expect(existsSync(integration.directory)).toBe(false)
    rmSync(home, { recursive: true, force: true })
  }
})
