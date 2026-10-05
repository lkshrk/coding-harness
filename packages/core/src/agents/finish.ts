import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020'
// Imported rather than read at run time so the finish plugin bundle carries it.
import finishSchema from '../../schema/finish.schema.json'
import { createAjv, formatPath, type JsonSchema, type SchemaIssue, schemaIssues } from '../json-schema'
import type { FinishPayload } from './generated/finish'
import { issueLines } from './issues'
import type { AgentDef } from './types'

export type { FinishPayload }
export type FinishStatus = FinishPayload['status']

const spec: JsonSchema = finishSchema

export const FINISH_STATUSES = finishSchema.properties.status.enum as readonly FinishStatus[]

const { $schema: _, $id: __, title: ___, allOf: ____, ...toolInput } = spec

export const finishToolInput: JsonSchema = toolInput

let validate: ValidateFunction | undefined

const STATUS_RULE = /^#\/allOf\/\d+\/then\//

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function atLeastOne(error: ErrorObject): boolean {
  if (error.keyword === 'minItems') return true
  const field = isRecord(error.parentSchema?.properties)
    ? error.parentSchema.properties[String(error.params.missingProperty)]
    : undefined
  return isRecord(field) && field.minItems !== undefined
}

function finishErrors(payload: unknown, errors: ErrorObject[] | null | undefined): string[] {
  const status = isRecord(payload) ? payload.status : undefined
  return schemaIssues(errors, payload).map((issue) => {
    if (!STATUS_RULE.test(issue.error.schemaPath)) return issueLines([issue])[0] as string
    const rule = atLeastOne(issue.error) ? 'at least one required' : 'required'
    return `${formatPath(issue.path)}: ${rule} for status ${String(status)}`
  })
}

const outputAjv = createAjv({ strict: false, addUsedSchema: false })
const compiled = new WeakMap<JsonSchema, ValidateFunction>()

export function outputValidator(schema: JsonSchema): (data: unknown) => SchemaIssue[] {
  let v = compiled.get(schema)
  if (!v) {
    v = outputAjv.compile(schema)
    compiled.set(schema, v)
  }
  const check = v
  return (data) => (check(data) ? [] : schemaIssues(check.errors, data))
}

export function validateFinish(
  def: Pick<AgentDef, 'output'>,
  payload: unknown,
): { ok: true; value: FinishPayload } | { ok: false; errors: string[] } {
  validate ??= createAjv().compile(spec)
  if (!validate(payload)) return { ok: false, errors: finishErrors(payload, validate.errors) }
  const value = payload as FinishPayload
  const report = def.output && value.report !== undefined ? outputValidator(def.output)(value.report) : []
  if (report.length > 0) return { ok: false, errors: issueLines(report, ['report']) }
  return { ok: true, value }
}
