/**
 * Terminal command-title tests: the host's input digest (first token of the
 * last settled command line becomes the tab title, VSCode-style) and the
 * client's downlink frame parser (title updates ride a control frame).
 */
import { describe, expect, it } from 'vitest'
import { digestCommandInput } from '../src/pty-manager.ts'
import { parseDownlinkFrame } from '../src/client/TerminalView.tsx'

describe('digestCommandInput (host-side command title)', () => {
  it('settles the FIRST token of a command on Enter', () => {
    expect(digestCommandInput({ title: '', line: '' }, 'npm run dev\r'))
      .toEqual({ title: 'npm', line: '' })
    expect(digestCommandInput({ title: '', line: '' }, 'git log --oneline\r'))
      .toEqual({ title: 'git', line: '' })
  })

  it('accumulates across chunks (keystrokes arrive one at a time)', () => {
    let state = { title: '', line: '' }
    state = digestCommandInput(state, 'np')
    expect(state).toEqual({ title: '', line: 'np' })
    state = digestCommandInput(state, 'm')
    expect(state).toEqual({ title: '', line: 'npm' })
    state = digestCommandInput(state, ' run\r')
    expect(state).toEqual({ title: 'npm', line: '' })
  })

  it('honors backspace edits', () => {
    let state = { title: '', line: '' }
    state = digestCommandInput(state, 'vi\x7f') // v, i, backspace → v
    expect(state.line).toBe('v')
    state = digestCommandInput(state, 'im\r')
    expect(state).toEqual({ title: 'vim', line: '' })
  })

  it('skips ANSI control sequences (arrows never pollute the line)', () => {
    let state = { title: '', line: '' }
    // Up arrow + left-arrow-with-params + a lone trailing ESC in the chunk.
    state = digestCommandInput(state, '\x1b[A\x1b[1;5D')
    expect(state).toEqual({ title: '', line: '' })
    state = digestCommandInput(state, 'ls\r')
    expect(state.title).toBe('ls')
  })

  it('a bare Enter keeps the previous title', () => {
    const settled = digestCommandInput({ title: 'ls', line: '' }, '\r')
    expect(settled).toEqual({ title: 'ls', line: '' })
  })

  it('a multi-line paste settles line by line — the LAST line wins', () => {
    expect(digestCommandInput({ title: '', line: '' }, 'echo a\rcd /tmp\r'))
      .toEqual({ title: 'cd', line: '' })
  })

  it('strips C0 controls before tokenizing', () => {
    expect(digestCommandInput({ title: '', line: '' }, 'ls\x00\r')).toEqual({ title: 'ls', line: '' })
    expect(digestCommandInput({ title: '', line: '' }, '  \x1b[K\r')).toEqual({ title: '', line: '' })
  })

  it('CRLF settles once (the second newline is an empty line)', () => {
    expect(digestCommandInput({ title: '', line: '' }, 'ls\r\n')).toEqual({ title: 'ls', line: '' })
  })
})

describe('parseDownlinkFrame (client-side title frames)', () => {
  it('parses a title frame', () => {
    expect(parseDownlinkFrame('{"type":"title","title":"npm"}'))
      .toEqual({ type: 'title', title: 'npm' })
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
