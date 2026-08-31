/**
 * Built-in shell-preset data tests: registry integrity (unique ids, non-empty
 * titles, pure strip/left/detect functions) and the anywhere-labs DSH Desktop
 * entry's strip values (darwin advanced 20px, win32 advanced 32px as the
 * no-WCO fallback, compatibility/plain browser nothing) plus the IDE-mode
 * left reservation (darwin advanced 90px traffic-light zone).
 */
import { describe, expect, it } from 'vitest'
import { getShellPreset, getShellPresets, presetLeftFor, presetStripFor } from '../src/client/shell-presets.ts'
import type { DesktopEnv } from '../src/client/desktop-env.ts'

const env = (partial: Partial<DesktopEnv>): DesktopEnv => ({
  desktop: false,
  mode: null,
  platform: null,
  titlebarInset: 0,
  ...partial,
})

describe('shell presets', () => {
  it('keeps the registry well-formed (unique ids, titles, pure strip/left functions)', () => {
    const presets = getShellPresets()
    expect(presets.length).toBeGreaterThan(0)
    const ids = new Set<string>()
    for (const preset of presets) {
      expect(ids.has(preset.id)).toBe(false)
      ids.add(preset.id)
      expect(preset.title.length).toBeGreaterThan(0)
      expect(preset.desc.length).toBeGreaterThan(0)
      // The strip/left functions must be total — an unknown environment
      // yields undefined, never a throw.
      const plain = env({ desktop: false, mode: null, platform: null })
      expect(() => presetStripFor(preset, plain)).not.toThrow()
      expect(() => presetLeftFor(preset, plain)).not.toThrow()
      expect(() => preset.detect?.(plain)).not.toThrow()
    }
  })

  it('looks up presets by id; unknown/empty ids resolve to undefined', () => {
    expect(getShellPreset('dsh-desktop')).toBeDefined()
    expect(getShellPreset('')).toBeUndefined()
    expect(getShellPreset('no-such-shell')).toBeUndefined()
  })

  describe('dsh-desktop (DeepSeek Harness Desktop, anywhere-labs)', () => {
    const preset = getShellPreset('dsh-desktop')!

    it('reserves 20px on darwin advanced (the caption row above the surfaces)', () => {
      expect(presetStripFor(preset, env({ desktop: true, mode: 'advanced', platform: 'darwin' }))).toBe(20)
    })

    it('reserves 32px on win32 advanced as the no-WCO fallback', () => {
      expect(presetStripFor(preset, env({ desktop: true, mode: 'advanced', platform: 'win32' }))).toBe(32)
    })

    it('reserves 90px on darwin advanced (the IDE-fullscreen traffic-light zone)', () => {
      expect(presetLeftFor(preset, env({ desktop: true, mode: 'advanced', platform: 'darwin' }))).toBe(90)
    })

    it('reserves no left inset on win32 / compatibility / unknown environments', () => {
      expect(presetLeftFor(preset, env({ desktop: true, mode: 'advanced', platform: 'win32' }))).toBeUndefined()
      expect(presetLeftFor(preset, env({ desktop: true, mode: 'compatibility', platform: 'darwin' }))).toBeUndefined()
      expect(presetLeftFor(preset, env({ desktop: true, mode: 'advanced', platform: 'linux' }))).toBeUndefined()
      expect(presetLeftFor(preset, env({ desktop: false, mode: null, platform: null }))).toBeUndefined()
    })

    it('reserves nothing in compatibility mode or on unknown platforms', () => {
      expect(presetStripFor(preset, env({ desktop: true, mode: 'compatibility', platform: 'win32' }))).toBeUndefined()
      expect(presetStripFor(preset, env({ desktop: true, mode: 'advanced', platform: 'linux' }))).toBeUndefined()
      expect(presetStripFor(preset, env({ desktop: false, mode: null, platform: null }))).toBeUndefined()
    })

    it('detects advanced shells only as a SUGGESTION signal (never auto-applies)', () => {
      expect(preset.detect?.(env({ desktop: true, mode: 'advanced', platform: 'darwin' }))).toBe(true)
      expect(preset.detect?.(env({ desktop: true, mode: 'advanced', platform: 'win32' }))).toBe(true)
      expect(preset.detect?.(env({ desktop: true, mode: 'compatibility', platform: 'win32' }))).toBe(false)
      expect(preset.detect?.(env({ desktop: false, mode: null, platform: null }))).toBe(false)
    })
  })
})
