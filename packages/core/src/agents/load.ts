import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { parse } from 'yaml'
import { type Config, profileEntries } from '../config/schema'
import { outputValidator } from './finish'
import { splitFrontmatter, validateFrontmatter } from './frontmatter'
import { lintAgent } from './lint'
import type { AgentDef, AgentError, JsonSchema } from './types'

const NAME = /^[a-z][a-z0-9-]*$/

export type LoadAgentsOptions = {
  root?: string
  externalSkills?: readonly string[]
  profiles?: Config['profiles']
}

export function formatAgentError(e: AgentError): string {
  return [e.file, e.path, e.message].filter(Boolean).join(': ')
}

export function parseAgent(file: string, text: string): { def?: AgentDef; errors: AgentError[] } {
  const err = (path: string, message: string): AgentError => ({ file, path, message })
  const name = basename(file, '.md')
  if (!NAME.test(name)) return { errors: [err('', 'file name must match [a-z][a-z0-9-]*')] }

  const split = splitFrontmatter(text)
  if (!split) return { errors: [err('frontmatter', 'missing (file must start with ---)')] }
  let raw: unknown
  try {
    raw = parse(split.frontmatter)
  } catch (e) {
    const first = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? ''
    return { errors: [err('frontmatter', first)] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: [err('frontmatter', 'must be a YAML mapping')] }
  }

  const result = validateFrontmatter(raw)
  if (!result.ok) return { errors: result.issues.map((i) => err(i.path, i.message)) }

  const { description, nightshift: ns, ...opencode } = result.value
  const def: AgentDef = {
    name,
    file,
    kind: ns.kind,
    role: ns.role,
    description,
    body: split.body,
    skills: ns.skills,
    ...(ns.output ? { outputPath: ns.output } : {}),
    reasoning: ns.reasoning,
    budget: { promptWords: ns.budget.prompt_words, inputTokens: ns.budget.input_tokens },
    graceTurns: ns.grace_turns,
    opencode,
  }
  return { def, errors: lintAgent(def) }
}

function readOutputSchema(root: string, path: string): JsonSchema | string {
  const full = join(root, path)
  if (!existsSync(full)) return `${path} not found`
  let schema: unknown
  try {
    schema = JSON.parse(readFileSync(full, 'utf8'))
  } catch {
    return `${path} is not valid JSON`
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return `${path} is not a JSON Schema object`
  }
  try {
    outputValidator(schema as JsonSchema)
  } catch (e) {
    return `${path} is not a usable JSON Schema: ${e instanceof Error ? e.message : String(e)}`
  }
  return schema as JsonSchema
}

export function checkAgents(
  defs: readonly AgentDef[],
  opts: Pick<LoadAgentsOptions, 'profiles'> = {},
): AgentError[] {
  const errors: AgentError[] = []
  const interactive = new Map<string, AgentDef[]>()
  for (const def of defs) {
    if (def.kind === 'interactive') interactive.set(def.role, [...(interactive.get(def.role) ?? []), def])
    for (const [name, profile] of opts.profiles ? profileEntries(opts.profiles) : []) {
      if (!(def.role in profile.roles)) {
        errors.push({
          file: def.file,
          path: 'nightshift.role',
          message: `'${def.role}' not in profile ${name}`,
        })
      }
    }
  }
  for (const [role, group] of interactive) {
    const first = group[0]
    if (first && group.length > 1) {
      errors.push({ file: dirname(first.file), path: '', message: `two interactive agents for role ${role}` })
    }
  }
  return errors
}

export function loadAgents(
  dir: string,
  opts: LoadAgentsOptions = {},
): { agents: Map<string, AgentDef>; errors: AgentError[] } {
  const root = opts.root ?? dirname(dir)
  const external = new Set(opts.externalSkills ?? [])
  const errors: AgentError[] = []
  const parsed: AgentDef[] = []
  const broken = new Set<string>()

  for (const entry of readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    const file = relative(root, join(dir, entry))
    const { def, errors: own } = parseAgent(file, readFileSync(join(dir, entry), 'utf8'))
    if (def?.outputPath) {
      const schema = readOutputSchema(root, def.outputPath)
      if (typeof schema === 'string') own.push({ file, path: 'nightshift.output', message: schema })
      else def.output = schema
    }
    def?.skills.forEach((skill, i) => {
      if (!external.has(skill) && !existsSync(join(root, 'skills', skill, 'SKILL.md'))) {
        own.push({ file, path: `nightshift.skills[${i}]`, message: `no skill '${skill}'` })
      }
    })
    errors.push(...own)
    if (def) {
      parsed.push(def)
      if (own.length > 0) broken.add(def.file)
    }
  }

  const crossFile = checkAgents(parsed, opts)
  errors.push(...crossFile)
  for (const e of crossFile) broken.add(e.file)
  const leads = parsed.filter((d) => d.kind === 'interactive')
  for (const def of leads) if (leads.some((d) => d !== def && d.role === def.role)) broken.add(def.file)
  const agents = new Map<string, AgentDef>()
  for (const def of parsed) if (!broken.has(def.file)) agents.set(def.name, def)
  return { agents, errors }
}
