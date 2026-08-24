/**
 * generatePalette tests: the LAB-interpolated extended 256-color palette
 * (ported from tabby-terminal's generatePalette, MIT). Golden values pin the
 * exact interpolation output for the app's curated dark/light ANSI palettes
 * so a porting or algorithm regression is caught; structural tests cover
 * length, format, user-color preservation and the light-theme inversion.
 */
import { describe, expect, it } from 'vitest'
import { generatePalette } from '../src/client/generate-palette.ts'

/** The terminal's curated ANSI palettes (mirror of TerminalView). */
const ANSI_DARK: Record<string, string> = {
  black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
  brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
  brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
  brightCyan: '#56b6c2', brightWhite: '#ffffff',
}

const ANSI_LIGHT: Record<string, string> = {
  black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
  blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#a0a1a7',
  brightBlack: '#4f525e', brightRed: '#e45649', brightGreen: '#50a14f',
  brightYellow: '#c18401', brightBlue: '#0184bc', brightMagenta: '#a626a4',
  brightCyan: '#0997b3', brightWhite: '#fafafa',
}

const HEX = /^#[0-9a-f]{6}$/

describe('generatePalette', () => {
  it('emits 240 hex colors for indices 16–255', () => {
    const dark = generatePalette(Object.values(ANSI_DARK), '#111114', '#e6e6e6', false)
    const light = generatePalette(Object.values(ANSI_LIGHT), '#ffffff', '#1a1a1a', false)
    expect(dark).toHaveLength(240)
    expect(light).toHaveLength(240)
    for (const color of [...dark, ...light]) expect(color).toMatch(HEX)
  })

  it('is deterministic', () => {
    const a = generatePalette(Object.values(ANSI_DARK), '#111114', '#e6e6e6', false)
    const b = generatePalette(Object.values(ANSI_DARK), '#111114', '#e6e6e6', false)
    expect(a).toEqual(b)
  })

  it('dark theme interpolates from the background up to the foreground (golden)', () => {
    const p = generatePalette(Object.values(ANSI_DARK), '#111114', '#e6e6e6', false)
    expect(p[0]).toBe('#111114')    // cube corner 0 = bg
    expect(p[15]).toBe('#5a8a98')   // a mid-cube blend
    expect(p[215]).toBe('#e6e6e6')  // cube corner 7 = fg
    expect(p[216]).toBe('#18191b')  // grayscale ramp resumes from bg…
    expect(p[239]).toBe('#dcdcdc')  // …toward fg
  })

  it('light theme inverts the ramp corners by default (golden)', () => {
    const p = generatePalette(Object.values(ANSI_LIGHT), '#ffffff', '#1a1a1a', false)
    expect(p[0]).toBe('#1a1a1a')    // inverted: starts at fg
    expect(p[15]).toBe('#33717f')
    expect(p[216]).toBe('#212121')
    expect(p[239]).toBe('#f5f5f5')  // ends at bg
  })

  it('harmonious disables the light-theme inversion', () => {
    const p = generatePalette(Object.values(ANSI_LIGHT), '#ffffff', '#1a1a1a', true)
    expect(p[0]).toBe('#ffffff')    // literal bg corner
    expect(p[239]).toBe('#212121')  // toward fg
  })

  it('preserves user-defined colors beyond index 15 verbatim', () => {
    const custom = [...Object.values(ANSI_DARK), '#111111', '#222222', '#333333']
    const p = generatePalette(custom, '#111114', '#e6e6e6', false)
    expect(p[0]).toBe('#111111')
    expect(p[1]).toBe('#222222')
    expect(p[2]).toBe('#333333')
    // The remaining 237 entries are still interpolated.
    expect(p[3]).toMatch(HEX)
    expect(p).toHaveLength(240)
  })
})
