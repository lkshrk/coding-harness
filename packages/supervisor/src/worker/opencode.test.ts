import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { HarnessEvent, WorkerStart } from '../interfaces'
import {
  argsDigest,
  EventMapper,
  FINISH_FILE,
  GATEWAY_KEY_ENV,
  OPENCODE_CONFIG_DIR,
  OpenCodeDriver,
  opencodeConfig,
} from './opencode'
import { FakeSandboxDriver } from './testing'

type Request = { method: string; path: string; body: unknown; auth: string | null }

class FakeOpenCode {
  readonly requests: Request[] = []
  readonly sessions = new Set<string>()
  private readonly streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  private readonly server: ReturnType<typeof Bun.serve>

  constructor(private readonly password: () => string) {
    this.server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url)
        const body = req.method === 'POST' ? await req.text() : ''
        const auth = req.headers.get('authorization')
        this.requests.push({
          method: req.method,
          path: url.pathname,
          body: body ? JSON.parse(body) : undefined,
          auth,
        })
        if (auth !== `Basic ${btoa(`opencode:${this.password()}`)}`)
          return new Response('no', { status: 401 })
        if (url.pathname === '/api/info') return Response.json({})
        if (url.pathname === '/api/session' && req.method === 'POST') {
          this.sessions.add('ses_1')
          return Response.json({ data: { id: 'ses_1', time: {} } })
        }
        if (url.pathname === '/api/event') {
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (c) => {
                this.streams.add(c)
                c.enqueue(new TextEncoder().encode(': hello\n\n'))
              },
              cancel: () => undefined,
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        const m = url.pathname.match(/^\/api\/session\/([^/]+)(\/\w+)?$/)
        if (m && this.sessions.has(m[1] as string)) return Response.json({ data: { id: m[1], time: {} } })
        return new Response('not found', { status: 404 })
      },
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  emit(type: string, data: Record<string, unknown>): void {
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ type, data: { sessionID: 'ses_1', ...data } })}\n\n`,
    )
    for (const c of this.streams) c.enqueue(bytes)
  }

  posted(suffix: string): unknown[] {
    return this.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix)).map((r) => r.body)
  }

  stop(): void {
    this.server.stop(true)
  }
}

let oc: FakeOpenCode
let sandbox: FakeSandboxDriver
let driver: OpenCodeDriver

const handle = { driver: 'docker' as const, id: 'ctr-1', name: 'run1' }

function workerStart(over: Partial<WorkerStart> = {}): WorkerStart {
  return {
    sandbox: handle,
    agent: {
      name: 'fixer',
      files: [
        { path: 'agent/fixer.md', content: '---\nmode: primary\n---\nFixes bugs.' },
        { path: 'plugins/nightshift-finish/index.js', content: 'export default {}' },
        {
          path: 'opencode.json',
          content: JSON.stringify({ plugins: [{ package: '/x/plugins/nightshift-finish' }] }),
        },
      ],
    },
    model: 'litellm/ns/worker',
    taskMessage: '--- BEGIN ISSUE ---\nfix it\n--- END ISSUE ---',
    gateway: { baseUrl: 'https://gw.test/v1', apiKey: 'sk-run', sessionId: 'run1' },
    limits: { steps: 50, wallClockMs: 60_000, tokens: 100_000, graceTurns: 1 },
    workdir: '/work/omni',
    ...over,
  }
}

function started() {
  return driver.start(workerStart())
}

beforeEach(() => {
  sandbox = new FakeSandboxDriver()
  oc = new FakeOpenCode(() => sandbox.files.get('/tmp/nightshift/server-password') ?? '')
  sandbox.url = oc.url
  driver = new OpenCodeDriver({ sandbox, heartbeatMs: 20, readyTimeoutMs: 2_000 })
})

afterEach(() => oc.stop())

async function take(it: AsyncIterator<HarnessEvent>, n: number): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = []
  while (out.length < n) {
    const r = await it.next()
    if (r.done) break
    out.push(r.value)
  }
  return out
}

describe('opencodeConfig', () => {
  test('points the litellm provider at the gateway with the session header and keeps plugins', () => {
    const cfg = opencodeConfig(workerStart(), { plugins: [{ package: '/p' }] })
    expect(cfg).toMatchObject({
      model: 'litellm/ns/worker',
      plugins: [{ package: '/p' }],
      providers: {
        litellm: {
          package: 'aisdk:@ai-sdk/openai-compatible',
          env: [GATEWAY_KEY_ENV],
          settings: { baseURL: 'https://gw.test/v1' },
          headers: { 'x-litellm-session-id': 'run1' },
          models: { 'ns/worker': {} },
        },
      },
    })
    expect(JSON.stringify(cfg)).not.toContain('sk-run')
  })
})

describe('EventMapper', () => {
  test('maps OpenCode v2 events of its own session to harness events', () => {
    const m = new EventMapper('ses_1')
    const ev = (type: string, data: Record<string, unknown>) =>
      m.map({ type, data: { sessionID: 'ses_1', ...data } })
    expect(ev('session.tool.input.started', { id: 'c1', name: 'edit' })).toEqual([])
    expect(ev('session.tool.called', { id: 'c1', input: { path: 'a', b: 1 } })).toEqual([
      { kind: 'tool_call', tool: 'edit', argsDigest: argsDigest('edit', { b: 1, path: 'a' }) },
    ])
    expect(ev('session.tool.failed', { id: 'c1', error: { message: 'boom' } })).toEqual([
      { kind: 'tool_result', tool: 'edit', ok: false },
    ])
    expect(
      ev('session.step.ended', {
        tokens: { input: 60, output: 1, reasoning: 11, cache: { read: 2688, write: 4 } },
      }),
    ).toEqual([{ kind: 'step', step: 1, tokensIn: 64, tokensOut: 12 }])
    expect(ev('session.text.ended', { text: 'done' })).toEqual([{ kind: 'text', chars: 4 }])
    expect(ev('session.execution.failed', { error: { message: 'HTTP 502 from provider' } })).toEqual([
      { kind: 'error', message: 'HTTP 502 from provider', fatal: true },
    ])
    expect(ev('session.execution.succeeded', {})).toEqual([{ kind: 'idle', sinceMs: 0 }])
    expect(m.map({ type: 'session.step.ended', data: { sessionID: 'ses_other' } })).toEqual([])
  })
})

describe('OpenCodeDriver', () => {
  test('start writes the config, starts serve with the key in its environment and prompts once', async () => {
    const s = await started()
    expect(s.id).toBe('ses_1')
    expect(sandbox.files.get(`${OPENCODE_CONFIG_DIR}/agent/fixer.md`)).toContain('Fixes bugs.')
    expect(sandbox.files.has(`${OPENCODE_CONFIG_DIR}/plugins/nightshift-finish/index.js`)).toBe(true)
    const cfg = JSON.parse(sandbox.files.get(`${OPENCODE_CONFIG_DIR}/opencode.json`) ?? '{}')
    expect(cfg.plugins).toEqual([{ package: '/x/plugins/nightshift-finish' }])
    expect(cfg.providers.litellm.settings.baseURL).toBe('https://gw.test/v1')
    const [spawn] = sandbox.spawns
    expect(spawn?.cmd).toEqual(['opencode-worker', 'serve', '--hostname', '0.0.0.0', '--port', '4096'])
    expect(spawn?.opts).toMatchObject({
      cwd: '/work/omni',
      env: { NIGHTSHIFT_FINISH_PATH: FINISH_FILE, [GATEWAY_KEY_ENV]: 'sk-run' },
    })
    expect(spawn?.opts.env?.OPENCODE_SERVER_PASSWORD).toHaveLength(48)
    expect(oc.posted('/api/session')).toEqual([
      {
        agent: 'fixer',
        model: { providerID: 'litellm', id: 'ns/worker' },
        location: { directory: '/work/omni' },
      },
    ])
    expect(oc.posted('/prompt')).toEqual([{ text: '--- BEGIN ISSUE ---\nfix it\n--- END ISSUE ---' }])
    expect(s.attach.slice(0, 4)).toEqual(['docker', 'exec', '-it', 'ctr-1'])
    expect(s.attach.join(' ')).not.toContain(spawn?.opts.env?.OPENCODE_SERVER_PASSWORD ?? 'x')
  })

  test('events yield tool calls and steps, then the finish payload, and end', async () => {
    const s = await started()
    const it = driver.events(s)[Symbol.asyncIterator]()
    await Bun.sleep(50)
    oc.emit('session.tool.input.started', { id: 'c1', name: 'read' })
    oc.emit('session.tool.called', { id: 'c1', input: { path: 'a' } })
    oc.emit('session.step.ended', { tokens: { input: 10, output: 2 } })
    const first = await take(it, 2)
    expect(first.map((e) => e.kind)).toEqual(['tool_call', 'step'])
    sandbox.files.set(FINISH_FILE, '{"status":"DONE","summary":"ok","evidence":[]}')
    oc.emit('session.tool.input.started', { id: 'c2', name: 'finish' })
    oc.emit('session.tool.called', { id: 'c2', input: {} })
    oc.emit('session.tool.success', { id: 'c2' })
    const rest = await take(it, 5)
    expect(rest).toEqual([
      { kind: 'tool_call', tool: 'finish', argsDigest: argsDigest('finish', {}) },
      { kind: 'finish', payload: { status: 'DONE', summary: 'ok', evidence: [] } },
    ])
  })

  test('a failed finish call is passed on as a tool result and the stream continues', async () => {
    const s = await started()
    const it = driver.events(s)[Symbol.asyncIterator]()
    await Bun.sleep(50)
    oc.emit('session.tool.input.started', { id: 'c1', name: 'finish' })
    oc.emit('session.tool.failed', { id: 'c1', error: 'Invalid finish payload' })
    oc.emit('session.text.ended', { text: 'hi' })
    expect(await take(it, 2)).toEqual([
      { kind: 'tool_result', tool: 'finish', ok: false },
      { kind: 'text', chars: 2 },
    ])
    await driver.stop(s, 'test')
  })

  test('a finish written before the stream connects is reported first (reattach)', async () => {
    const s = await started()
    sandbox.files.set(FINISH_FILE, '{"status":"DONE"}')
    expect(await take(driver.events(s)[Symbol.asyncIterator](), 3)).toEqual([
      { kind: 'finish', payload: { status: 'DONE' } },
    ])
  })

  test('emits idle heartbeats after the execution ended and ends on a fatal error', async () => {
    const s = await started()
    const it = driver.events(s)[Symbol.asyncIterator]()
    await Bun.sleep(50)
    oc.emit('session.execution.succeeded', {})
    const [ended, beat] = await take(it, 2)
    expect(ended).toEqual({ kind: 'idle', sinceMs: 0 })
    expect(beat?.kind).toBe('idle')
    oc.emit('session.execution.failed', { error: { message: 'gateway 503' } })
    const tail: HarnessEvent[] = []
    for (let r = await it.next(); !r.done; r = await it.next()) tail.push(r.value)
    expect(tail.at(-1)).toEqual({ kind: 'error', message: 'gateway 503', fatal: true })
  })

  test('send prompts, stop interrupts, alive asks for the session', async () => {
    const s = await started()
    await driver.send(s, 'nudge')
    expect(oc.posted('/prompt').at(-1)).toEqual({ text: 'nudge' })
    await driver.stop(s, 'stalled')
    expect(oc.posted('/interrupt')).toHaveLength(1)
    expect(await driver.alive(s)).toBe(true)
    expect(await driver.alive({ id: 'ses_unknown', attach: [] })).toBe(false)
    oc.sessions.clear()
    expect(await driver.alive(s)).toBe(false)
  })
})
