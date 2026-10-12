import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import { probeGateway } from './probe'

type Init = RequestInit & { tls?: { ca?: string } }

const home = mkdtempSync(join(tmpdir(), 'probe-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const gw = (extra: Partial<Config['gateway']> = {}) =>
  ({ base_url: 'https://gw.example/v1', ...extra }) as Config['gateway']

function fake(respond: (url: string, init: Init) => Promise<Response>) {
  const calls: { url: string; init: Init }[] = []
  const fetch = ((url: string, init: Init) => {
    calls.push({ url: String(url), init })
    return respond(String(url), init)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

describe('probeGateway', () => {
  test('GETs the readiness endpoint at the origin of base_url without credentials', async () => {
    const f = fake(async () => new Response('ok', { status: 200 }))
    await probeGateway(gw(), { fetch: f.fetch, home })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.url).toBe('https://gw.example/health/readiness')
    expect(f.calls[0]?.init.method).toBe('GET')
    expect(f.calls[0]?.init.headers).toBeUndefined()
  })

  test('2xx is ok', async () => {
    const f = fake(async () => new Response('{}', { status: 200 }))
    expect(await probeGateway(gw(), { fetch: f.fetch, home })).toEqual({
      ok: true,
      reason: 'https://gw.example/health/readiness: HTTP 200',
    })
  })

  test('non-2xx is not ok and names the status', async () => {
    const f = fake(async () => new Response('down', { status: 503 }))
    const r = await probeGateway(gw(), { fetch: f.fetch, home })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('HTTP 503')
  })

  test('timeout is not ok and names the timeout', async () => {
    const f = fake(
      (_url, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const r = await probeGateway(gw(), { fetch: f.fetch, home, timeoutMs: 10 })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('timed out after 10ms')
  })

  test('network error is not ok and names the error', async () => {
    const f = fake(async () => {
      throw new Error('ECONNREFUSED')
    })
    const r = await probeGateway(gw(), { fetch: f.fetch, home })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('unreachable')
    expect(r.reason).toContain('ECONNREFUSED')
  })

  test('TLS error is named as such', async () => {
    const f = fake(async () => {
      throw new Error('self signed certificate in certificate chain')
    })
    const r = await probeGateway(gw(), { fetch: f.fetch, home })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('TLS certificate not trusted')
  })

  test('passes the configured CA bundle with ~ expanded as tls.ca', async () => {
    writeFileSync(join(home, 'ca.pem'), 'PEM-DATA')
    const f = fake(async () => new Response('', { status: 200 }))
    const r = await probeGateway(gw({ ca_bundle: '~/ca.pem' }), { fetch: f.fetch, home })
    expect(r.ok).toBe(true)
    expect(f.calls[0]?.init.tls).toEqual({ ca: 'PEM-DATA' })
  })

  test('a missing CA bundle is not ok, names the path and skips the request', async () => {
    const f = fake(async () => new Response('', { status: 200 }))
    const r = await probeGateway(gw({ ca_bundle: '~/missing.pem' }), { fetch: f.fetch, home })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain(join(home, 'missing.pem'))
    expect(f.calls).toHaveLength(0)
  })
})
