import { type Config, formatError, type LoadResult, loadConfig } from '@nightshift/core'
import { socketPath, statePath } from '@nightshift/supervisor'
import { type ControlFn, control as unixControl } from './client'

export type Io = { out: (line: string) => void; err: (line: string) => void }

export const EXIT = { ok: 0, error: 1, usage: 2, down: 3, notFound: 4, refused: 5 } as const

export class CliError extends Error {
  override name = 'CliError'

  constructor(
    readonly exit: number,
    message: string,
  ) {
    super(message)
  }
}

export type Exec = (
  cmd: string[],
  opts?: { env?: Record<string, string | undefined>; cwd?: string },
) => Promise<number>

export type Capture = (
  cmd: string[],
  opts?: { cwd?: string },
) => { exitCode: number; stdout: string; stderr: string }

export type GlobalFlags = {
  json: boolean
  noColor: boolean
  yes: boolean
  config?: string
  host?: string
}

export type CommandDeps = {
  load?: (opts?: { user?: string }) => LoadResult
  statePath?: () => string
  socketPath?: () => string
  control?: ControlFn
  exec?: Exec
  capture?: Capture
  confirm?: (question: string) => Promise<boolean>
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  stdoutIsTTY?: boolean
  env?: Record<string, string | undefined>
  httpFetch?: typeof fetch
  signal?: AbortSignal
  self?: string[]
  which?: (cmd: string) => string | null
}

export type Ctx = {
  io: Io
  flags: GlobalFlags
  color: boolean
  config(): Config
  statePath(): string
  socketPath(): string
  control: ControlFn
  exec: Exec
  capture: Capture
  confirm(question: string): Promise<boolean>
  now(): Date
  sleep(ms: number): Promise<void>
  env: Record<string, string | undefined>
  fetch: typeof fetch
  signal: AbortSignal | undefined
  self: string[]
  which(cmd: string): string | null
  stdoutIsTTY: boolean
}

const GLOBAL_VALUE = new Set(['--config', '--host'])
const GLOBAL_BOOL: Record<string, keyof GlobalFlags> = {
  '--json': 'json',
  '--no-color': 'noColor',
  '--yes': 'yes',
  '-y': 'yes',
}

export function parseGlobal(args: string[]): { flags: GlobalFlags; rest: string[] } {
  const flags: GlobalFlags = { json: false, noColor: false, yes: false }
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--') {
      rest.push(...args.slice(i))
      break
    }
    const [name, inline] = a.startsWith('--') && a.includes('=') ? a.split(/=(.*)/s, 2) : [a, undefined]
    if (GLOBAL_VALUE.has(name as string)) {
      const value = inline ?? args[++i]
      if (value === undefined) throw new CliError(EXIT.usage, `${name} needs a value`)
      if (name === '--config') flags.config = value
      else flags.host = value
      continue
    }
    const bool = GLOBAL_BOOL[a]
    if (bool) {
      ;(flags as Record<string, unknown>)[bool] = true
      continue
    }
    rest.push(a)
  }
  return { flags, rest }
}

export function withoutValueFlags(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') return [...out, ...argv.slice(i)]
    if (GLOBAL_VALUE.has(a)) i++
    else if (![...GLOBAL_VALUE].some((f) => a.startsWith(`${f}=`))) out.push(a)
  }
  return out
}

export type ArgSpec = {
  values?: readonly string[]
  bools?: readonly string[]
  repeat?: readonly string[]
  aliases?: Record<string, string>
}

export type Parsed = {
  positionals: string[]
  values: Record<string, string>
  bools: Set<string>
  lists: Record<string, string[]>
}

export function parseArgs(args: string[], spec: ArgSpec, usage: string): Parsed {
  const parsed: Parsed = { positionals: [], values: {}, bools: new Set(), lists: {} }
  for (let i = 0; i < args.length; i++) {
    const raw = args[i] as string
    if (raw === '--') {
      parsed.positionals.push(...args.slice(i + 1))
      break
    }
    if (!raw.startsWith('-') || raw === '-') {
      parsed.positionals.push(raw)
      continue
    }
    const [flag, inline] =
      raw.startsWith('--') && raw.includes('=') ? raw.split(/=(.*)/s, 2) : [raw, undefined]
    const name = spec.aliases?.[flag as string] ?? (flag as string)
    if (spec.bools?.includes(name)) {
      parsed.bools.add(name)
      continue
    }
    if (spec.values?.includes(name) || spec.repeat?.includes(name)) {
      const value = inline ?? args[++i]
      if (value === undefined) throw new CliError(EXIT.usage, `${name} needs a value\n${usage}`)
      if (spec.repeat?.includes(name)) parsed.lists[name] = [...(parsed.lists[name] ?? []), value]
      else parsed.values[name] = value
      continue
    }
    throw new CliError(EXIT.usage, `unknown option ${flag}\n${usage}`)
  }
  return parsed
}

export function useColor(flags: GlobalFlags, env: Record<string, string | undefined>, tty: boolean): boolean {
  return tty && !flags.json && !flags.noColor && env.NO_COLOR === undefined
}

const CODES = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, dim: 2, bold: 1 } as const

export type Paint = (color: keyof typeof CODES, text: string) => string

export function paint(enabled: boolean): Paint {
  return (color, text) => (enabled ? `\x1b[${CODES[color]}m${text}\x1b[0m` : text)
}

async function promptYes(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  process.stdout.write(`${question} [y/N] `)
  for await (const line of console) return /^y(es)?$/i.test(line.trim())
  return false
}

export function defaultExec(): Exec {
  return async (cmd, opts = {}) => {
    const proc = Bun.spawn(cmd, {
      stdio: ['inherit', 'inherit', 'inherit'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { ...process.env, ...opts.env },
    })
    return proc.exited
  }
}

export const defaultCapture: Capture = (cmd, opts = {}) => {
  const r = Bun.spawnSync(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  })
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

export function createCtx(io: Io, flags: GlobalFlags, deps: CommandDeps): Ctx {
  let config: Config | undefined
  const env = deps.env ?? process.env
  const tty = deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY)
  const loadConfigOnce = (): Config => {
    if (config) return config
    const result = (deps.load ?? loadConfig)(flags.config ? { user: flags.config } : {})
    if (!result.ok)
      throw new CliError(EXIT.error, result.errors.map((e) => `config: ${formatError(e)}`).join('\n'))
    config = result.config
    return config
  }
  return {
    io,
    flags,
    color: useColor(flags, env, tty),
    config: loadConfigOnce,
    statePath: () => deps.statePath?.() ?? statePath(loadConfigOnce()),
    socketPath: () => deps.socketPath?.() ?? socketPath(loadConfigOnce()),
    control: deps.control ?? unixControl,
    exec: deps.exec ?? defaultExec(),
    capture: deps.capture ?? defaultCapture,
    confirm: async (q) => flags.yes || (await (deps.confirm ?? promptYes)(q)),
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
    env,
    fetch: deps.httpFetch ?? fetch,
    signal: deps.signal,
    self: deps.self ?? [process.execPath, ...(process.argv[1] ? [process.argv[1]] : [])],
    which: deps.which ?? ((cmd) => Bun.which(cmd)),
    stdoutIsTTY: tty,
  }
}

export function printJson(ctx: Ctx, value: unknown): void {
  ctx.io.out(JSON.stringify(value, null, 2))
}

export function requireArg(value: string | undefined, usage: string): string {
  if (value === undefined || value === '') throw new CliError(EXIT.usage, `usage: ${usage}`)
  return value
}
