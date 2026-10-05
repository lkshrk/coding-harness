import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import { openState } from '@nightshift/supervisor'
import { type CliDeps, run } from '../run'

const KEY = 'signal-secret-key'
const RAW = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const BOT = '+490000000001'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function config(dir: string, user?: string): Config {
  return {
    paths: { state: dir, cache: dir, vault: dir },
    gateway: { api_key: 'env:NS_GATEWAY_KEY' },
    linear: { auth: { mode: 'api_key', api_key: 'env:NS_LINEAR_KEY' } },
    github: { accounts: {} },
    secrets: { rbw_profile: 'nightshift' },
    notifications: {
      signal: {
        url: 'https://signal.test',
        api_key: 'env:NIGHTSHIFT_SIGNAL_API_KEY',
        group: 'h-cloud admin',
        ...(user ? { user } : {}),
      },
    },
  } as unknown as Config
}

type Seen = { method: string; path: string; key: string | null; body: unknown }

function fakeFetch(status = 200): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const key = new Headers(init?.headers).get('x-api-key')
    seen.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      key,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (status !== 200) return new Response('{"error":"unauthorized"}', { status })
    if (url.pathname === '/v1/accounts') return Response.json([BOT])
    if (url.pathname === `/v1/groups/${BOT}`) {
      return Response.json([{ name: 'h-cloud admin', id: `group.${btoa(RAW)}`, internal_id: RAW }])
    }
    if (url.pathname === '/v2/send') return Response.json([{ timestamp: '1786850001000' }])
    return new Response('not found', { status: 404 })
  }
  return { fetch: fn as unknown as typeof fetch, seen }
}

function setup(o: { status?: number; user?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-signal-cli-'))
  dirs.push(dir)
  const dbPath = join(dir, 'state.db')
  const http = fakeFetch(o.status)
  const deps: CliDeps = {
    load: () => ({ ok: true, config: config(dir, o.user), sources: [] }),
    statePath: () => dbPath,
    env: { NIGHTSHIFT_SIGNAL_API_KEY: KEY, HOME: dir },
    httpFetch: http.fetch,
    stdoutIsTTY: false,
    now: () => new Date('2026-10-04T10:00:00.000Z'),
  }
  const out: string[] = []
  const err: string[] = []
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }
  return { dir, dbPath, deps, http, out, err, io }
}

describe('ns signal test', () => {
  test('sends one test message to the configured group with the API key header', async () => {
    const s = setup()
    expect(await run(['signal', 'test', '--host', 'local'], s.io, s.deps)).toBe(0)
    expect(s.out).toEqual(["sent a test message to 'h-cloud admin' (timestamp 1786850001000)"])
    const send = s.http.seen.find((r) => r.path === '/v2/send')
    expect(send?.body).toMatchObject({ number: BOT, recipients: [`group.${btoa(RAW)}`] })
    expect(s.http.seen.every((r) => r.key === KEY)).toBe(true)
  })

  test('a rejected key is reported without its value', async () => {
    const s = setup({ status: 401 })
    expect(await run(['signal', 'test', '--host', 'local'], s.io, s.deps)).toBe(1)
    expect(s.err.join('\n')).toContain('API key was rejected')
    expect([...s.out, ...s.err].join('\n')).not.toContain(KEY)
  })
})

describe('ns signal pair', () => {
  test('writes a pairing code and waits until the supervisor records the account', async () => {
    const s = setup()
    const db = openState(s.dbPath)
    let slept = 0
    s.deps.sleep = async () => {
      slept += 1
      if (slept === 2) db.query("INSERT INTO meta (key, value) VALUES ('signal_user', 'uuid-1')").run()
    }
    expect(await run(['signal', 'pair', '--host', 'local'], s.io, s.deps)).toBe(0)
    const code = JSON.parse(readFileSync(join(s.dir, 'signal-pair.json'), 'utf8')).code
    expect(s.out).toEqual([
      "send this in the Signal group 'h-cloud admin' within 10 minutes:",
      `ns pair ${code}`,
      'paired with uuid-1',
    ])
    db.close()
  })

  test('a configured user needs no pairing', async () => {
    const s = setup({ user: '00000000-0000-4000-8000-000000000001' })
    expect(await run(['signal', 'pair', '--no-wait', '--host', 'local'], s.io, s.deps)).toBe(0)
    expect(s.out[0]).toContain('notifications.signal.user is set')
  })
})

describe('ns doctor signal check', () => {
  const doctorDeps = (s: ReturnType<typeof setup>, status = 200): CliDeps => ({
    ...s.deps,
    secret: () => async (ref) => (ref.includes('SIGNAL') ? KEY : 'x'),
    linear: () => ({
      workspace: async () => {
        throw new Error('offline')
      },
      customViews: async () => [],
      apply: async () => {
        throw new Error('no')
      },
    }),
    host: async () => [],
    which: (bin) => `/usr/bin/${bin}`,
    signalFetch: fakeFetch(status).fetch,
  })

  test('reports a reachable API with the account and group', async () => {
    const s = setup()
    await run(['doctor'], s.io, doctorDeps(s))
    expect(s.out).toContain(`info: signal: reachable, account ${BOT}, group 'h-cloud admin'`)
  })

  test('a rejected API key is an error with a fix', async () => {
    const s = setup()
    expect(await run(['doctor'], s.io, doctorDeps(s, 403))).toBe(1)
    expect(s.out).toContain('error: signal: https://signal.test rejected the API key (http 403)')
    expect(s.out.join('\n')).not.toContain(KEY)
  })
})

describe('ns status', () => {
  test('shows a Signal outage', async () => {
    const s = setup()
    const db = openState(s.dbPath)
    db.query("INSERT INTO meta (key, value) VALUES ('signal', ?)").run(
      JSON.stringify({ state: 'unavailable', detail: 'cannot connect', since: '2026-10-04T09:00:00.000Z' }),
    )
    db.close()
    s.deps.socketPath = () => join(s.dir, 'missing.sock')
    expect(await run(['status', '--host', 'local'], s.io, s.deps)).toBe(0)
    expect(s.out.find((l) => l.startsWith('dispatch:'))).toContain('signal: unavailable (cannot connect)')
  })
})
