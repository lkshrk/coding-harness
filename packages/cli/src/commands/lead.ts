import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  AgentConfigError,
  buildGuardPlugin,
  type Config,
  expandHome,
  loadAgents,
  NIGHTSHIFT_ROOT,
  renderAgent,
  renderContext,
  renderGuardPlugin,
  resolveAlias,
  SecretResolver,
  withCredentials,
} from '@nightshift/core'
import { hostSkills, OpenCodeClient, PROVIDER, skillFiles } from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, paint, parseArgs } from '../cli'
import { DETACH_HINT, withPlainKeys } from '../keys'
import { Dock, type DockInput, type DockOutput, dockLines } from '../render/dock'
import { SessionRenderer } from '../render/session'
import type { Part } from '../render/status'
import { duration } from './shared'
import { statusRecord } from './status'
import { terminalWidth } from './tail'

export const LEAD_USAGE = 'ns lead [--tui] [--full] | ns lead serve'
export const LEAD_KEY_ENV = 'NIGHTSHIFT_LEAD_KEY'
export const LEAD_START_HINT = 'start it with ns up, or systemctl --user start nightshift-lead.service'

const HOSTNAME = '127.0.0.1'

export function leadPaths(config: Config, home: string) {
  const dir = join(expandHome(config.paths.state, home), 'lead')
  return {
    dir,
    configDir: join(dir, 'config/opencode'),
    password: join(dir, 'server-password'),
    models: join(dir, 'models.json'),
  }
}

const leadUrl = (config: Config) => `http://${HOSTNAME}:${config.lead.port}`

function home(ctx: Ctx): string {
  return ctx.env.HOME ?? homedir()
}

export async function renderLead(
  config: Config,
  configDir: string,
  root: string = NIGHTSHIFT_ROOT,
): Promise<{ path: string; content: string }[]> {
  const agentsDir = join(root, 'agents')
  const { agents } = loadAgents(agentsDir, {
    root,
    profiles: config.profiles,
    externalSkills: [...hostSkills(agentsDir), 'wiki-ingest'],
  })
  const def = agents.get('lead')
  if (!def) throw new CliError(EXIT.error, `no lead agent in ${agentsDir}`)
  const context = renderContext(config)
  const rendered = renderAgent(def, context)
  const guard = renderGuardPlugin([def], configDir, await buildGuardPlugin())
  const skills = def.skills.flatMap((s) =>
    skillFiles(join(root, 'skills', s)).map((f) => ({ path: `skills/${s}/${f.path}`, content: f.content })),
  )
  const id = resolveAlias(def, context.profile)
  const opencode = {
    $schema: 'https://opencode.ai/config.json',
    update: 'disable',
    share: 'disabled',
    model: `${PROVIDER}/${id}`,
    default_agent: def.name,
    plugins: guard ? [guard.plugin] : [],
    skills: { paths: [join(configDir, 'skills')] },
    providers: {
      [PROVIDER]: {
        package: 'aisdk:@ai-sdk/openai-compatible',
        env: [LEAD_KEY_ENV],
        settings: { baseURL: config.gateway.base_url },
        models: { [id]: {} },
      },
    },
    mcp: {
      servers: {
        gateway: {
          type: 'remote',
          url: new URL('/mcp', config.gateway.base_url).href,
          oauth: false,
          headers: { Authorization: `Bearer {env:${LEAD_KEY_ENV}}` },
        },
      },
    },
  }
  return [
    { path: rendered.path, content: rendered.content },
    ...(guard?.files ?? []),
    ...skills,
    { path: 'opencode.json', content: `${JSON.stringify(opencode, null, 2)}\n` },
  ]
}

async function serve(ctx: Ctx): Promise<number> {
  const config = ctx.config()
  const paths = leadPaths(config, home(ctx))
  let files: { path: string; content: string }[]
  try {
    files = await renderLead(config, paths.configDir)
  } catch (e) {
    if (e instanceof AgentConfigError) throw new CliError(EXIT.error, e.message)
    throw e
  }
  const secrets = new SecretResolver({
    env: withCredentials(ctx.env),
    rbwProfile: config.secrets.rbw_profile,
  })
  const key = await secrets.resolve(config.gateway.api_key)
  rmSync(paths.configDir, { recursive: true, force: true })
  for (const f of files) {
    const target = join(paths.configDir, f.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, f.content)
  }
  // An empty catalog keeps built-in providers out of the model list.
  if (!existsSync(paths.models)) writeFileSync(paths.models, '{}\n')
  const password = randomBytes(24).toString('hex')
  writeFileSync(paths.password, password, { mode: 0o600 })
  chmodSync(paths.password, 0o600)
  ctx.io.err(`nightshift lead serving at ${leadUrl(config)} (config ${paths.configDir})`)
  return ctx.exec(['opencode', 'serve', '--hostname', HOSTNAME, '--port', String(config.lead.port)], {
    env: {
      OPENCODE_CONFIG_DIR: paths.configDir,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_MODELS_PATH: paths.models,
      OPENCODE_SERVER_PASSWORD: password,
      [LEAD_KEY_ENV]: key,
    },
  })
}

export function leadTui(url: string, password: string, full = false) {
  return {
    cmd: ['opencode', ...(full ? [] : ['mini']), '--server', url],
    env: { OPENCODE_PASSWORD: password },
  }
}

export function workersParts(r: Awaited<ReturnType<typeof statusRecord>>): Part[] {
  const workers = 'workers' in r ? r.workers : []
  if (!workers.length)
    return [['dim', r.supervisor === 'down' ? 'supervisor not running' : 'no running workers']]
  return workers.flatMap((w, i): Part[] => [
    ...(i ? [['dim', ' · '] as Part] : []),
    ['issue', w.issue],
    ['dim', ' '],
    ['agent', w.agent],
    ['dim', ' '],
    ['time', duration(w.elapsed_ms)],
  ])
}

export async function leadSession(client: OpenCodeClient): Promise<string> {
  const [newest] = await client.sessions(1)
  return newest ? newest.id : (await client.createSession()).id
}

export type Lines = (signal: AbortSignal) => AsyncIterable<string>
export type ChatInput = { lines: Lines; around?: (write: () => void) => void }

export type ChatTerminal = Required<ChatInput> & {
  dock: Dock | null
  print: (line: string) => void
  close: () => void
}

// On a terminal the input line and the worker status line are pinned to the bottom two rows.
export function terminalInput(
  input: DockInput = process.stdin,
  output: DockOutput = process.stdout,
  color = true,
): ChatTerminal {
  const tty = Boolean(output.isTTY && input.isTTY !== false && (output.rows ?? 0) >= 4)
  if (!tty) {
    const lines = async function* (signal: AbortSignal): AsyncGenerator<string> {
      const r = createInterface({ input, terminal: false })
      const close = () => r.close()
      signal.addEventListener('abort', close, { once: true })
      try {
        for await (const line of r) yield line
      } finally {
        signal.removeEventListener('abort', close)
        r.close()
      }
    }
    return {
      dock: null,
      lines,
      around: (write) => write(),
      print: (line) => output.write(`${line}\n`),
      close: () => {},
    }
  }
  const dock = new Dock(output, color)
  const onResize = () => dock.layout()
  output.on('resize', onResize)
  dock.start()
  return {
    dock,
    lines: (signal) => dockLines(input, dock, signal),
    around: (write) => write(),
    print: (line) => dock.print(line),
    close: () => {
      output.off('resize', onResize)
      dock.stop()
    },
  }
}

// Leaving the view only drops this client; the session keeps running on the lead service.
export async function chatView(
  ctx: Ctx,
  client: OpenCodeClient,
  session: string,
  input: Lines | ChatInput | ChatTerminal,
): Promise<number> {
  const { lines, around = (write: () => void) => write() } =
    typeof input === 'function' ? { lines: input } : input
  const print = typeof input !== 'function' && 'print' in input ? input.print : undefined
  const out = (line: string) => around(() => (print ? print(line) : ctx.io.out(line)))
  const err = (line: string) => around(() => (print ? print(line) : ctx.io.err(line)))
  const stop = new AbortController()
  const signal = AbortSignal.any(ctx.signal ? [ctx.signal, stop.signal] : [stop.signal])
  const renderer = new SessionRenderer(session, paint(ctx.color), terminalWidth())
  const stream = (async () => {
    try {
      for await (const raw of client.events(signal)) for (const line of renderer.feed(raw)) out(line)
      if (!signal.aborted) err('(lead connection closed)')
    } catch (e) {
      if (!signal.aborted) err(`(lead connection lost: ${(e as Error).message})`)
    }
    for (const line of renderer.flush()) out(line)
    stop.abort()
  })()
  try {
    for await (const line of lines(signal)) {
      if (signal.aborted) break
      const text = line.trim()
      if (!text) continue
      try {
        await client.prompt(session, text)
      } catch (e) {
        err(`prompt not sent: ${(e as Error).message}`)
      }
    }
  } finally {
    stop.abort()
    await stream
  }
  return EXIT.ok
}

async function chat(ctx: Ctx, client: OpenCodeClient): Promise<number> {
  const session = await leadSession(client)
  ctx.io.err(`lead session ${session}; type a message and press Enter, ctrl+c or ctrl+d leaves`)
  const interrupt = new AbortController()
  const onInt = () => interrupt.abort()
  process.once('SIGINT', onInt)
  const signal = AbortSignal.any(ctx.signal ? [ctx.signal, interrupt.signal] : [interrupt.signal])
  const term = terminalInput(process.stdin, process.stdout, ctx.color)
  const refresh = async () => {
    try {
      term.dock?.setFooter(workersParts(await statusRecord(ctx)))
    } catch {}
  }
  void refresh()
  const timer = term.dock ? setInterval(refresh, 2000) : undefined
  try {
    return await chatView({ ...ctx, signal }, client, session, term)
  } finally {
    if (timer) clearInterval(timer)
    term.close()
    process.off('SIGINT', onInt)
  }
}

async function open(ctx: Ctx, tui: boolean, full: boolean): Promise<number> {
  const config = ctx.config()
  const url = leadUrl(config)
  const file = leadPaths(config, home(ctx)).password
  const password = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  const client = new OpenCodeClient(url, password, ctx.fetch)
  if (!password || !(await client.ready()))
    throw new CliError(EXIT.down, `the lead is not running at ${url}; ${LEAD_START_HINT}`)
  if (!tui) return chat(ctx, client)
  if (ctx.which('opencode') === null) throw new CliError(EXIT.error, 'opencode is not installed on this host')
  const cmd = leadTui(url, password, full)
  ctx.io.err(DETACH_HINT)
  const code = await withPlainKeys(ctx.env, ctx.capture, () => ctx.exec(cmd.cmd, { env: cmd.env }))
  return code === 0 ? EXIT.ok : code
}

export async function lead(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals, bools } = parseArgs(args, { bools: ['--tui', '--full'] }, LEAD_USAGE)
  if (positionals.length === 0)
    return open(ctx, bools.has('--tui') || bools.has('--full'), bools.has('--full'))
  if (positionals[0] === 'serve' && positionals.length === 1 && bools.size === 0) return serve(ctx)
  throw new CliError(EXIT.usage, `usage: ${LEAD_USAGE}`)
}
