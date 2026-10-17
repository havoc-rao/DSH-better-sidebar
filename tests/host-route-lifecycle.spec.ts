import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { once } from 'node:events'
import WebSocket from 'ws'
import * as sidebar from '../src/index.ts'
import { isTrustedApiRequest, sidebarTrustedHosts } from '../src/trust-fence.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

describe('Host trust provider and route lifecycle', () => {
  it('reads both generations of trust providers live and excludes wildcard binds', () => {
    const services: Record<string, unknown> = { webRuntime: { trustedHosts: ['old.internal'] } }
    const ctx = { get: (key: string) => services[key] }
    expect(sidebarTrustedHosts(ctx)).toEqual(['old.internal'])
    services.webStartup = { trustedHosts: ['new.internal:443'] }
    services.webServer = { host: '::' }
    expect(sidebarTrustedHosts(ctx)).toEqual(['new.internal:443'])
    services.webServer = { host: '192.168.1.5' }
    expect(sidebarTrustedHosts(ctx)).toEqual(['new.internal:443', '192.168.1.5'])
    expect(isTrustedApiRequest({ headers: { host: 'evil.internal', origin: 'dsh-app://app' } }, sidebarTrustedHosts(ctx))).toBe(false)
    delete services.webRuntime
    delete services.webStartup
    expect(sidebarTrustedHosts(ctx)).toEqual([])
  })

  it('activates without webRuntime and restores HTTP and WS after unloading', async () => {
    const ctx = new Context()
    const routes = new Map<string, SidebarWebRoute>()
    const upgrades = new Map<string, SidebarWebUpgradeRoute>()
    const register = <T extends { path: string }>(table: Map<string, T>, route: T) => {
      if (table.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      table.set(route.path, route)
      return () => { table.delete(route.path) }
    }
    ctx.provide('webServer', {
      host: '127.0.0.1',
      register: (route: SidebarWebRoute) => register(routes, route),
      registerUpgrade: (route: SidebarWebUpgradeRoute) => register(upgrades, route),
    })
    ctx.provide('connection', { requestRejection: () => undefined })
    ctx.provide('webStartup', { trustedHosts: [] })
    ctx.provide('sessions', { get: () => undefined })
    ctx.provide('tools', { register: () => () => {} })
    const server = createServer((req, res) => {
      const route = routes.get('/sidebar/api')
      if (route) void route.handler(req, res)
      else { res.writeHead(405); res.end() }
    })
    server.on('upgrade', (req, socket, head) => {
      const route = upgrades.get(new URL(req.url!, 'http://host').pathname)
      if (route) route.handler(req, socket, head)
      else socket.destroy()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as { port: number }
    const origin = `http://127.0.0.1:${address.port}`
    try {
      for (let generation = 0; generation < 2; generation++) {
        const fiber = ctx.plugin(sidebar)
        await fiber
        expect(routes.has('/sidebar/api')).toBe(true)
        for (const method of ['settings.get', 'session.phase', 'session.cwd']) {
          const response = await fetch(`${origin}/sidebar/api/${method}`, {
            method: 'POST', headers: { 'content-type': 'application/json', origin: 'dsh-app://app' },
            body: JSON.stringify({ sessionId: 'test' }),
          })
          expect(response.status).toBe(200)
          expect((await response.json()).ok).toBe(true)
        }
        for (const path of ['agent-opens', 'agent-terminals']) {
          const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/sidebar/ws/${path}?sessionId=test`, { origin: 'dsh-app://app' })
          const firstMessage = path === 'agent-terminals' ? once(ws, 'message') : undefined
          await once(ws, 'open')
          if (firstMessage) expect(JSON.parse(String((await firstMessage)[0]))).toEqual([])
          ws.close()
          await once(ws, 'close')
        }
        await fiber.dispose()
        expect(routes.size).toBe(0)
        expect(upgrades.size).toBe(0)
      }
    } finally {
      await ctx.fiber.dispose()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
