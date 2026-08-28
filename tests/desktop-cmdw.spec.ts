/**
 * The host-side ⌘W claim channel (see src/desktop-cmdw.ts): arbitration
 * rounds over a request/reply wire, plus the ShortcutRouter claimer
 * registration. Pure logic — fake sockets stand in for the `ws` package.
 *
 * - no views → unclaimed immediately (the shell keeps its confirm dialog);
 * - one claimed reply wins the round (window stays, tab closes);
 * - every view answering unclaimed resolves unclaimed;
 * - first claim wins across views; the timeout caps a silent round;
 * - a socket that dies mid-round cannot stall it;
 * - the claimer feature-detects `ctx.desktopShortcuts` (absent / broken
 *   service = strict no-op, never a throw).
 */
import { describe, expect, it } from 'vitest'
import { CmdWChannel, registerDesktopShortcutClaim, type CmdWSocketFace } from '../src/desktop-cmdw.ts'
import { parseCmdWFrame, type CmdWReplyFrame, type CmdWRequestFrame } from '../src/cmd-w-wire.ts'

/** A fake `ws` socket: records sends, can emit frames, and can die. */
interface FakeSocket extends CmdWSocketFace {
  sent: string[]
  emit(raw: unknown): void
  die(): void
}

function makeSocket(): FakeSocket {
  const listeners = {
    message: new Set<(raw: unknown) => void>(),
    close: new Set<() => void>(),
    error: new Set<() => void>(),
  }
  const socket: FakeSocket = {
    readyState: 1,
    sent: [],
    send(data) {
      socket.sent.push(data)
    },
    on(event, listener) {
      if (event === 'message') listeners.message.add(listener as (raw: unknown) => void)
      else if (event === 'close') listeners.close.add(listener as () => void)
      else listeners.error.add(listener as () => void)
    },
    emit(raw) {
      for (const listener of [...listeners.message]) listener(raw)
    },
    die() {
      socket.readyState = 3
      for (const listener of [...listeners.close]) listener()
    },
  }
  return socket
}

/** Extract the request frame a socket was sent; fails the test when absent. */
function lastRequest(ws: FakeSocket): CmdWRequestFrame {
  const frame = parseCmdWFrame(ws.sent.at(-1)!)
  if (frame === null || frame.type !== 'cmd-w') throw new Error('expected a cmd-w request frame')
  return frame
}

/** Emit a reply frame from a socket. */
function reply(ws: FakeSocket, id: string, claimed: boolean): void {
  ws.emit(JSON.stringify({ type: 'cmd-w-reply', id, claimed } satisfies CmdWReplyFrame))
}

describe('CmdWChannel arbitration', () => {
  it('resolves unclaimed immediately with no connected views', async () => {
    const channel = new CmdWChannel()
    await expect(channel.route()).resolves.toBe('unclaimed')
  })

  it('a claimed reply wins the round', async () => {
    const channel = new CmdWChannel()
    const ws = makeSocket()
    const detach = channel.attach(ws)
    try {
      const round = channel.route()
      const request = lastRequest(ws)
      reply(ws, request.id, true)
      await expect(round).resolves.toBe('claimed')
    } finally {
      detach()
    }
  })

  it('resolves unclaimed when EVERY view answers no', async () => {
    const channel = new CmdWChannel()
    const first = makeSocket()
    const second = makeSocket()
    const detach1 = channel.attach(first)
    const detach2 = channel.attach(second)
    try {
      const round = channel.route()
      expect(first.sent).toHaveLength(1)
      expect(second.sent).toHaveLength(1)
      const id = lastRequest(first).id
      expect(lastRequest(second).id).toBe(id)
      reply(first, id, false)
      reply(second, id, false)
      await expect(round).resolves.toBe('unclaimed')
    } finally {
      detach1()
      detach2()
    }
  })

  it('first claim wins across views; later replies are ignored', async () => {
    const channel = new CmdWChannel()
    const first = makeSocket()
    const second = makeSocket()
    const detach1 = channel.attach(first)
    const detach2 = channel.attach(second)
    try {
      const round = channel.route()
      const id = lastRequest(first).id
      reply(second, id, true)
      await expect(round).resolves.toBe('claimed')
      // A stale reply after the round settled must not throw or re-resolve.
      reply(first, id, false)
    } finally {
      detach1()
      detach2()
    }
  })

  it('times out to unclaimed when a view never answers', async () => {
    const channel = new CmdWChannel(15)
    const ws = makeSocket()
    const detach = channel.attach(ws)
    try {
      const round = channel.route()
      expect(ws.sent).toHaveLength(1)
      await expect(round).resolves.toBe('unclaimed')
    } finally {
      detach()
    }
  })

  it('a socket that dies mid-round cannot stall it', async () => {
    const channel = new CmdWChannel(1000)
    const silent = makeSocket()
    const answering = makeSocket()
    const detach1 = channel.attach(silent)
    const detach2 = channel.attach(answering)
    try {
      const round = channel.route()
      const id = lastRequest(answering).id
      silent.die() // drops it from the in-flight round
      reply(answering, id, false)
      await expect(round).resolves.toBe('unclaimed')
    } finally {
      detach1()
      detach2()
    }
  })

  it('a detached view no longer takes part in rounds', async () => {
    const channel = new CmdWChannel()
    const ws = makeSocket()
    const detach = channel.attach(ws)
    detach()
    await expect(channel.route()).resolves.toBe('unclaimed')
    expect(ws.sent).toHaveLength(0)
  })
})

describe('registerDesktopShortcutClaim', () => {
  /** A fake ShortcutRouter recording registrations. */
  function makeShortcuts(): {
    registrations: Array<{ shortcut: string; handler: () => unknown }>
    unregister: (handler: () => unknown) => void
    service: { register: (shortcut: string, handler: () => unknown) => () => void }
  } {
    const registrations: Array<{ shortcut: string; handler: () => unknown }> = []
    const unregister = (handler: () => unknown): void => {
      const index = registrations.findIndex(entry => entry.handler === handler)
      if (index !== -1) registrations.splice(index, 1)
    }
    return {
      registrations,
      unregister,
      service: {
        register: (shortcut, handler) => {
          registrations.push({ shortcut, handler })
          return () => unregister(handler)
        },
      },
    }
  }

  it('registers cmd-w and resolves the route from the channel verdict', async () => {
    const channel = new CmdWChannel()
    const ws = makeSocket()
    channel.attach(ws)
    const fake = makeShortcuts()
    const disposer = registerDesktopShortcutClaim({ get: () => fake.service }, channel)
    try {
      expect(fake.registrations).toHaveLength(1)
      expect(fake.registrations[0]!.shortcut).toBe('cmd-w')
      const round = fake.registrations[0]!.handler() as Promise<'claimed' | 'unclaimed'>
      const id = lastRequest(ws).id
      reply(ws, id, true)
      await expect(round).resolves.toBe('claimed')
    } finally {
      disposer()
    }
  })

  it('disposes the registration', () => {
    const channel = new CmdWChannel()
    const fake = makeShortcuts()
    const disposer = registerDesktopShortcutClaim({ get: () => fake.service }, channel)
    disposer()
    expect(fake.registrations).toHaveLength(0)
  })

  it('is a strict no-op when the desktop service is absent', () => {
    const channel = new CmdWChannel()
    expect(() => registerDesktopShortcutClaim({ get: () => undefined }, channel)).not.toThrow()
    expect(() => registerDesktopShortcutClaim({}, channel)).not.toThrow()
  })

  it('degrades to a no-op when the service itself misbehaves', () => {
    const channel = new CmdWChannel()
    const broken = { register: () => { throw new Error('boom') } }
    expect(() => registerDesktopShortcutClaim({ get: () => broken }, channel)).not.toThrow()
  })
})