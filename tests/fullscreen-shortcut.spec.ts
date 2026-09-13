/**
 * The bottom-workbench fullscreen-toggle shortcut (v0.20.x):
 *
 * 1. `isFullscreenToggleShortcut()` — the chord is Cmd+Shift+J on macOS and
 *    Ctrl+Shift+J on Windows/Linux (no Alt, no cross-modifier); the bare key
 *    matches case-insensitively ('J' is what Shift produces). The platform
 *    argument is injectable so the matrix is pinned regardless of the host
 *    OS; callers (Sidebar.tsx) rely on the real-platform default.
 * 2. `isMacPlatform()` — the desktop shell's `dsh-desktop-platform` stamp
 *    wins when present; plain browsers fall back to `navigator.platform`,
 *    then the user agent.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import './browser-globals.ts'
import { parseDesktopEnv, resetDesktopEnvForTests } from '../src/client/desktop-env.ts'
import {
  FULLSCREEN_TOGGLE_KEY,
  isFullscreenToggleShortcut,
  isMacPlatform,
  type FullscreenToggleKeyEvent,
} from '../src/client/fullscreen-shortcut.ts'

function chord(overrides: Partial<FullscreenToggleKeyEvent> = {}): FullscreenToggleKeyEvent {
  return { key: FULLSCREEN_TOGGLE_KEY, metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, ...overrides }
}

function setSearch(search: string): void {
  ;(window.location as { search: string }).search = search
}

beforeEach(() => {
  resetDesktopEnvForTests()
  delete (window as unknown as Record<string, unknown>).__DSH_DESKTOP_FILE_PATH__
  setSearch('/')
})

describe('isFullscreenToggleShortcut', () => {
  it('matches Cmd+Shift+J on macOS (case-insensitive)', () => {
    expect(isFullscreenToggleShortcut(chord({ key: 'j', metaKey: true }), true)).toBe(true)
    expect(isFullscreenToggleShortcut(chord({ key: 'J', metaKey: true }), true)).toBe(true)
  })

  it('rejects non-Cmd modifiers on macOS', () => {
    expect(isFullscreenToggleShortcut(chord({ ctrlKey: true }), true)).toBe(false)
    expect(isFullscreenToggleShortcut(chord({ metaKey: true, ctrlKey: true }), true)).toBe(false)
    expect(isFullscreenToggleShortcut(chord({ metaKey: true, altKey: true }), true)).toBe(false)
    expect(isFullscreenToggleShortcut(chord({ metaKey: true, shiftKey: false }), true)).toBe(false)
  })

  it('matches Ctrl+Shift+J on Windows/Linux', () => {
    expect(isFullscreenToggleShortcut(chord({ key: 'j', ctrlKey: true }), false)).toBe(true)
    expect(isFullscreenToggleShortcut(chord({ key: 'J', ctrlKey: true }), false)).toBe(true)
  })

  it('rejects Cmd and Alt variants on Windows/Linux', () => {
    expect(isFullscreenToggleShortcut(chord({ metaKey: true }), false)).toBe(false)
    expect(isFullscreenToggleShortcut(chord({ ctrlKey: true, metaKey: true }), false)).toBe(false)
    expect(isFullscreenToggleShortcut(chord({ ctrlKey: true, altKey: true }), false)).toBe(false)
    expect(isFullscreenToggleShortcut(chord({ ctrlKey: true, shiftKey: false }), false)).toBe(false)
  })

  it('rejects other keys and plain presses regardless of platform', () => {
    for (const isMac of [true, false]) {
      expect(isFullscreenToggleShortcut(chord({ key: 'k', metaKey: true }), isMac)).toBe(false)
      expect(isFullscreenToggleShortcut(chord({ key: 'k', ctrlKey: true }), isMac)).toBe(false)
      expect(isFullscreenToggleShortcut(chord({ key: 'j' }), isMac)).toBe(false)
      expect(isFullscreenToggleShortcut(chord({ key: 'J' }), isMac)).toBe(false)
    }
  })
})

describe('isMacPlatform', () => {
  it('trusts the desktop shell stamp', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin')
    expect(parseDesktopEnv().desktop).toBe(true)
    expect(isMacPlatform()).toBe(true)
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=win32')
    resetDesktopEnvForTests()
    expect(isMacPlatform()).toBe(false)
  })

  it('falls back to navigator.platform in plain browsers', () => {
    expect(parseDesktopEnv().desktop).toBe(false)
    const original = navigator.platform
    try {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
      expect(isMacPlatform()).toBe(true)
      Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true })
      expect(isMacPlatform()).toBe(false)
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
      expect(isMacPlatform()).toBe(false)
    } finally {
      Object.defineProperty(navigator, 'platform', { value: original, configurable: true })
    }
  })

  it('falls back to the user agent when navigator.platform is empty', () => {
    const original = navigator.platform
    const originalUa = navigator.userAgent
    try {
      Object.defineProperty(navigator, 'platform', { value: '', configurable: true })
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        configurable: true,
      })
      expect(isMacPlatform()).toBe(true)
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        configurable: true,
      })
      expect(isMacPlatform()).toBe(false)
    } finally {
      Object.defineProperty(navigator, 'platform', { value: original, configurable: true })
      Object.defineProperty(navigator, 'userAgent', { value: originalUa, configurable: true })
    }
  })
})