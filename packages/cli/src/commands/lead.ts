import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { CliError, type Ctx, EXIT, parseArgs } from '../cli'
import { DETACH_HINT, withPlainKeys } from '../keys'

export const LEAD_USAGE = 'ns lead [--full] | ns lead serve'
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

async function open(ctx: Ctx, full: boolean): Promise<number> {
  const config = ctx.config()
  const url = leadUrl(config)
  const file = leadPaths(config, home(ctx)).password
  const password = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  if (!password || !(await new OpenCodeClient(url, password, ctx.fetch).ready()))
    throw new CliError(EXIT.down, `the lead is not running at ${url}; ${LEAD_START_HINT}`)
  if (ctx.which('opencode') === null) throw new CliError(EXIT.error, 'opencode is not installed on this host')
  const tui = leadTui(url, password, full)
  ctx.io.err(DETACH_HINT)
  const code = await withPlainKeys(ctx.env, ctx.capture, () => ctx.exec(tui.cmd, { env: tui.env }))
  return code === 0 ? EXIT.ok : code
}

export async function lead(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals, bools } = parseArgs(args, { bools: ['--full'] }, LEAD_USAGE)
  if (positionals.length === 0) return open(ctx, bools.has('--full'))
  if (positionals[0] === 'serve' && positionals.length === 1 && bools.size === 0) return serve(ctx)
  throw new CliError(EXIT.usage, `usage: ${LEAD_USAGE}`)
}
