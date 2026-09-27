/**
 * Sidebar WebSocket URL resolution: the desktop shell (`dsh-app://app`)
 * publishes its physical loopback host through `__DSH_TRANSPORT__.
 * streamBaseUrl`, and socket upgrades must target that host — the page's
 * custom-scheme origin has no WebSocket carrier. A page without the global
 * (plain browser, official shells) keeps the document origin; the protocol
 * swap mirrors the app's own downlink construction.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import './browser-globals.ts'
import { sidebarWsUrl } from '../src/client/ws-url.ts'

interface TransportGlobal {
  __DSH_TRANSPORT__?: { streamBaseUrl?: string }
}

function setOrigin(origin: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { origin, search: '' },
  })
}

beforeEach(() => {
  setOrigin('http://127.0.0.1:3080')
  const g = globalThis as TransportGlobal
  delete g.__DSH_TRANSPORT__
})

describe('sidebarWsUrl', () => {
  it('keeps the document origin and swaps to ws:', () => {
    const url = sidebarWsUrl('/sidebar/ws/agent-opens')
    expect(url.href).toBe('ws://127.0.0.1:3080/sidebar/ws/agent-opens')
  })

  it('resolves onto the physical host when the desktop shell publishes streamBaseUrl', () => {
    const g = globalThis as TransportGlobal
    g.__DSH_TRANSPORT__ = { streamBaseUrl: 'http://127.0.0.1:45781' }
    const url = sidebarWsUrl('/sidebar/ws/fs-watch')
    expect(url.href).toBe('ws://127.0.0.1:45781/sidebar/ws/fs-watch')
  })

  it('keeps https→wss when the page is served over https', () => {
    setOrigin('https://harness.example:8443')
    const url = sidebarWsUrl('/sidebar/ws/terminal')
    expect(url.href).toBe('wss://harness.example:8443/sidebar/ws/terminal')
  })
})