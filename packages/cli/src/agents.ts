import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  AgentConfigError,
  type AgentDef,
  type Config,
  DEFAULTS_PATH,
  formatAgentError,
  formatError,
  loadAgents,
  loadConfig,
  NIGHTSHIFT_ROOT,
  parseConfigSection,
  renderAgent,
  renderAgentConfig,
  renderContext,
} from '@nightshift/core'
import { CliError, type CommandDeps, type Ctx, EXIT, parseArgs } from './cli'

export const AGENTS_USAGE = 'usage: ns agents lint | ns agents render <agent> [--profile <name>]'

export type AgentsDeps = Pick<CommandDeps, 'load'> & { agentsRoot?: string }

type AgentsConfig = Pick<Config, 'profiles' | 'policies' | 'limits'>

const EXTERNAL_SKILLS = ['wiki-ingest']

function repositoryConfig(profile: string | undefined): AgentsConfig {
  const read = (file: string): Record<string, unknown> => Bun.YAML.parse(readFileSync(file, 'utf8')) as never
  const defaults = read(DEFAULTS_PATH)
  const dir = join(NIGHTSHIFT_ROOT, 'config/profiles')
  const entries = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.yaml'))
        .sort()
        .map((f) => [basename(f, '.yaml'), read(join(dir, f))] as const)
    : []
  const active = profile ?? entries[0]?.[0]
  if (active === undefined) throw new CliError(EXIT.error, `no profiles in ${dir}`)
  return {
    profiles: parseConfigSection('profiles', { active, memory_budget_gb: 1, ...Object.fromEntries(entries) }),
    policies: parseConfigSection('policies', defaults.policies),
    limits: parseConfigSection('limits', defaults.limits),
  }
}

function config(ctx: Ctx, deps: AgentsDeps, profile: string | undefined) {
  const result = (deps.load ?? loadConfig)(ctx.flags.config ? { user: ctx.flags.config } : {})
  if (result.ok) return { config: result.config as AgentsConfig, user: true }
  const missing =
    !ctx.flags.config && result.errors.every((e) => e.message.startsWith('user config not found'))
  if (!missing)
    throw new CliError(EXIT.error, result.errors.map((e) => `config: ${formatError(e)}`).join('\n'))
  return { config: repositoryConfig(profile), user: false }
}

function load(root: string, cfg: AgentsConfig) {
  return loadAgents(join(root, 'agents'), { root, profiles: cfg.profiles, externalSkills: EXTERNAL_SKILLS })
}

function lint(ctx: Ctx, deps: AgentsDeps, root: string): number {
  const { config: cfg } = config(ctx, deps, undefined)
  const { agents, errors } = load(root, cfg)
  for (const e of errors) ctx.io.out(formatAgentError(e))
  const rendered = renderContext(cfg)
  for (const def of agents.values()) {
    if (def.kind === 'single_call') continue
    for (const w of renderAgentConfig(def, rendered).warnings) ctx.io.err(`warning: ${def.file}: ${w}`)
  }
  if (errors.length > 0) return EXIT.error
  ctx.io.out(`${agents.size} agents ok`)
  return EXIT.ok
}

function render(ctx: Ctx, deps: AgentsDeps, root: string, name: string, profile: string | undefined): number {
  const { config: cfg, user } = config(ctx, deps, profile)
  if (!user && profile === undefined)
    throw new CliError(EXIT.usage, `--profile is required without a user config\n${AGENTS_USAGE}`)
  const { agents, errors } = load(root, cfg)
  const def: AgentDef | undefined = agents.get(name)
  if (!def) {
    for (const e of errors.filter((e) => e.file.endsWith(`/${name}.md`))) ctx.io.err(formatAgentError(e))
    throw new CliError(EXIT.notFound, `no agent ${name}`)
  }
  try {
    const { content, warnings } = renderAgent(def, renderContext(cfg, profile))
    ctx.io.out(content.replace(/\n$/, ''))
    for (const w of warnings) ctx.io.err(`warning: ${w}`)
    return EXIT.ok
  } catch (e) {
    if (e instanceof AgentConfigError) throw new CliError(EXIT.error, e.message)
    throw e
  }
}

export async function agents(ctx: Ctx, args: string[], deps: AgentsDeps = {}): Promise<number> {
  const { positionals, values } = parseArgs(args, { values: ['--profile'] }, AGENTS_USAGE)
  const root = deps.agentsRoot ?? NIGHTSHIFT_ROOT
  const [sub, name, ...extra] = positionals
  if (sub === 'lint' && name === undefined) return lint(ctx, deps, root)
  if (sub === 'render' && name !== undefined && extra.length === 0)
    return render(ctx, deps, root, name, values['--profile'])
  throw new CliError(EXIT.usage, AGENTS_USAGE)
}
