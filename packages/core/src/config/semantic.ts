import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { readStacks } from '../stacks/load'
import type { ConfigError } from './errors'
import { formatPath } from './errors'
import { type Config, type Profile, profileEntries } from './schema'

export type Catalog = {
  agents: Map<string, { role: string }>
  stacks: Set<string>
  stackErrors?: ConfigError[]
}

export type SemanticContext = {
  catalog: Catalog
  isGitRepo: (path: string) => boolean
  home: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/

export function readCatalog(root: string): Catalog {
  const agents = new Map<string, { role: string }>()
  const agentsDir = join(root, 'agents')
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) continue
      const front = FRONTMATTER.exec(readFileSync(join(agentsDir, file), 'utf8'))?.[1]
      const role = front ? YAML.parse(front)?.nightshift?.role : undefined
      agents.set(file.slice(0, -3), { role: typeof role === 'string' ? role : '' })
    }
  }
  const loaded = readStacks(join(root, 'features'))
  const stackErrors = loaded.issues.map((i) => ({
    path: i.file,
    message: i.path ? `${i.path}: ${i.message}` : i.message,
  }))
  return { agents, stacks: new Set(loaded.stacks.keys()), stackErrors }
}

export function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'))
}

export function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? home + path.slice(1) : path
}

type Rule = (c: Partial<Config>, ctx: SemanticContext) => ConfigError[]

const err = (path: PropertyKey[], message: string): ConfigError => ({ path: formatPath(path), message })

const projectReferences: Rule = (c) => {
  const errors: ConfigError[] = []
  c.projects?.forEach((p, i) => {
    if (c.repositories) {
      p.repositories.forEach((r, j) => {
        if (!Object.hasOwn(c.repositories ?? {}, r))
          errors.push(err(['projects', i, 'repositories', j], `no repository '${r}'`))
      })
    }
    if (c.pipelines && !Object.hasOwn(c.pipelines, p.pipeline)) {
      errors.push(err(['projects', i, 'pipeline'], `no pipeline '${p.pipeline}'`))
    }
    if (c.profiles && p.profile !== undefined && !profileNames(c.profiles).includes(p.profile)) {
      errors.push(err(['projects', i, 'profile'], `no profile '${p.profile}'`))
    }
  })
  return errors
}

const pipelineStages: Rule = (c) => {
  const errors: ConfigError[] = []
  if (!c.pipelines || !c.stages) return errors
  for (const [name, stages] of Object.entries(c.pipelines)) {
    stages.forEach((s, i) => {
      if (!Object.hasOwn(c.stages ?? {}, s)) errors.push(err(['pipelines', name, i], `no stage '${s}'`))
    })
  }
  return errors
}

const selectionAgents: Rule = (c, ctx) =>
  (c.selection ?? []).flatMap((r, i) =>
    ctx.catalog.agents.has(r.agent) ? [] : [err(['selection', i, 'agent'], `no agents/${r.agent}.md`)],
  )

export const SUPERVISOR_STAGES: readonly string[] = ['integration', 'release']

const automaticStagesHandled: Rule = (c) => {
  if (!c.stages || !c.selection) return []
  const handled = new Set<string>()
  for (const r of c.selection) {
    const keys = Object.keys(r.when)
    if (keys.length !== 1 || r.when.stage === undefined) continue
    for (const s of [r.when.stage].flat()) handled.add(s)
  }
  return Object.entries(c.stages)
    .filter(([name, stage]) => stage?.automatic && !SUPERVISOR_STAGES.includes(name) && !handled.has(name))
    .map(([name]) => err(['selection'], `no rule handles stage ${name}`))
}

const githubAccounts: Rule = (c) => {
  const errors: ConfigError[] = []
  const accounts = c.github?.accounts ?? {}
  const known = (n: string) => Object.hasOwn(accounts, n)
  const def = c.github?.default
  if (def === undefined && Object.keys(accounts).length > 1)
    errors.push(err(['github', 'default'], 'required with several accounts'))
  if (def !== undefined && !known(def)) errors.push(err(['github', 'default'], `no account '${def}'`))
  for (const [name, repo] of Object.entries(c.repositories ?? {})) {
    if (repo.github !== undefined && !known(repo.github))
      errors.push(err(['repositories', name, 'github'], `no account '${repo.github}'`))
  }
  return errors
}

function profileNames(profiles: Config['profiles']): string[] {
  return profileEntries(profiles).map(([name]) => name)
}

function residentGb(profile: Profile, phase: string): number {
  const sizes = new Map<string, number>()
  for (const m of Object.values(profile.models))
    if (m.phases.some((p) => p === phase)) sizes.set(m.model, m.size_gb)
  return [...sizes.values()].reduce((a, b) => a + b, 0)
}

const profileRules: Rule = (c, ctx) => {
  const errors: ConfigError[] = []
  const profiles = c.profiles
  if (!profiles) return errors
  const entries = profileEntries(profiles)
  if (!entries.some(([name]) => name === profiles.active)) {
    errors.push(err(['profiles', 'active'], `no profile '${profiles.active}'`))
  }
  const agentRoles = [...ctx.catalog.agents].filter(([, a]) => a.role)
  for (const [name, profile] of entries) {
    for (const alias of new Set(Object.values(profile.roles))) {
      if (!Object.hasOwn(profile.models, alias))
        errors.push(err(['profiles', name, 'models'], `alias ${alias} missing`))
    }
    for (const [agent, { role }] of agentRoles) {
      if (!Object.hasOwn(profile.roles, role)) {
        errors.push(err(['profiles', name, 'roles'], `role ${role} missing (used by agents/${agent}.md)`))
      }
    }
    for (const phase of ['planning', 'implementation']) {
      const needed = residentGb(profile, phase)
      if (needed > profiles.memory_budget_gb) {
        errors.push(
          err(
            ['profiles', name, 'models'],
            `${phase} phase needs ${needed} GB, memory_budget_gb is ${profiles.memory_budget_gb}`,
          ),
        )
      }
    }
    const family = (role: string) => {
      const alias = profile.roles[role]
      return alias && Object.hasOwn(profile.models, alias) ? profile.models[alias]?.family : undefined
    }
    const reviewer = family('reviewer')
    if (reviewer !== undefined && reviewer === family('worker')) {
      errors.push(err(['profiles', name], `reviewer family ${reviewer} equals worker family`))
    }
  }
  return errors
}

const repositoryRules: Rule = (c, ctx) => {
  const errors: ConfigError[] = []
  for (const [name, repo] of Object.entries(c.repositories ?? {})) {
    if (!ctx.isGitRepo(expandHome(repo.path, ctx.home))) {
      errors.push(err(['repositories', name, 'path'], 'not a git repository'))
    }
    if (Array.isArray(repo.stacks)) {
      repo.stacks.forEach((s, i) => {
        if (!ctx.catalog.stacks.has(s))
          errors.push(err(['repositories', name, 'stacks', i], `unknown stack '${s}'`))
      })
    }
    const seen = new Set<string>()
    repo.checks.forEach((check, i) => {
      if (seen.has(check.name))
        errors.push(err(['repositories', name, 'checks', i, 'name'], `duplicate '${check.name}'`))
      seen.add(check.name)
    })
  }
  return errors
}

const stackFiles: Rule = (_c, ctx) => ctx.catalog.stackErrors ?? []

const RULES: Rule[] = [
  stackFiles,
  projectReferences,
  pipelineStages,
  selectionAgents,
  automaticStagesHandled,
  githubAccounts,
  profileRules,
  repositoryRules,
]

export function checkSemantics(config: Partial<Config>, ctx: SemanticContext): ConfigError[] {
  return RULES.flatMap((rule) => rule(config, ctx))
}
