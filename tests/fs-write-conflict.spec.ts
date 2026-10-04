import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { apply } from '../src/index.ts'
import { api, SidebarApiError } from '../src/client/api.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** Mount the actual plugin and invoke its registered HTTP route, not a mock CAS. */
function fixture(readLimit = 1024) {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-write-conflict-'))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  const routes: SidebarWebRoute[] = []
  apply({
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: () => () => {},
    },
    sessions: { get: () => ({ header: { cwd } }) },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  } as never, { readLimit })
  const route = routes.find(route => route.path === '/sidebar/api')!
  const invoke = async (method: string, payload: Record<string, unknown>) => {
    let status = 0
    let text = ''
    const req = {
      method: 'POST', url: `/sidebar/api/${method}`,
      headers: { host: '127.0.0.1:3080' },
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify({ sessionId: 's-write', ...payload }))
      },
    }
    await route.handler(req as never, {
      writeHead: (value: number) => { status = value },
      end: (chunk: unknown) => { text += String(chunk ?? '') },
    } as never)
    return { status, body: JSON.parse(text) }
  }
  return { cwd, path: join(cwd, 'file.txt'), invoke }
}

function expectConflict(result: { status: number; body: unknown }) {
  expect(result.status).toBe(409)
  expect(result.body).toMatchObject({ ok: false, error: { code: 'fs-error', message: expect.stringMatching(/^conflict:/) } })
}

describe('fs.write complete-text precondition (real route)', () => {
  it('saves matching text and rejects an external change without touching disk', async () => {
    const { cwd, path, invoke } = fixture()
    writeFileSync(path, '原文\r\n')
    const read = await invoke('fs.read', { path })
    expect(read.body.value).toEqual({ kind: 'text', content: '原文\r\n', truncated: false })
    expect((await invoke('fs.write', { path, content: 'saved', expectedContent: read.body.value.content })).status).toBe(200)
    writeFileSync(path, 'external')
    expectConflict(await invoke('fs.write', { path, content: 'stale edit', expectedContent: 'saved' }))
    expect(readFileSync(path, 'utf8')).toBe('external')
    expect(readdirSync(cwd)).toEqual(['file.txt'])
  })

  it('accepts empty expected text and an empty replacement', async () => {
    const { path, invoke } = fixture()
    writeFileSync(path, '')
    expect((await invoke('fs.write', { path, content: 'new', expectedContent: '' })).status).toBe(200)
    expect((await invoke('fs.write', { path, content: '', expectedContent: 'new' })).status).toBe(200)
    expect(readFileSync(path, 'utf8')).toBe('')
  })

  it('keeps omitted-field legacy overwrite and file creation compatible', async () => {
    const { path, invoke } = fixture()
    expect((await invoke('fs.write', { path, content: 'created' })).status).toBe(200)
    expect((await invoke('fs.write', { path, content: 'overwrite' })).status).toBe(200)
    expect(readFileSync(path, 'utf8')).toBe('overwrite')
  })

  it('refuses missing files and non-string preconditions, including null', async () => {
    const { path, invoke } = fixture()
    expectConflict(await invoke('fs.write', { path, content: 'new', expectedContent: '' }))
    for (const expectedContent of [null, 0, false, {}]) {
      const response = await invoke('fs.write', { path, content: 'new', expectedContent })
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('bad-request')
    }
  })

  it('never compares and overwrites a truncated preview, even with a complete supplied base', async () => {
    const { path, invoke } = fixture(4)
    writeFileSync(path, '123456')
    const read = await invoke('fs.read', { path })
    expect(read.body.value).toEqual({ kind: 'text', content: '1234', truncated: true })
    for (const expectedContent of ['1234', '123456']) {
      expectConflict(await invoke('fs.write', { path, content: 'new', expectedContent }))
      expect(readFileSync(path, 'utf8')).toBe('123456')
    }
  })

  it('refuses binary and lossy UTF-8 bases without changing bytes', async () => {
    const { path, invoke } = fixture()
    for (const bytes of [Buffer.from([65, 0, 66]), Buffer.from([0xff, 0xfe])]) {
      writeFileSync(path, bytes)
      expectConflict(await invoke('fs.write', { path, content: 'new', expectedContent: bytes.toString('utf8') }))
      expect(readFileSync(path)).toEqual(bytes)
    }
  })

  it('serializes competing same-path writes across normalized absolute paths', async () => {
    const { cwd, path, invoke } = fixture()
    writeFileSync(path, 'base')
    const results = await Promise.all([
      invoke('fs.write', { path, content: 'first', expectedContent: 'base' }),
      invoke('fs.write', { path: `${cwd}${sep}.${sep}file.txt`, content: 'second', expectedContent: 'base' }),
    ])
    expect(results.map(result => result.status).sort()).toEqual([200, 409])
    expectConflict(results.find(result => result.status === 409)!)
    expect(['first', 'second']).toContain(readFileSync(path, 'utf8'))
    expect(readdirSync(cwd)).toEqual(['file.txt'])
    // A conflict must release the queue for the next legacy write.
    expect((await invoke('fs.write', { path, content: 'after' })).status).toBe(200)
  })

  it('client API omits undefined, forwards expectedContent, and surfaces the real conflict', async () => {
    const { path, invoke } = fixture()
    writeFileSync(path, 'base')
    const payloads: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(init.body as string)
      payloads.push(payload)
      const response = await invoke('fs.write', payload)
      return new Response(JSON.stringify(response.body), { status: response.status })
    })
    await api.fsWrite({ sessionId: 's-write' }, path, 'legacy')
    expect(payloads[0]).not.toHaveProperty('expectedContent')
    await api.fsWrite({ sessionId: 's-write' }, path, 'saved', 'legacy')
    expect(payloads[1]).toHaveProperty('expectedContent', 'legacy')
    await expect(api.fsWrite({ sessionId: 's-write' }, path, 'stale', 'legacy')).rejects.toBeInstanceOf(SidebarApiError)
    await expect(api.fsWrite({ sessionId: 's-write' }, path, 'stale', 'legacy')).rejects.toMatchObject({ code: 'fs-error', message: expect.stringMatching(/^conflict:/) })
    expect(readFileSync(path, 'utf8')).toBe('saved')
  })
})
