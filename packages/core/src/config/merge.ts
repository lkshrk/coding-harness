import YAML from 'yaml'
import { knownKeys } from './errors'
import { configJsonSchema } from './schema'

export type Layer = Record<string, unknown>

export function isMap(value: unknown): value is Layer {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function mergeLayers(base: Layer, over: Layer): Layer {
  const out: Layer = { ...base }
  for (const [key, value] of Object.entries(over)) {
    const current = out[key]
    out[key] = isMap(current) && isMap(value) ? mergeLayers(current, value) : value
  }
  return out
}

const ENV_PREFIX = 'NIGHTSHIFT_'

function envName(key: string): string {
  return key.toUpperCase().replaceAll('-', '_')
}

function resolveEnvPath(config: Layer, name: string): string[] | undefined {
  const walk = (node: unknown, path: string[], rest: string): string[] | undefined => {
    const candidates = new Set(knownKeys(configJsonSchema(), path))
    if (isMap(node)) for (const k of Object.keys(node)) candidates.add(k)
    const matches = [...candidates].filter((k) => rest === envName(k) || rest.startsWith(`${envName(k)}_`))
    for (const key of matches.sort((a, b) => b.length - a.length)) {
      if (rest === envName(key)) return [key]
      const child = isMap(node) ? node[key] : undefined
      if (child !== undefined && !isMap(child)) continue
      const tail = walk(child, [...path, key], rest.slice(envName(key).length + 1))
      if (tail) return [key, ...tail]
    }
    return undefined
  }
  return walk(config, [], name)
}

function setIn(target: Layer, path: string[], value: unknown): Layer {
  const [head, ...rest] = path
  if (head === undefined) return target
  const current = target[head]
  return { ...target, [head]: rest.length === 0 ? value : setIn(isMap(current) ? current : {}, rest, value) }
}

function parseScalar(raw: string): unknown {
  try {
    return YAML.parse(raw)
  } catch {
    return raw
  }
}

export function applyEnvOverrides(
  config: Layer,
  env: Record<string, string | undefined>,
): { config: Layer; applied: string[] } {
  let out = config
  const applied: string[] = []
  for (const [name, raw] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    if (!name.startsWith(ENV_PREFIX) || raw === undefined) continue
    const path = resolveEnvPath(out, name.slice(ENV_PREFIX.length))
    if (!path) continue
    out = setIn(out, path, parseScalar(raw))
    applied.push(`env:${name}`)
  }
  return { config: out, applied }
}
