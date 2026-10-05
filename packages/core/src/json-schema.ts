import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020, { type ErrorObject, type Options } from 'ajv/dist/2020'
import addFormats from 'ajv-formats'

export type JsonSchema = Record<string, unknown>

export const SCHEMA_DIR = join(import.meta.dir, '../schema')

export function readSchema(path: string): JsonSchema {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonSchema
}

export function createAjv(options: Options = {}): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, verbose: true, strict: true, strictRequired: false, ...options })
  ajv.addKeyword({ keyword: 'errorMessage', schemaType: ['string', 'object'] })
  addFormats(ajv)
  return ajv
}

export type SchemaIssue = {
  path: PropertyKey[]
  message: string
  unknownKey?: string
  error: ErrorObject
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pointerPath(data: unknown, pointer: string): PropertyKey[] {
  if (pointer === '') return []
  const path: PropertyKey[] = []
  let node = data
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(node)) {
      path.push(Number(key))
      node = node[Number(key)]
    } else {
      path.push(key)
      node = isRecord(node) ? node[key] : undefined
    }
  }
  return path
}

function customMessage(error: ErrorObject): string | undefined {
  const custom = isRecord(error.parentSchema) ? error.parentSchema.errorMessage : undefined
  if (typeof custom === 'string') return custom
  const keyed = isRecord(custom) ? custom[error.keyword] : undefined
  return typeof keyed === 'string' ? keyed : undefined
}

function tagValues(error: ErrorObject, tag: string): string {
  const branches = isRecord(error.parentSchema) ? error.parentSchema.oneOf : undefined
  if (!Array.isArray(branches)) return ''
  return branches
    .map((b) => (isRecord(b) && isRecord(b.properties) ? b.properties[tag] : undefined))
    .map((p) => (isRecord(p) ? String(p.const) : ''))
    .join(', ')
}

function defaultMessage(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>
  switch (error.keyword) {
    case 'required':
      return 'required'
    case 'uniqueItems':
      return 'items must be unique'
    case 'minProperties':
      return params.limit === 1 ? 'must not be empty' : (error.message ?? 'invalid')
    case 'enum':
      return `must be one of ${(params.allowedValues as unknown[]).join(', ')}`
    case 'const':
      return `must be ${String(params.allowedValue)}`
    case 'false schema':
      return 'not allowed'
    default:
      return error.message ?? 'invalid'
  }
}

const UNIONS = new Set(['anyOf', 'oneOf'])

function within(pointer: string, ancestor: string): boolean {
  return pointer === ancestor || pointer.startsWith(`${ancestor}/`)
}

// A failed anyOf/oneOf reports once at its own path instead of every branch's errors.
function collapseUnions(errors: readonly ErrorObject[]): ErrorObject[] {
  const unions = new Map<string, ErrorObject>()
  for (const e of errors) if (UNIONS.has(e.keyword)) unions.set(e.instancePath, e)
  const outer = [...unions.values()].filter(
    (u) => ![...unions.keys()].some((p) => p !== u.instancePath && within(u.instancePath, p)),
  )
  return errors.filter((e) => {
    const union = outer.find((u) => within(e.instancePath, u.instancePath))
    return union === undefined || union === e
  })
}

export function schemaIssues(
  errors: readonly ErrorObject[] | null | undefined,
  data: unknown,
): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  for (const error of collapseUnions(errors ?? [])) {
    if (error.keyword === 'if' || error.keyword === 'propertyNames') continue
    const params = error.params as Record<string, unknown>
    const base = pointerPath(data, error.instancePath)
    const propertyName = (error as { propertyName?: string }).propertyName
    if (propertyName !== undefined) base.push(propertyName)
    const message = customMessage(error)
    if (error.keyword === 'additionalProperties' || error.keyword === 'unevaluatedProperties') {
      const key = String(params.additionalProperty ?? params.unevaluatedProperty)
      issues.push({ path: [...base, key], message: message ?? 'unknown key', unknownKey: key, error })
    } else if (error.keyword === 'required') {
      issues.push({ path: [...base, String(params.missingProperty)], message: message ?? 'required', error })
    } else if (error.keyword === 'discriminator') {
      const tag = String(params.tag)
      const value = params.tagValue
      const text = value === undefined ? 'required' : `must be one of ${tagValues(error, tag)}`
      issues.push({ path: [...base, tag], message: message ?? text, error })
    } else {
      issues.push({ path: base, message: message ?? defaultMessage(error), error })
    }
  }
  return issues
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`
    else out += out ? `.${String(key)}` : String(key)
  }
  return out
}
