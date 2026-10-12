import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leadAdvisor } from './advisor'

type Request = { method: string; path: string; body?: unknown; auth?: string | null }

const text = (sessionID: string, t: string) => ({ type: 'session.text.ended', data: { sessionID, text: t } })
const done = (sessionID: string) => ({ type: 'session.execution.succeeded', data: { sessionID } })

function fakeLead(o: { events?: unknown[]; down?: boolean; hold?: boolean } = {}) {
  const requests: Request[] = []
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(url)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const auth = new Headers(init?.headers).get('authorization')
    requests.push({ method, path: u.pathname, ...(body ? { body } : {}), auth })
    if (u.pathname === '/api/info') return new Response(null, { status: o.down ? 503 : 200 })
    if (u.pathname === '/api/event') {
      const bytes = new TextEncoder().encode(
        (o.events ?? []).map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
      )
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
    if (u.pathname === '/api/session' && method === 'POST')
      return Response.json({ data: { id: 'ses_q', time: {} } })
    return Response.json({})
  }) as unknown as typeof fetch
  return { requests, fetchFn }
}

function passwordFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'lead-')), 'server-password')
  writeFileSync(file, 'secret\n')
  return file
}

const Q = { issue: 'FOR-1', question: 'Which API version?', options: ['v1', 'v2'] }

test('collects the last text of the lead session, ignoring other sessions', async () => {
  const lead = fakeLead({
    events: [
      text('ses_other', 'not mine'),
      text('ses_q', 'Looking…'),
      text('ses_q', '  Use v2; see docs/api.md.  '),
      done('ses_other'),
      text('ses_other', 'late'),
      done('ses_q'),
    ],
  })
  const advisor = leadAdvisor({ url: 'http://lead.test', passwordFile: passwordFile(), fetch: lead.fetchFn })
  expect(await advisor.ask(Q)).toEqual({ answer: 'Use v2; see docs/api.md.' })
  const prompt = lead.requests.find((r) => r.path === '/api/session/ses_q/prompt')
  const sent = (prompt?.body as { text?: string } | undefined)?.text
  expect(sent).toContain('FOR-1')
  expect(sent).toContain('Which API version?')
  expect(sent).toContain('v1 | v2')
  expect(sent).toContain('ESCALATE: <reason>')
  expect(lead.requests[0]?.auth).toBe(`Basic ${btoa('opencode:secret')}`)
})

test('an ESCALATE: reply is returned as an escalation with its reason', async () => {
  const lead = fakeLead({ events: [text('ses_q', 'ESCALATE: needs a product decision'), done('ses_q')] })
  const advisor = leadAdvisor({ url: 'http://lead.test', passwordFile: passwordFile(), fetch: lead.fetchFn })
  expect(await advisor.ask(Q)).toEqual({ escalate: 'needs a product decision' })
})

test('a lead that is down gets no session and returns null', async () => {
  const lead = fakeLead({ down: true })
  const advisor = leadAdvisor({ url: 'http://lead.test', passwordFile: passwordFile(), fetch: lead.fetchFn })
  expect(await advisor.ask(Q)).toBeNull()
  expect(lead.requests.map((r) => r.path)).toEqual(['/api/info'])
})

test('a missing password file returns null', async () => {
  const lead = fakeLead()
  const advisor = leadAdvisor({
    url: 'http://lead.test',
    passwordFile: '/nonexistent/pw',
    fetch: lead.fetchFn,
  })
  expect(await advisor.ask(Q)).toBeNull()
})

test('a lead that does not finish in time returns null', async () => {
  const lead = fakeLead({ events: [text('ses_q', 'thinking')], hold: true })
  const advisor = leadAdvisor({
    url: 'http://lead.test',
    passwordFile: passwordFile(),
    fetch: lead.fetchFn,
    timeoutMs: 20,
  })
  expect(await advisor.ask(Q)).toBeNull()
})

test('a failed execution returns null', async () => {
  const lead = fakeLead({
    events: [text('ses_q', 'partial'), { type: 'session.execution.failed', data: { sessionID: 'ses_q' } }],
  })
  const advisor = leadAdvisor({ url: 'http://lead.test', passwordFile: passwordFile(), fetch: lead.fetchFn })
  expect(await advisor.ask(Q)).toBeNull()
})
