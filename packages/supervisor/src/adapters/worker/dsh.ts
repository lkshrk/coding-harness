import { FINISH_MCP_SERVER, FINISH_MCP_TOOL } from '@nightshift/core'
import type {
  HarnessEvent,
  Ms,
  SandboxDriver,
  SandboxHandle,
  WorkerDriver,
  WorkerSession,
  WorkerStart,
} from '../../ports'
import { Channel } from './channel'
import { DshEventMapper } from './dsh-events'
import { modelRef } from './opencode'
import { memorySessionStore, type SessionConnection, type SessionStore } from './opencode-session'

export const DSH_HOME = '/tmp/nightshift-dsh'
export const DSH_FINISH_FILE = `${DSH_HOME}/finish.json`
export const DSH_EVENTS = `${DSH_HOME}/events.ndjson`
const PATCH = `${DSH_HOME}/patch.yml`
const MESSAGE = `${DSH_HOME}/message.md`
const FINISH_MCP = `${DSH_HOME}/finish-mcp.mjs`
const PID_FILE = `${DSH_HOME}/pid`
const KEY_ENV = 'NIGHTSHIFT_GATEWAY_KEY'
const BATCH = 150

const quote = (v: string) => JSON.stringify(v)

export function dshPatch(
  w: Pick<WorkerStart, 'model' | 'gateway' | 'workdir'>,
  o: { prompt?: string; contextWindow?: number } = {},
) {
  const { id } = modelRef(w.model)
  return [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      litellm:',
    '        api: openai-completions',
    `        baseURL: ${quote(w.gateway.baseUrl)}`,
    `        apiKeyEnv: ${KEY_ENV}`,
    '        headers:',
    `          x-litellm-session-id: ${quote(w.gateway.sessionId)}`,
    '        compat:',
    '          supportsDeveloperRole: false',
    '          maxTokensField: max_tokens',
    '        models:',
    `          - id: ${quote(id)}`,
    `            contextWindow: ${o.contextWindow ?? 200_000}`,
    '            maxTokens: 16384',
    '- id: agent-default-model',
    '  config:',
    '    provider: litellm',
    `    model: ${quote(id)}`,
    '- id: session-log-deepseek',
    '  config:',
    '    enabled: false',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: web-search-deepseek',
    '  disabled: true',
    '- id: otel',
    '  disabled: true',
    ...(o.prompt ? ['- id: system-prompt', '  config:', `    personaSuffix: ${quote(o.prompt)}`] : []),
    '- insert:',
    `    - id: mcp-${FINISH_MCP_SERVER}`,
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        transport: stdio',
    `        serverName: ${FINISH_MCP_SERVER}`,
    '        command: node',
    `        args: [${quote(FINISH_MCP)}]`,
    '        env:',
    `          NIGHTSHIFT_FINISH_PATH: ${quote(DSH_FINISH_FILE)}`,
    `        cwd: ${quote(w.workdir)}`,
    '        toolCallTimeoutMs: 30000',
    '        failOnStartupError: true',
    '',
  ].join('\n')
}

function agentPrompt(w: WorkerStart): string | undefined {
  const file = w.agent.files.find((f) => f.path === `agent/${w.agent.name}.md`)
  return file?.content.replace(/^---\n[\s\S]*?\n---\n/, '').trim() || undefined
}

export type DshDriverOptions = {
  sandbox: SandboxDriver
  finishMcp: string
  sessions?: SessionStore
  pollMs?: Ms
  heartbeatMs?: Ms
  now?: () => number
}

export class DshDriver implements WorkerDriver {
  readonly harness = 'dsh' as const
  private readonly sessions: SessionStore
  private readonly keys = new Map<string, string>()
  private readonly streams = new Map<string, AbortController>()
  private readonly now: () => number

  constructor(private readonly o: DshDriverOptions) {
    this.sessions = o.sessions ?? memorySessionStore()
    this.now = o.now ?? Date.now
  }

  async start(w: WorkerStart): Promise<WorkerSession> {
    const sb = this.o.sandbox
    const prompt = agentPrompt(w)
    const files = [
      { path: PATCH, content: dshPatch(w, prompt ? { prompt } : {}) },
      { path: FINISH_MCP, content: this.o.finishMcp },
      { path: MESSAGE, content: w.taskMessage },
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
    await sb.exec(w.sandbox, ['rm', '-f', DSH_FINISH_FILE, DSH_EVENTS, PID_FILE])
    await this.launch(w.sandbox, w.workdir, w.gateway.apiKey, [])
    const id = await this.sessionId(w.sandbox)
    this.keys.set(id, w.gateway.apiKey)
    this.sessions.save(id, { sandbox: w.sandbox, url: '', password: '', workdir: w.workdir })
    return { id, attach: sb.attachCommand(w.sandbox, ['sh', '-c', `tail -n +1 -F ${DSH_EVENTS}`]) }
  }

  events(s: WorkerSession): AsyncIterable<HarnessEvent> {
    const conn = this.connection(s)
    const out = new Channel<HarnessEvent>()
    const controller = new AbortController()
    this.streams.get(s.id)?.abort()
    this.streams.set(s.id, controller)
    const mapper = new DshEventMapper()
    let idleSince: number | undefined
    const heartbeat = setInterval(() => {
      if (idleSince !== undefined) out.push({ kind: 'idle', sinceMs: this.now() - idleSince })
    }, this.o.heartbeatMs ?? 30_000)
    const pump = async () => {
      let line = 1
      while (!controller.signal.aborted) {
        const res = await this.o.sandbox.exec(conn.sandbox, [
          'sh',
          '-c',
          'tail -n +"$1" "$2" 2>/dev/null | head -n "$3"',
          'sh',
          String(line),
          DSH_EVENTS,
          String(BATCH),
        ])
        const lines = res.stdoutTail.split('\n').filter((l) => l.endsWith('}'))
        for (const text of lines) {
          line += 1
          let raw: unknown
          try {
            raw = JSON.parse(text)
          } catch {
            continue
          }
          for (const e of mapper.map(raw)) {
            idleSince = e.kind === 'idle' ? this.now() : undefined
            if (e.kind === 'tool_result' && e.tool === FINISH_MCP_TOOL && e.ok) {
              const payload = await this.readFinish(conn.sandbox)
              if (payload !== undefined) {
                out.push({ kind: 'finish', payload })
                return
              }
            }
            out.push(e)
            if (e.kind === 'error' && e.fatal) return
          }
        }
        if (lines.length < BATCH) {
          if (idleSince !== undefined) {
            const payload = await this.readFinish(conn.sandbox)
            if (payload !== undefined) {
              out.push({ kind: 'finish', payload })
              return
            }
          }
          await Bun.sleep(this.o.pollMs ?? 1_000)
        }
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
    const conn = this.connection(s)
    const key = this.keys.get(s.id)
    if (!key) throw new Error(`no gateway key for dsh session ${s.id}; restart the run`)
    const res = await this.o.sandbox.exec(conn.sandbox, ['sh', '-c', 'cat > "$1"', 'sh', MESSAGE], {
      stdin: message,
    })
    if (res.exitCode !== 0) throw new Error(`writing message failed: ${res.stderrTail}`)
    await this.launch(conn.sandbox, conn.workdir, key, ['--session-id', s.id])
  }

  async stop(s: WorkerSession, _reason: string): Promise<void> {
    this.streams.get(s.id)?.abort()
    this.streams.delete(s.id)
    const conn = this.sessions.load(s.id)
    if (!conn) return
    await this.o.sandbox
      .exec(conn.sandbox, ['sh', '-c', 'kill -TERM "$(cat "$1")" 2>/dev/null; true', 'sh', PID_FILE])
      .catch(() => undefined)
  }

  async alive(s: WorkerSession): Promise<boolean> {
    const conn = this.sessions.load(s.id)
    if (!conn) return false
    const res = await this.o.sandbox.exec(conn.sandbox, ['test', '-f', DSH_EVENTS]).catch(() => undefined)
    return res?.exitCode === 0
  }

  private async launch(h: SandboxHandle, workdir: string, key: string, extra: string[]): Promise<void> {
    const proc = await this.o.sandbox.spawn(
      h,
      [
        'sh',
        '-c',
        'p=$1 m=$2 e=$3; shift 3; exec dsh-worker --profile headless --patch "$p" --json "$@" - < "$m" >> "$e" 2>> "$e.err"',
        'sh',
        PATCH,
        MESSAGE,
        DSH_EVENTS,
        ...extra,
      ],
      { cwd: workdir, env: { NIGHTSHIFT_WORKER_HOME: DSH_HOME, [KEY_ENV]: key } },
    )
    await this.o.sandbox.exec(h, ['sh', '-c', 'printf %s "$1" > "$2"', 'sh', proc.pid, PID_FILE])
  }

  private async sessionId(h: SandboxHandle): Promise<string> {
    const deadline = this.now() + 60_000
    while (this.now() < deadline) {
      const res = await this.o.sandbox.exec(h, ['sh', '-c', 'head -n 1 "$1" 2>/dev/null', 'sh', DSH_EVENTS])
      const first = res.stdoutTail.trim()
      if (first) {
        const id = (JSON.parse(first) as { sessionId?: string }).sessionId
        if (id) return id
      }
      await Bun.sleep(250)
    }
    throw new Error('dsh did not report a session within 60s')
  }

  private async readFinish(h: SandboxHandle): Promise<unknown> {
    const res = await this.o.sandbox.exec(h, ['cat', DSH_FINISH_FILE])
    if (res.exitCode !== 0) return undefined
    try {
      return JSON.parse(res.stdoutTail)
    } catch {
      return { invalid: res.stdoutTail.slice(0, 300) }
    }
  }

  private connection(s: WorkerSession): SessionConnection {
    const conn = this.sessions.load(s.id)
    if (!conn) throw new Error(`unknown dsh session ${s.id}`)
    return conn
  }
}
