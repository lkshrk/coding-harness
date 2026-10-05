import type { ValidateFunction } from 'ajv/dist/2020'
import { createAjv, schemaIssues } from '../json-schema'
import type { ConfigError } from './errors'
import { formatError, issuesToErrors } from './errors'
import { isMap } from './merge'
import { type Config, type ConfigSection, configJsonSchema, DEFAULT_STATUSES, SCHEMA_ID } from './schema'
import { checkSemantics, type SemanticContext } from './semantic'

export type ValidateContext = SemanticContext

export type ValidateResult = { ok: true; config: Config } | { ok: false; errors: ConfigError[] }

type SchemaResult = { ok: true; value: Config } | { ok: false; errors: ConfigError[]; valid: Partial<Config> }

let ajv: ReturnType<typeof createAjv> | undefined

function validator(fragment = ''): ValidateFunction {
  if (!ajv) {
    ajv = createAjv({ useDefaults: true, discriminator: true })
    ajv.addSchema(configJsonSchema())
  }
  const validate = ajv.getSchema(`${SCHEMA_ID}${fragment}`)
  if (!validate) throw new Error(`no schema ${SCHEMA_ID}${fragment}`)
  return validate
}

function withStatuses(config: Partial<Config>): Partial<Config> {
  if (config.linear) config.linear.statuses = { ...DEFAULT_STATUSES, ...config.linear.statuses }
  return config
}

function applySchema(data: unknown): SchemaResult {
  const value = structuredClone(data)
  const validate = validator()
  if (validate(value)) return { ok: true, value: withStatuses(value as Config) as Config }
  const issues = schemaIssues(validate.errors, value)
  const valid: Record<string, unknown> = {}
  if (isMap(value)) {
    const invalid = new Set(issues.map((i) => i.path[0]))
    for (const key of Object.keys(configJsonSchema().properties as object)) {
      if (key in value && !invalid.has(key)) valid[key] = value[key]
    }
  }
  return { ok: false, errors: issuesToErrors(issues), valid: withStatuses(valid as Partial<Config>) }
}

export function validateConfig(data: unknown, ctx: ValidateContext): ValidateResult {
  const res = applySchema(data)
  if (res.ok) {
    const errors = checkSemantics(res.value, ctx)
    return errors.length ? { ok: false, errors } : { ok: true, config: res.value }
  }
  return { ok: false, errors: [...res.errors, ...checkSemantics(res.valid, ctx)] }
}

export function parseConfig(data: unknown): Config {
  const res = applySchema(data)
  if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
  return res.value
}

export function parseConfigSection<K extends ConfigSection>(section: K, data: unknown): Config[K] {
  const value = structuredClone(data)
  const validate = validator(`#/properties/${section}`)
  if (validate(value)) return withStatuses({ [section]: value })[section] as Config[K]
  const errors = issuesToErrors(schemaIssues(validate.errors, value))
  throw new Error(`${section}: ${errors.map(formatError).join('; ')}`)
}
