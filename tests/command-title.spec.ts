/**
 * Terminal command-title tests: the host's input digest (first token of the
 * last settled command line becomes the tab title, VSCode-style; the FULL
 * settled line becomes `lastCommand` for the info bar's "running CLI") and
 * the client's downlink frame parser (title/command/cwd ride a control
 * frame).
 */
import { describe, expect, it } from 'vitest'
import { digestCommandInput } from '../src/pty-manager.ts'
import { parseDownlinkFrame } from '../src/client/TerminalView.tsx'

/** The digest state's initial shape. */
const initial = { title: '', line: '', lastCommand: '' }

describe('digestCommandInput (host-side command title)', () => {
  it('settles the FIRST token on Enter and keeps the FULL command', () => {
    expect(digestCommandInput(initial, 'npm run dev\r'))
      .toEqual({ title: 'npm', line: '', lastCommand: 'npm run dev' })
    expect(digestCommandInput(initial, 'git log --oneline\r'))
      .toEqual({ title: 'git', line: '', lastCommand: 'git log --oneline' })
  })

  it('accumulates across chunks (keystrokes arrive one at a time)', () => {
    let state = { ...initial }
    state = digestCommandInput(state, 'np')
    expect(state).toEqual({ title: '', line: 'np', lastCommand: '' })
    state = digestCommandInput(state, 'm')
    expect(state).toEqual({ title: '', line: 'npm', lastCommand: '' })
    state = digestCommandInput(state, ' run\r')
    expect(state).toEqual({ title: 'npm', line: '', lastCommand: 'npm run' })
  })

  it('honors backspace edits', () => {
    let state = { ...initial }
    state = digestCommandInput(state, 'vi\x7f') // v, i, backspace → v
    expect(state.line).toBe('v')
    state = digestCommandInput(state, 'im\r')
    expect(state).toEqual({ title: 'vim', line: '', lastCommand: 'vim' })
  })

  it('skips ANSI control sequences (arrows never pollute the line)', () => {
    let state = { ...initial }
    // Up arrow + left-arrow-with-params + a lone trailing ESC in the chunk.
    state = digestCommandInput(state, '\x1b[A\x1b[1;5D')
    expect(state).toEqual({ title: '', line: '', lastCommand: '' })
    state = digestCommandInput(state, 'ls\r')
    expect(state.title).toBe('ls')
    expect(state.lastCommand).toBe('ls')
  })

  it('a bare Enter keeps the previous title AND command', () => {
    const settled = digestCommandInput({ title: 'ls', line: '', lastCommand: 'ls -la' }, '\r')
    expect(settled).toEqual({ title: 'ls', line: '', lastCommand: 'ls -la' })
  })

  it('a multi-line paste settles line by line — the LAST line wins', () => {
    expect(digestCommandInput(initial, 'echo a\rcd /tmp\r'))
      .toEqual({ title: 'cd', line: '', lastCommand: 'cd /tmp' })
  })

  it('strips C0 controls before tokenizing', () => {
    expect(digestCommandInput(initial, 'ls\x00\r')).toEqual({ title: 'ls', line: '', lastCommand: 'ls' })
    expect(digestCommandInput(initial, '  \x1b[K\r')).toEqual({ title: '', line: '', lastCommand: '' })
  })

  it('CRLF settles once (the second newline is an empty line)', () => {
    expect(digestCommandInput(initial, 'ls\r\n')).toEqual({ title: 'ls', line: '', lastCommand: 'ls' })
  })
})

describe('parseDownlinkFrame (client-side title frames)', () => {
  it('parses a title frame', () => {
    expect(parseDownlinkFrame('{"type":"title","title":"npm"}'))
      .toEqual({ type: 'title', title: 'npm' })
  })

  it('parses the info-bar extras (command + cwd)', () => {
    expect(parseDownlinkFrame('{"type":"title","title":"npm","command":"npm run dev","cwd":"/ws/code-agent-link"}'))
      .toEqual({ type: 'title', title: 'npm', command: 'npm run dev', cwd: '/ws/code-agent-link' })
  })

  it('returns null for plain terminal data (not JSON)', () => {
    expect(parseDownlinkFrame('npm run dev\r\n')).toBeNull()
    expect(parseDownlinkFrame('')).toBeNull()
  })

  it('returns null for unknown control types and malformed payloads', () => {
    expect(parseDownlinkFrame('{"type":"resize","cols":80}')).toBeNull()
    expect(parseDownlinkFrame('{"type":"title"}')).toBeNull()
    expect(parseDownlinkFrame('{"type":"title","title":5}')).toBeNull()
  })

  it('refuses oversized blobs (a program output chunk must not be parsed)', () => {
    expect(parseDownlinkFrame(`{"type":"title","title":"${'x'.repeat(600)}"}`)).toBeNull()
  })
})
