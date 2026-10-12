import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpenCodeClient, type StatusRecord } from '@nightshift/supervisor'
import { createCtx, paint } from '../cli'
import { SessionRenderer } from '../render/session'
import { plainText } from '../render/status'
import { chatView, leadSession, workersParts } from './lead'
import { terminalWidth } from './tail'

const RICH = 'ses_ecea1c3a3ffeviBjwPtiWE7Jn6'
const fixture = readFileSync(join(import.meta.dir, '../render/fixtures/opencode-rich-session.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)

type Request = { method: string; path: string; body?: unknown }

function fakeLead(o: { sessions?: { id: string }[]; hold?: boolean } = {}) {
  const requests: Request[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ method, path: `${u.pathname}${u.search}`, ...(body ? { body } : {}) })
    if (u.pathname === '/api/event') {
      const bytes = new TextEncoder().encode(fixture.map((l) => `data: ${l}\n\n`).join(''))
      const signal = init?.signal
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => {
            c.enqueue(bytes)
            if (!o.hold) return c.close()
            signal?.addEventListener('abort', () => c.error(signal.reason), { once: true })
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    if (u.pathname === '/api/session' && method === 'GET') return Response.json({ data: o.sessions ?? [] })
    if (u.pathname === '/api/session' && method === 'POST')
      return Response.json({ data: { id: 'ses_new', time: {} } })
    return Response.json({})
  }) as unknown as typeof fetch
  return { requests, client: new OpenCodeClient('http://lead.test', 'pw', fetchFn) }
}

function ctxWith(out: string[], err: string[], env: Record<string, string> = {}) {
  return createCtx(
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    { json: false, noColor: false, yes: false },
    { stdoutIsTTY: true, env },
  )
}

test('the chat view renders the recorded lead session like ns tail, without colour under NO_COLOR', async () => {
  const out: string[] = []
  const err: string[] = []
  const lead = fakeLead()
  const never = async function* (signal: AbortSignal): AsyncGenerator<string> {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
  }
  expect(await chatView(ctxWith(out, err, { NO_COLOR: '1' }), lead.client, RICH, never)).toBe(0)
  const expected = new SessionRenderer(RICH, paint(false), terminalWidth())
  expect(out).toEqual([...fixture.flatMap((l) => expected.feed(JSON.parse(l))), ...expected.flush()])
  expect(out).toContain('▸ write /tmp/tmp.unsuKoNlS5/NOTES.md')
  expect(out).toContain('Summary')
  expect(out.at(-1)).toBe('· idle')
  expect(out.join('\n')).not.toMatch(new RegExp(String.fromCharCode(27)))
  expect(err).toEqual(['(lead connection closed)'])
})

test('a typed line is posted as a prompt to the lead session, and leaving does not stop the session', async () => {
  const lead = fakeLead({ hold: true })
  const typed = async function* (): AsyncGenerator<string> {
    yield 'what is going on?'
    yield '   '
    yield 'thanks'
  }
  const err: string[] = []
  expect(await chatView(ctxWith([], err), lead.client, RICH, typed)).toBe(0)
  expect(err).toEqual([])
  expect(lead.requests.filter((r) => r.method !== 'GET')).toEqual([
    { method: 'POST', path: `/api/session/${RICH}/prompt`, body: { text: 'what is going on?' } },
    { method: 'POST', path: `/api/session/${RICH}/prompt`, body: { text: 'thanks' } },
  ])
})

test('the chat view reuses the newest lead session and creates one when there is none', async () => {
  const existing = fakeLead({ sessions: [{ id: 'ses_old' }] })
  expect(await leadSession(existing.client)).toBe('ses_old')
  expect(existing.requests).toEqual([
    { method: 'GET', path: '/api/session?order=desc&limit=1&parentID=null' },
  ])
  const empty = fakeLead()
  expect(await leadSession(empty.client)).toBe('ses_new')
  expect(empty.requests.at(-1)).toEqual({ method: 'POST', path: '/api/session', body: {} })
})

test('the status line lists running workers from the status record', () => {
  const worker = (issue: string, agent: string, minutes: number) => ({
    run: `r-${issue}`,
    issue,
    agent,
    model: 'm',
    profile: 'p',
    state: 'running',
    attempt: 1,
    started_at: '',
    elapsed_ms: minutes * 60_000,
    steps: 0,
    tool_calls: 0,
    tokens: 0,
    last_tool: null,
    diff_lines: null,
  })
  const record = {
    supervisor: 'running',
    workers: [worker('XXX-123', 'implementer', 12), worker('XXX-124', 'explorer', 2)],
  } as unknown as StatusRecord
  expect(plainText(workersParts(record))).toBe('XXX-123 implementer 12m00s · XXX-124 explorer 2m00s')
  expect(plainText(workersParts({ ...record, workers: [] }))).toBe('no running workers')
  expect(plainText(workersParts({ supervisor: 'down', state: null }))).toBe('supervisor not running')
})
