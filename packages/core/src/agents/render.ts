import { stringify } from 'yaml'
import { type Config, type Policy, type Profile, profileEntries } from '../config/schema'
import type { OpenCodeAgentFields, PermissionAction, PermissionRule } from './frontmatter'
import type { AgentDef } from './types'

export class AgentConfigError extends Error {
  override name = 'AgentConfigError'
}

export type ActiveProfile = { name: string; profile: Profile }

export type RenderContext = { profile: ActiveProfile; policy: Policy; stepsLimit: number; provider?: string }

export type PermissionObject = Record<string, PermissionRule>

export type OpenCodeAgentConfig = Omit<OpenCodeAgentFields, 'permission'> & {
  description: string
  mode: 'primary'
  model: string
  permission?: PermissionObject
}

export function activeProfile(profiles: Config['profiles'], name: string = profiles.active): ActiveProfile {
  const profile = profileEntries(profiles).find(([n]) => n === name)?.[1]
  if (!profile) throw new AgentConfigError(`no profile '${name}'`)
  return { name, profile }
}

export function renderContext(
  config: Pick<Config, 'profiles' | 'policies' | 'limits'>,
  profileName?: string,
): RenderContext {
  return {
    profile: activeProfile(config.profiles, profileName),
    policy: config.policies,
    stepsLimit: config.limits.worker.steps,
  }
}

export function resolveAlias(def: AgentDef, { name, profile }: ActiveProfile): string {
  const alias = profile.roles[def.role]
  if (!alias) {
    throw new AgentConfigError(`${def.file}: nightshift.role: '${def.role}' not in profile ${name}`)
  }
  return alias
}

const RENDERER_PERMISSIONS = new Set(['*', 'finish', 'skill'])

function renderPermission(def: AgentDef, policy: Policy, warnings: string[]): PermissionObject {
  const src = def.opencode.permission
  const base = (typeof src === 'string' ? { '*': src } : { ...src }) as PermissionObject
  const out: PermissionObject = {}
  const global = base['*']
  if (global !== undefined) out['*'] = global
  for (const [key, rule] of Object.entries(base)) {
    if (!RENDERER_PERMISSIONS.has(key) && !(key in policy.deny)) out[key] = rule
  }
  for (const [tool, patterns] of Object.entries(policy.deny)) {
    const current = base[tool]
    const rules: Record<string, PermissionAction> =
      typeof current === 'string' ? { '*': current } : { ...(current ?? {}) }
    for (const pattern of patterns) {
      const own = rules[pattern]
      if (own !== undefined && own !== 'deny') {
        warnings.push(`permission.${tool} '${pattern}' conflicts with policy deny`)
      }
      delete rules[pattern]
    }
    out[tool] = { ...rules, ...Object.fromEntries(patterns.map((p) => [p, 'deny' as const])) }
  }
  if (def.kind === 'worker') out.finish = 'allow'
  out.skill = { '*': 'deny', ...Object.fromEntries(def.skills.map((s) => [s, 'allow' as const])) }
  return out
}

export function renderAgentConfig(
  def: AgentDef,
  ctx: RenderContext,
): { config: OpenCodeAgentConfig; warnings: string[] } {
  if (def.kind === 'single_call') {
    throw new AgentConfigError(`${def.file}: kind single_call runs without OpenCode and is not rendered`)
  }
  const model = `${ctx.provider ?? 'litellm'}/${resolveAlias(def, ctx.profile)}`
  const warnings: string[] = []
  const { permission: _, steps, maxSteps, ...rest } = def.opencode
  const cap = (n: number | undefined) =>
    n === undefined || def.kind !== 'worker' ? n : Math.min(n, ctx.stepsLimit)
  const cappedSteps = cap(steps)
  const cappedMax = cap(maxSteps)
  const config: OpenCodeAgentConfig = {
    description: def.description,
    mode: 'primary',
    model,
    ...rest,
    ...(cappedSteps === undefined ? {} : { steps: cappedSteps }),
    ...(cappedMax === undefined ? {} : { maxSteps: cappedMax }),
    permission: renderPermission(def, ctx.policy, warnings),
  }
  return { config, warnings }
}

export function renderAgent(
  def: AgentDef,
  ctx: RenderContext,
): { path: string; content: string; warnings: string[] } {
  const { config, warnings } = renderAgentConfig(def, ctx)
  return { path: `agent/${def.name}.md`, content: `---\n${stringify(config)}---\n${def.body}`, warnings }
}

export const FINISH_PLUGIN_DIR = 'plugins/nightshift-finish'

export type OpenCodePluginEntry = { package: string; options?: Record<string, unknown> }

export function renderFinishPlugin(
  defs: readonly AgentDef[],
  configDir: string,
  bundle: string,
): { files: { path: string; content: string }[]; plugin: OpenCodePluginEntry } | undefined {
  const workers = defs.filter((d) => d.kind === 'worker')
  if (workers.length === 0) return undefined
  const outputs = Object.fromEntries(workers.flatMap((d) => (d.output ? [[d.name, d.output]] : [])))
  const pkg = { name: 'nightshift-finish', type: 'module', exports: { '.': './index.js' } }
  return {
    files: [
      { path: `${FINISH_PLUGIN_DIR}/package.json`, content: `${JSON.stringify(pkg, null, 2)}\n` },
      { path: `${FINISH_PLUGIN_DIR}/index.js`, content: bundle },
    ],
    plugin: { package: `${configDir.replace(/\/+$/, '')}/${FINISH_PLUGIN_DIR}`, options: { outputs } },
  }
}
