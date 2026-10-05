import { chmodSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type Config,
  expandHome,
  type JsonSchema,
  NIGHTSHIFT_VERSION,
  outputValidator,
} from '@nightshift/core'
import type { ControlSupervisor } from '../../ports/control'
import type { Run } from '../../state/runs'
import type {
  AnswerRequest,
  AttachInfo,
  CoverRequest,
  Health,
  PauseRequest,
  RetryRequest,
  SendRequest,
  StopRequest,
} from '../generated/control'
import { ControlError, type ErrorCode } from './errors'

export const SOCKET_FILE = 'nightshift.sock'

export const CONTROL_SCHEMA_PATH = join(import.meta.dir, '../../../schema/control.schema.json')

export function socketPath(config: Pick<Config, 'paths'>, home: string = homedir()): string {
  return join(expandHome(config.paths.state, home), SOCKET_FILE)
}

export type { ControlSupervisor } from '../../ports/control'

export type ControlOptions = {
  attach?: (run: Run) => AttachInfo | undefined
  version?: string
}

export type ControlServer = { path: string; close(): void }

const STATUS: Record<ErrorCode, number> = { bad_request: 400, not_found: 404, refused: 409, internal: 500 }

let schema: JsonSchema | undefined
const validators = new Map<string, ReturnType<typeof outputValidator>>()

function validator(def: string): ReturnType<typeof outputValidator> {
  schema ??= JSON.parse(readFileSync(CONTROL_SCHEMA_PATH, 'utf8')) as JsonSchema
  let v = validators.get(def)
  if (!v) {
    const { $id: _, $schema: __, properties: ___, ...rest } = schema
    v = outputValidator({ ...rest, $ref: `#/$defs/${def}` })
    validators.set(def, v)
  }
  return v
}

async function body<T>(req: Request, def: string): Promise<T> {
  let value: unknown
  try {
    const text = await req.text()
    value = text ? JSON.parse(text) : {}
  } catch {
    throw new ControlError('bad_request', 'body is not JSON')
  }
  const issue = validator(def)(value)[0]
  if (issue) {
    const where = issue.path.length ? issue.path.join('.') : 'body'
    throw new ControlError('bad_request', `${where}: ${issue.message}`)
  }
  return value as T
}

function failure(code: ErrorCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status: STATUS[code] })
}

export function controlHandler(
  sup: ControlSupervisor,
  opts: ControlOptions = {},
): (req: Request) => Promise<Response> {
  const by = 'cli' as const
  const routes: Record<string, (req: Request) => Promise<unknown>> = {
    'GET /health': async (): Promise<Health> => ({
      dispatch: sup.status().dispatch,
      gateway: sup.gateway(),
      version: opts.version ?? NIGHTSHIFT_VERSION,
    }),
    'POST /pause': async (req) => {
      const { issue } = await body<PauseRequest>(req, 'pauseRequest')
      if (issue) sup.hold(issue, by)
      else sup.pause('ns pause', by)
      return { ok: true }
    },
    'POST /resume': async (req) => {
      const { issue } = await body<PauseRequest>(req, 'pauseRequest')
      if (issue) sup.unhold(issue, by)
      else sup.resume('ns resume', by)
      return { ok: true }
    },
    'POST /cover': async (req) => {
      const { issue, covered } = await body<CoverRequest>(req, 'coverRequest')
      if (covered) sup.cover(issue, by)
      else sup.uncover(issue, by)
      return { ok: true }
    },
    'POST /send': async (req) => {
      const { target, message } = await body<SendRequest>(req, 'sendRequest')
      await sup.sendMessage(target, message, by)
      return { ok: true }
    },
    'POST /answer': async (req) => {
      const { issue, text } = await body<AnswerRequest>(req, 'answerRequest')
      await sup.answerQuestion(issue, text, by)
      return { ok: true }
    },
    'POST /stop': async (req) => {
      const { target, reason } = await body<StopRequest>(req, 'stopRequest')
      return { run: (await sup.stopForUser(target, reason, by)).id }
    },
    'POST /retry': async (req) => {
      const { target, agent, profile, continue: cont } = await body<RetryRequest>(req, 'retryRequest')
      const run = await sup.retryRun(
        target,
        { ...(agent ? { agent } : {}), ...(profile ? { profile } : {}), ...(cont ? { continue: true } : {}) },
        by,
      )
      return { run: run.id }
    },
  }
  const attach = async (target: string): Promise<AttachInfo> => {
    const run = sup.resolveRun(target)
    const info = run && run.state === 'running' ? opts.attach?.(run) : undefined
    if (!info) throw new ControlError('not_found', `no active run for ${target}`)
    return info
  }

  return async (req) => {
    const { pathname } = new URL(req.url)
    try {
      const attachMatch = req.method === 'GET' ? pathname.match(/^\/runs\/([^/]+)\/attach$/) : null
      if (attachMatch) return Response.json(await attach(decodeURIComponent(attachMatch[1] as string)))
      const route = routes[`${req.method} ${pathname}`]
      if (!route) return failure('not_found', `no route ${req.method} ${pathname}`)
      return Response.json(await route(req))
    } catch (e) {
      if (e instanceof ControlError) return failure(e.code, e.message)
      return failure('internal', (e as Error).message)
    }
  }
}

export function serveControl(sup: ControlSupervisor, path: string, opts: ControlOptions = {}): ControlServer {
  rmSync(path, { force: true })
  const fetch = controlHandler(sup, opts)
  const previous = process.umask(0o177)
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({ unix: path, fetch })
  } finally {
    process.umask(previous)
  }
  chmodSync(path, 0o600)
  return {
    path,
    close() {
      server.stop(true)
      rmSync(path, { force: true })
    },
  }
}
