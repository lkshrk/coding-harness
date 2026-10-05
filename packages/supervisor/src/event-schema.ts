import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type JsonSchema, outputValidator, validateFinish } from '@nightshift/core'
import type { EventType } from './generated/events'

export type { EventType }

export const EVENTS_SCHEMA_PATH = join(import.meta.dir, '../schema/events.schema.json')

const SPEC = JSON.parse(readFileSync(EVENTS_SCHEMA_PATH, 'utf8')) as Schema

export const EVENT_TYPES = SPEC.$defs.eventType.enum

export type EventInput = { type: EventType; issue?: string; run?: string; data: Record<string, unknown> }

type Rule = { required: string[]; validate: (data: unknown) => string[] }

type Schema = {
  $defs: Record<string, unknown> & {
    eventType: { enum: readonly EventType[] }
    ulid: { pattern: string }
    issueRef: { pattern: string }
    data: Record<string, JsonSchema>
  }
  allOf: {
    if: { properties: { type: { const?: string; enum?: string[] } } }
    then: { required?: string[]; properties?: { data?: { $ref: string } } }
  }[]
}

function resolveRefs(node: unknown, defs: Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, defs))
  if (node === null || typeof node !== 'object') return node
  const ref = (node as { $ref?: unknown }).$ref
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const target = ref
      .slice('#/$defs/'.length)
      .split('/')
      .reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], defs)
    return resolveRefs(target, defs)
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveRefs(v, defs)]))
}

function dataValidator(ref: string | undefined, schema: Schema): (data: unknown) => string[] {
  if (ref === undefined) return () => []
  if (ref === 'finish.schema.json') {
    return (data) => {
      const res = validateFinish({}, data)
      return res.ok ? [] : res.errors.map((e) => `data.${e}`)
    }
  }
  const validator = outputValidator(resolveRefs({ $ref: ref }, schema.$defs) as JsonSchema)
  return (data) => validator(data).map((i) => `${['data', ...i.path.map(String)].join('.')}: ${i.message}`)
}

function compile(schema: Schema): Map<string, Rule> {
  const rules = new Map<string, Rule>()
  for (const entry of schema.allOf) {
    const cond = entry.if.properties.type
    const types = cond.enum ?? (cond.const ? [cond.const] : [])
    const rule = {
      required: entry.then.required ?? [],
      validate: dataValidator(entry.then.properties?.data?.$ref, schema),
    }
    for (const t of types) rules.set(t, rule)
  }
  return rules
}

let compiled: { rules: Map<string, Rule>; issue: RegExp; ulid: RegExp } | undefined

function load() {
  if (!compiled) {
    compiled = {
      rules: compile(SPEC),
      issue: new RegExp(SPEC.$defs.issueRef.pattern),
      ulid: new RegExp(SPEC.$defs.ulid.pattern),
    }
  }
  return compiled
}

export function validateEvent(e: EventInput): string[] {
  const { rules, issue, ulid } = load()
  if (!(EVENT_TYPES as readonly string[]).includes(e.type)) return [`type: unknown event type '${e.type}'`]
  const errors: string[] = []
  if (e.issue !== undefined && !issue.test(e.issue)) errors.push('issue: must be a Linear identifier')
  if (e.run !== undefined && !ulid.test(e.run)) errors.push('run: must be a ULID')
  if (typeof e.data !== 'object' || e.data === null || Array.isArray(e.data)) {
    return [...errors, 'data: must be an object']
  }
  const rule = rules.get(e.type)
  if (!rule) return errors
  for (const key of rule.required) {
    if (e[key as keyof EventInput] === undefined) errors.push(`${key}: required for ${e.type}`)
  }
  return [...errors, ...rule.validate(e.data)]
}
