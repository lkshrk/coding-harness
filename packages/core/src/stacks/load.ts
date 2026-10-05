import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { ValidateFunction } from 'ajv/dist/2020'
import YAML from 'yaml'
import { createAjv, formatPath, readSchema, SCHEMA_DIR, schemaIssues } from '../json-schema'
import type { StackFile } from './generated/stack'

export type Marker = { file?: string; glob?: string; contains?: string; not?: Marker[] }
export type LspEntry = { command: string[]; extensions: string[]; initialization?: Record<string, unknown> }
export type Stack = {
  id: string
  markers: Marker[]
  addon: boolean
  versionFiles: string[]
  lsp: Record<string, LspEntry>
  checks: { name: string; run: string }[]
  egress: string[]
  env: Record<string, string>
  nestedDocker: boolean
  featureDir: string
  version: string
  digest: string
}

export type StackIssue = { file: string; path: string; message: string }

export const STACK_SCHEMA_PATH = join(SCHEMA_DIR, 'stack.schema.json')

const NO_LSP = 'at least one language server required'

let validator: ValidateFunction | undefined

function validate(data: unknown): { path: string; message: string }[] {
  validator ??= createAjv({ useDefaults: true }).compile(readSchema(STACK_SCHEMA_PATH))
  if (validator(data)) return []
  return schemaIssues(validator.errors, data).map((i) => {
    const path = formatPath(i.path)
    return path === 'lsp' && i.message === 'required'
      ? { path, message: NO_LSP }
      : { path, message: i.message }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function featureDigest(dir: string): string {
  const hash = createHash('sha256')
  const walk = (d: string): string[] =>
    readdirSync(d)
      .filter((f) => f !== 'node_modules')
      .flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
  for (const file of walk(dir).sort()) {
    hash.update(`${relative(dir, file)}\0`)
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

type Feature = { id?: unknown; version?: unknown; containerEnv?: unknown }

function readFeature(dir: string, label: string, issues: StackIssue[]): Feature | undefined {
  const path = join(dir, 'devcontainer-feature.json')
  const file = `${label}/devcontainer-feature.json`
  if (!existsSync(path)) {
    issues.push({ file, path: '', message: 'missing' })
    return undefined
  }
  try {
    const feature = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (isRecord(feature)) return feature
    issues.push({ file, path: '', message: 'must be an object' })
  } catch (e) {
    issues.push({ file, path: '', message: `invalid JSON: ${(e as Error).message}` })
  }
  return undefined
}

function loadOne(featuresDir: string, dirName: string, issues: StackIssue[]): Stack | undefined {
  const suffix = dirName.slice('stack-'.length)
  const dir = join(featuresDir, dirName)
  const label = `${basename(featuresDir)}/${dirName}`
  const file = `${label}/stack.yaml`
  const before = issues.length
  let data: unknown
  try {
    data = YAML.parse(readFileSync(join(dir, 'stack.yaml'), 'utf8'))
  } catch (e) {
    issues.push({ file, path: '', message: `invalid YAML: ${(e as Error).message}` })
    return undefined
  }
  for (const i of validate(data)) issues.push({ file, ...i })
  const parsed = data as StackFile
  if (isRecord(data) && typeof data.id === 'string' && data.id !== suffix)
    issues.push({ file, path: 'id', message: `must equal the directory suffix '${suffix}'` })

  const feature = readFeature(dir, label, issues)
  if (feature) {
    const featureFile = `${label}/devcontainer-feature.json`
    if (feature.id !== dirName) issues.push({ file: featureFile, path: 'id', message: `must be ${dirName}` })
    if (typeof feature.version !== 'string')
      issues.push({ file: featureFile, path: 'version', message: 'required' })
    const containerEnv = isRecord(feature.containerEnv) ? feature.containerEnv : {}
    for (const [key, value] of Object.entries(isRecord(parsed?.env) ? parsed.env : {})) {
      if (containerEnv[key] !== value)
        issues.push({
          file,
          path: `env.${key}`,
          message: 'must equal containerEnv in devcontainer-feature.json',
        })
    }
  }
  if (issues.length > before || !feature) return undefined
  return {
    id: parsed.id,
    markers: parsed.markers,
    addon: parsed.addon,
    versionFiles: parsed.version_files,
    lsp: parsed.lsp ?? {},
    checks: parsed.checks,
    egress: parsed.egress,
    env: parsed.env,
    nestedDocker: parsed.nested_docker,
    featureDir: dir,
    version: String(feature.version),
    digest: featureDigest(dir),
  }
}

export function readStacks(featuresDir: string): { stacks: Map<string, Stack>; issues: StackIssue[] } {
  const stacks = new Map<string, Stack>()
  const issues: StackIssue[] = []
  if (!existsSync(featuresDir)) return { stacks, issues }
  for (const dirName of readdirSync(featuresDir).sort()) {
    if (!dirName.startsWith('stack-') || !existsSync(join(featuresDir, dirName, 'stack.yaml'))) continue
    const stack = loadOne(featuresDir, dirName, issues)
    if (stack) stacks.set(stack.id, stack)
  }
  return { stacks, issues }
}

export function formatStackIssue(i: StackIssue): string {
  return i.path ? `${i.file}: ${i.path}: ${i.message}` : `${i.file}: ${i.message}`
}

export function loadStacks(featuresDir: string): { stacks: Map<string, Stack>; errors: string[] } {
  const { stacks, issues } = readStacks(featuresDir)
  return { stacks, errors: issues.map(formatStackIssue) }
}
