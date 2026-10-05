import { join } from 'node:path'
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020'
import { createAjv, formatPath, readSchema, SCHEMA_DIR, schemaIssues } from '../json-schema'
import type {
  AgentFrontmatter,
  PermissionActionConfig,
  PermissionConfig,
  PermissionRuleConfig,
} from './generated/agent'

export type { AgentFrontmatter }
export type PermissionAction = PermissionActionConfig
export type PermissionRule = PermissionRuleConfig
export type Permission = PermissionConfig

const RENDERER_KEYS = {
  model: 'set by the profile, remove it',
  prompt: 'set by the renderer, remove it',
  mode: 'set by the renderer, remove it',
  options: 'set by the renderer, remove it',
  tools: 'set by the renderer, remove it',
} as const

export type OpenCodeAgentFields = Omit<
  AgentFrontmatter,
  'description' | 'nightshift' | keyof typeof RENDERER_KEYS
>

export type FrontmatterIssue = { path: string; message: string }

export const AGENT_SCHEMA_PATH = join(SCHEMA_DIR, 'agent.schema.json')

let validate: ValidateFunction | undefined

function validator(): ValidateFunction {
  if (!validate) {
    const schema = readSchema(AGENT_SCHEMA_PATH)
    const ajv = createAjv({ useDefaults: true, strict: false })
    ajv.addSchema(readSchema(join(SCHEMA_DIR, 'vendor/models-dev-model.schema.json')))
    ajv.addSchema(
      readSchema(join(SCHEMA_DIR, 'vendor/opencode-config.schema.json')),
      new URL('vendor/opencode-config.schema.json', schema.$id as string).href,
    )
    validate = ajv.compile(schema)
  }
  return validate
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const KIND_RULE = /^#\/allOf\/\d+\/then\//

function frontmatterIssues(raw: unknown, errors: ErrorObject[] | null | undefined): FrontmatterIssue[] {
  const kind = isRecord(raw) && isRecord(raw.nightshift) ? raw.nightshift.kind : undefined
  const out: FrontmatterIssue[] = []
  const seen = new Set<string>()
  for (const issue of schemaIssues(errors, raw)) {
    const top = String(issue.path[0])
    if (top in RENDERER_KEYS) {
      if (!seen.has(top)) out.push({ path: top, message: RENDERER_KEYS[top as keyof typeof RENDERER_KEYS] })
      seen.add(top)
    } else if (KIND_RULE.test(issue.error.schemaPath)) {
      // The kind conditions hold vacuously without a kind; the error on nightshift.kind covers that case.
      if (typeof kind !== 'string') continue
      const rule = issue.error.keyword === 'required' ? 'required' : 'not allowed'
      out.push({ path: formatPath(issue.path), message: `${rule} for kind ${kind}` })
    } else {
      out.push({ path: formatPath(issue.path), message: issue.message })
    }
  }
  return out
}

export function validateFrontmatter(
  raw: unknown,
): { ok: true; value: AgentFrontmatter } | { ok: false; issues: FrontmatterIssue[] } {
  const value = structuredClone(raw)
  const check = validator()
  if (check(value)) return { ok: true, value: value as AgentFrontmatter }
  return { ok: false, issues: frontmatterIssues(value, check.errors) }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?\r?\n)?---(?:\r?\n|$)/

export function splitFrontmatter(text: string): { frontmatter: string; body: string } | undefined {
  const m = FRONTMATTER.exec(text)
  if (!m) return undefined
  return { frontmatter: m[1] ?? '', body: text.slice(m[0].length) }
}
