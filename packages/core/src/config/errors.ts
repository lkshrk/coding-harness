import { formatPath, type JsonSchema, type SchemaIssue } from '../json-schema'

export { formatPath }

export type ConfigError = { path: string; message: string; hint?: string }

export function formatError(e: ConfigError): string {
  return e.hint ? `${e.path}: ${e.message} (${e.hint})` : `${e.path}: ${e.message}`
}

function isRecord(value: unknown): value is JsonSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function expand(root: JsonSchema, node: unknown): JsonSchema[] {
  if (!isRecord(node)) return []
  const ref = typeof node.$ref === 'string' && node.$ref.startsWith('#/') ? node.$ref : undefined
  const target = ref
    ?.slice(2)
    .split('/')
    .reduce<unknown>((n, key) => (isRecord(n) ? n[key] : undefined), root)
  const branches = [node.anyOf, node.oneOf, node.allOf].flatMap((b) => (Array.isArray(b) ? b : []))
  return [node, ...expand(root, target), ...branches.flatMap((b) => expand(root, b))]
}

function childSchemas(root: JsonSchema, node: unknown, key: PropertyKey): JsonSchema[] {
  return expand(root, node).flatMap((s) => {
    if (typeof key === 'number') return isRecord(s.items) ? [s.items] : []
    const field = isRecord(s.properties) ? s.properties[String(key)] : undefined
    if (isRecord(field)) return [field]
    return isRecord(s.additionalProperties) ? [s.additionalProperties] : []
  })
}

export function knownKeys(root: JsonSchema, path: readonly PropertyKey[]): string[] {
  let nodes: unknown[] = [root]
  for (const key of path) nodes = nodes.flatMap((n) => childSchemas(root, n, key))
  const keys = new Set<string>()
  for (const s of nodes.flatMap((n) => expand(root, n))) {
    if (isRecord(s.properties)) for (const k of Object.keys(s.properties)) keys.add(k)
  }
  return [...keys]
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[b.length] ?? 0
}

export function nearest(key: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Math.max(2, Math.floor(key.length / 3)) + 1
  for (const c of candidates) {
    const d = distance(key, c)
    if (d < bestDistance) {
      best = c
      bestDistance = d
    }
  }
  return best
}

export function issuesToErrors(issues: readonly SchemaIssue[]): ConfigError[] {
  const errors = issues.map((issue): ConfigError => {
    const path = formatPath(issue.path)
    if (issue.unknownKey === undefined) return { path, message: issue.message }
    const properties = isRecord(issue.error.parentSchema) ? issue.error.parentSchema.properties : undefined
    const hint = nearest(issue.unknownKey, isRecord(properties) ? Object.keys(properties) : [])
    return { path, message: issue.message, ...(hint ? { hint: `did you mean ${hint}?` } : {}) }
  })
  const unknown = (e: ConfigError) => (e.message === 'unknown key' ? 1 : 0)
  return errors.sort((a, b) => unknown(a) - unknown(b))
}
