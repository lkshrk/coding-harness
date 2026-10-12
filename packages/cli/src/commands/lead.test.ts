import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { OpenCodeClient, type StatusRecord } from '@nightshift/supervisor'
import { createCtx, paint } from '../cli'
import { SessionRenderer, stripEscapes } from '../render/session'
import { plainText } from '../render/status'
import { chatView, leadSession, terminalInput, workersParts } from './lead'
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

function ttyPair(rows = 24, columns = 80) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void }
  input.isTTY = true
  input.setRawMode = () => {}
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number }
  output.isTTY = true
  output.columns = columns
  output.rows = rows
  const writes: string[] = []
  output.on('data', (b: Buffer) => writes.push(b.toString()))
  return { input, output, writes }
}

test('the input line and the footer are pinned to the bottom two rows; output scrolls above them', async () => {
  const { input, output, writes } = ttyPair(24, 80)
  const term = terminalInput(input, output, false)
  const all = () => writes.join('')
  expect(all()).toContain('\x1b[1;22r')
  term.dock?.setFooter([['dim', 'no running workers']])
  expect(all()).toContain('\x1b[24;1H')
  const stop = new AbortController()
  const seen: string[] = []
  const reading = (async () => {
    for await (const line of term.lines(stop.signal)) seen.push(line)
  })()
  input.write('what is go')
  await Bun.sleep(10)
  writes.length = 0
  term.print('reply line')
  const printed = all()
  expect(printed.startsWith('\x1b[22;1H\nreply line')).toBe(true)
  expect(printed.endsWith('\x1b[23;1H\x1b[2K› what is go')).toBe(true)
  input.write('ing on?\r')
  await Bun.sleep(10)
  expect(seen).toEqual(['what is going on?'])
  expect(all().endsWith('\x1b[23;1H\x1b[2K› ')).toBe(true)
  stop.abort()
  await reading
  writes.length = 0
  term.close()
  expect(all()).toContain('\x1b[r')
})

test('the dock input handles backspace, ctrl+u and ignores arrow keys', async () => {
  const { input, output } = ttyPair()
  const term = terminalInput(input, output, false)
  const stop = new AbortController()
  const seen: string[] = []
  const reading = (async () => {
    for await (const line of term.lines(stop.signal)) seen.push(line)
  })()
  input.write('helloo\x7f\x1b[D world\r')
  input.write('drop me\x15kept\r')
  await Bun.sleep(10)
  expect(seen).toEqual(['hello world', 'kept'])
  input.write('\x03')
  await reading
  term.close()
})

test('without a terminal the chat input reads plain lines and prints without escapes', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let written = ''
  output.on('data', (b: Buffer) => {
    written += b.toString()
  })
  const term = terminalInput(input, output, false)
  expect(term.dock).toBeNull()
  term.print('plain')
  expect(written).toBe('plain\n')
  const stop = new AbortController()
  const seen: string[] = []
  const reading = (async () => {
    for await (const line of term.lines(stop.signal)) seen.push(line)
  })()
  input.write('one\ntwo\n')
  input.end()
  await reading
  expect(seen).toEqual(['one', 'two'])
})

test('the chat view routes its output through the input so the typed line survives', async () => {
  const out: string[] = []
  const wraps: number[] = []
  const lead = fakeLead()
  const never = async function* (signal: AbortSignal): AsyncGenerator<string> {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
  }
  const around = (write: () => void) => {
    wraps.push(out.length)
    write()
  }
  await chatView(ctxWith(out, [], { NO_COLOR: '1' }), lead.client, RICH, { lines: never, around })
  expect(out.length).toBeGreaterThan(0)
  expect(wraps.length).toBeGreaterThanOrEqual(out.length)
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
