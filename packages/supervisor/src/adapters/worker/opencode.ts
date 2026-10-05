import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachInfo } from '../../control/generated/control'
import type {
  HarnessEvent,
  Ms,
  SandboxDriver,
  SandboxHandle,
  WorkerDriver,
  WorkerSession,
  WorkerStart,
} from '../../ports/interfaces'
import { Channel } from './channel'
import { OpenCodeClient } from './opencode-client'

export const OPENCODE_PORT = 4096
export const WORKER_HOME = '/tmp/nightshift'
export const OPENCODE_CONFIG_DIR = `${WORKER_HOME}/config/opencode`
export const FINISH_FILE = `${WORKER_HOME}/finish.json`
export const PROVIDER = 'litellm'
export const GATEWAY_KEY_ENV = 'NIGHTSHIFT_GATEWAY_KEY'
const PASSWORD_FILE = `${WORKER_HOME}/server-password`

export type SessionConnection = { sandbox: SandboxHandle; url: string; password: string; workdir: string }

export interface SessionStore {
  save(id: string, c: SessionConnection): void
  load(id: string): SessionConnection | undefined
  remove(id: string): void
}

export function memorySessionStore(): SessionStore {
  const m = new Map<string, SessionConnection>()
  return { save: (id, c) => m.set(id, c), load: (id) => m.get(id), remove: (id) => m.delete(id) }
}

export function fileSessionStore(dir: string): SessionStore {
  const file = (id: string) => join(dir, `${id}.json`)
  return {
    save(id, c) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(file(id), JSON.stringify(c), { mode: 0o600 })
    },
    load(id) {
      try {
        return JSON.parse(readFileSync(file(id), 'utf8')) as SessionConnection
      } catch {
        return undefined
      }
    },
    remove(id) {
      rmSync(file(id), { force: true })
    },
  }
}

export function modelRef(model: string): { providerID: string; id: string } {
  return {
    providerID: PROVIDER,
    id: model.startsWith(`${PROVIDER}/`) ? model.slice(PROVIDER.length + 1) : model,
  }
}

export function opencodeConfig(
  w: Pick<WorkerStart, 'model' | 'gateway'>,
  base: Record<string, unknown> = {},
) {
  const { id } = modelRef(w.model)
  return {
    $schema: 'https://opencode.ai/config.json',
    ...base,
    update: 'disable',
    share: 'disabled',
    model: `${PROVIDER}/${id}`,
    providers: {
      [PROVIDER]: {
        package: 'aisdk:@ai-sdk/openai-compatible',
        env: [GATEWAY_KEY_ENV],
        settings: { baseURL: w.gateway.baseUrl },
        headers: { 'x-litellm-session-id': w.gateway.sessionId },
        models: { [id]: {} },
      },
    },
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function argsDigest(tool: string, input: unknown): string {
  return createHash('sha256')
    .update(`${tool}\0${stableJson(input)}`)
    .digest('hex')
    .slice(0, 16)
}

type RawEvent = { type?: string; data?: Record<string, unknown> }
type Tokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

function errorMessage(data: Record<string, unknown>): string {
  const e = data.error
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  return typeof data.message === 'string' ? data.message : JSON.stringify(e ?? data).slice(0, 300)
}

export class EventMapper {
  private readonly tools = new Map<string, string>()
  private steps = 0

  constructor(private readonly sessionId: string) {}

  map(raw: unknown): HarnessEvent[] {
    const { type, data } = raw as RawEvent
    if (!type || !data || data.sessionID !== this.sessionId) return []
    switch (type) {
      case 'session.tool.input.started':
        this.tools.set(String(data.id), String(data.name))
        return []
      case 'session.tool.called': {
        const tool = this.tools.get(String(data.id)) ?? 'unknown'
        return [{ kind: 'tool_call', tool, argsDigest: argsDigest(tool, data.input) }]
      }
      case 'session.tool.success':
      case 'session.tool.failed':
        return [
          {
            kind: 'tool_result',
            tool: this.tools.get(String(data.id)) ?? 'unknown',
            ok: type === 'session.tool.success',
          },
        ]
      case 'session.step.ended': {
        const t = (data.tokens ?? {}) as Tokens
        this.steps += 1
        return [
          {
            kind: 'step',
            step: this.steps,
            tokensIn: (t.input ?? 0) + (t.cache?.write ?? 0),
            tokensOut: (t.output ?? 0) + (t.reasoning ?? 0),
          },
        ]
      }
      case 'session.text.ended':
        return [{ kind: 'text', chars: typeof data.text === 'string' ? data.text.length : 0 }]
      case 'session.step.failed':
        return [{ kind: 'error', message: errorMessage(data), fatal: false }]
      case 'session.execution.failed':
        return [{ kind: 'error', message: errorMessage(data), fatal: true }]
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        return [{ kind: 'idle', sinceMs: 0 }]
      default:
        return []
    }
  }
}

export type OpenCodeDriverOptions = {
  sandbox: SandboxDriver
  sessions?: SessionStore
  fetch?: typeof fetch
  heartbeatMs?: Ms
  readyTimeoutMs?: Ms
  reconnects?: number
  now?: () => number
}

export class OpenCodeDriver implements WorkerDriver {
  readonly harness = 'opencode' as const
  private readonly sessions: SessionStore
  private readonly streams = new Map<string, AbortController>()
  private readonly now: () => number

  constructor(private readonly o: OpenCodeDriverOptions) {
    this.sessions = o.sessions ?? memorySessionStore()
    this.now = o.now ?? Date.now
  }

  async start(w: WorkerStart): Promise<WorkerSession> {
    const sb = this.o.sandbox
    const base = w.agent.files.find((f) => f.path === 'opencode.json')
    const config = opencodeConfig(w, base ? (JSON.parse(base.content) as Record<string, unknown>) : {})
    const password = randomBytes(24).toString('hex')
    const files = [
      ...w.agent.files
        .filter((f) => f !== base)
        .map((f) => ({ path: `${OPENCODE_CONFIG_DIR}/${f.path}`, content: f.content })),
      { path: `${OPENCODE_CONFIG_DIR}/opencode.json`, content: `${JSON.stringify(config, null, 2)}\n` },
      { path: PASSWORD_FILE, content: password },
    ]
    for (const f of files) {
      const res = await sb.exec(
        w.sandbox,
        ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', f.path],
        {
          stdin: f.content,
        },
      )
      if (res.exitCode !== 0) throw new Error(`writing ${f.path} failed: ${res.stderrTail}`)
    }
    await sb.exec(w.sandbox, ['rm', '-f', FINISH_FILE])
    await sb.spawn(
      w.sandbox,
      ['opencode-worker', 'serve', '--hostname', '0.0.0.0', '--port', String(OPENCODE_PORT)],
      {
        cwd: w.workdir,
        env: {
          NIGHTSHIFT_WORKER_HOME: WORKER_HOME,
          NIGHTSHIFT_FINISH_PATH: FINISH_FILE,
          OPENCODE_SERVER_PASSWORD: password,
          [GATEWAY_KEY_ENV]: w.gateway.apiKey,
        },
      },
    )
    const { url } = await sb.expose(w.sandbox, OPENCODE_PORT)
    const client = new OpenCodeClient(url, password, this.o.fetch)
    const deadline = this.now() + (this.o.readyTimeoutMs ?? 60_000)
    while (!(await client.ready())) {
      if (this.now() > deadline) throw new Error(`opencode serve did not become ready at ${url}`)
      await Bun.sleep(250)
    }
    const session = await client.createSession({
      agent: w.agent.name,
      model: modelRef(w.model),
      directory: w.workdir,
    })
    this.sessions.save(session.id, { sandbox: w.sandbox, url, password, workdir: w.workdir })
    await client.prompt(session.id, w.taskMessage)
    return { id: session.id, attach: this.attach(w.sandbox, session.id, w.workdir) }
  }

  events(s: WorkerSession): AsyncIterable<HarnessEvent> {
    const conn = this.connection(s)
    const client = this.client(conn)
    const out = new Channel<HarnessEvent>()
    const controller = new AbortController()
    this.streams.get(s.id)?.abort()
    this.streams.set(s.id, controller)
    const mapper = new EventMapper(s.id)
    let idleSince: number | undefined
    const heartbeat = setInterval(() => {
      if (idleSince !== undefined) out.push({ kind: 'idle', sinceMs: this.now() - idleSince })
    }, this.o.heartbeatMs ?? 30_000)
    const finish = async () => {
      const payload = await this.readFinish(conn)
      if (payload === undefined) return false
      out.push({ kind: 'finish', payload })
      out.close()
      return true
    }
    const pump = async () => {
      let failures = 0
      while (!controller.signal.aborted) {
        if (await finish()) return
        try {
          for await (const raw of client.events(controller.signal)) {
            failures = 0
            for (const e of mapper.map(raw)) {
              idleSince = e.kind === 'idle' ? this.now() : undefined
              if (e.kind === 'tool_result' && e.tool === 'finish' && e.ok && (await finish())) return
              out.push(e)
              if (e.kind === 'error' && e.fatal) {
                out.close()
                return
              }
            }
          }
        } catch (e) {
          if (controller.signal.aborted) return
          failures += 1
          if (failures > (this.o.reconnects ?? 5) || !(await client.ready())) {
            out.push({ kind: 'error', message: `event stream lost: ${(e as Error).message}`, fatal: true })
            out.close()
            return
          }
        }
        await Bun.sleep(Math.min(1_000 * failures, 5_000))
      }
    }
    pump()
      .catch((e: Error) => out.push({ kind: 'error', message: e.message, fatal: true }))
      .finally(() => {
        clearInterval(heartbeat)
        controller.abort()
        out.close()
      })
    return out
  }

  async send(s: WorkerSession, message: string): Promise<void> {
    await this.client(this.connection(s)).prompt(s.id, message)
  }

  async stop(s: WorkerSession, _reason: string): Promise<void> {
    this.streams.get(s.id)?.abort()
    this.streams.delete(s.id)
    const conn = this.sessions.load(s.id)
    if (!conn) return
    await this.client(conn)
      .interrupt(s.id)
      .catch(() => undefined)
  }

  async alive(s: WorkerSession): Promise<boolean> {
    const conn = this.sessions.load(s.id)
    if (!conn) return false
    try {
      await this.client(conn).session(s.id)
      return true
    } catch {
      return false
    }
  }

  attachInfo(session: string): AttachInfo | undefined {
    const conn = this.sessions.load(session)
    if (!conn) return undefined
    return {
      url: conn.url,
      password: conn.password,
      session,
      workdir: conn.workdir,
      fallback: this.attach(conn.sandbox, session, conn.workdir),
      shell: this.o.sandbox.attachCommand(conn.sandbox, ['bash']),
    }
  }

  private async readFinish(conn: SessionConnection): Promise<unknown> {
    const res = await this.o.sandbox.exec(conn.sandbox, ['cat', FINISH_FILE])
    if (res.exitCode !== 0) return undefined
    try {
      return JSON.parse(res.stdoutTail)
    } catch {
      return { invalid: res.stdoutTail.slice(0, 300) }
    }
  }

  private attach(h: SandboxHandle, session: string, workdir: string): string[] {
    return this.o.sandbox.attachCommand(h, [
      'sh',
      '-c',
      `NIGHTSHIFT_WORKER_HOME=${WORKER_HOME} OPENCODE_SERVER_PASSWORD="$(cat ${PASSWORD_FILE})" exec opencode-worker --server http://127.0.0.1:${OPENCODE_PORT} --session ${session} ${workdir}`,
    ])
  }

  private connection(s: WorkerSession): SessionConnection {
    const conn = this.sessions.load(s.id)
    if (!conn) throw new Error(`unknown OpenCode session ${s.id}`)
    return conn
  }

  private client(conn: SessionConnection): OpenCodeClient {
    return new OpenCodeClient(conn.url, conn.password, this.o.fetch)
  }
}
