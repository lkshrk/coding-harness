import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { compile } from 'json-schema-to-typescript'
import { CONFIG_SCHEMA_PATH, LAYER_SCHEMA_PATH } from './config/schema'
import { type JsonSchema, readSchema, SCHEMA_DIR } from './json-schema'

const ROOT = join(import.meta.dir, '../../..')
const BIOME = join(ROOT, 'node_modules/.bin/biome')

const AGENT_SCHEMA = join(SCHEMA_DIR, 'agent.schema.json')
const FINISH_SCHEMA = join(SCHEMA_DIR, 'finish.schema.json')
const STACK_SCHEMA = join(SCHEMA_DIR, 'stack.schema.json')
const OPENCODE_SCHEMA = join(SCHEMA_DIR, 'vendor/opencode-config.schema.json')
const EVENTS_SCHEMA = join(ROOT, 'packages/supervisor/schema/events.schema.json')
const CONTROL_SCHEMA = join(ROOT, 'packages/supervisor/schema/control.schema.json')
const RECORDS_SCHEMA = join(ROOT, 'packages/supervisor/schema/records.schema.json')

export type Generated = { path: string; content: string }

function isRecord(value: unknown): value is JsonSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const NAME_MAPS = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs'])
const VALUES = new Set(['default', 'const', 'enum', 'examples'])

function transform(node: unknown, fn: (schema: JsonSchema) => JsonSchema, names = false): unknown {
  if (Array.isArray(node)) return node.map((n) => transform(n, fn))
  if (!isRecord(node)) return node
  const out = Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      !names && VALUES.has(k) ? v : transform(v, fn, !names && NAME_MAPS.has(k)),
    ]),
  )
  return names ? out : fn(out)
}

function withoutKeys(schema: JsonSchema, keys: readonly string[]): JsonSchema {
  return transform(schema, (node) =>
    Object.fromEntries(Object.entries(node).filter(([k]) => !keys.includes(k))),
  ) as JsonSchema
}

function forTypes(schema: JsonSchema): JsonSchema {
  return transform(schema, (node) => {
    const { if: _if, then: _then, else: _else, unevaluatedProperties, ...rest } = node
    if (unevaluatedProperties === false) rest.additionalProperties ??= false
    if (!Array.isArray(rest.allOf)) return rest
    const allOf = rest.allOf.filter((s) => !isRecord(s) || Object.keys(s).length > 0)
    if (allOf.length > 0) return { ...rest, allOf }
    const { allOf: _, ...withoutAllOf } = rest
    return withoutAllOf
  }) as JsonSchema
}

// Types describe the value after validation, when every property with a default is present.
function defaultsRequired(schema: JsonSchema): JsonSchema {
  return transform(schema, (node) => {
    if (!isRecord(node.properties)) return node
    const defaulted = Object.entries(node.properties)
      .filter(([, p]) => isRecord(p) && 'default' in p)
      .map(([k]) => k)
    if (defaulted.length === 0) return node
    const required = Array.isArray(node.required) ? (node.required as string[]) : []
    return { ...node, required: [...new Set([...required, ...defaulted])] }
  }) as JsonSchema
}

function bundleOpenCodeAgent(schema: JsonSchema): JsonSchema {
  const vendor = readSchema(OPENCODE_SCHEMA).$defs as Record<string, JsonSchema>
  const local = transform(schema, (node) =>
    typeof node.$ref === 'string' && node.$ref.startsWith('vendor/')
      ? { $ref: `#/$defs/${node.$ref.split('/').at(-1)}` }
      : node,
  ) as JsonSchema
  const modelsDev = (node: JsonSchema): JsonSchema => {
    if (typeof node.$ref !== 'string' || !node.$ref.startsWith('https://models.dev/')) return node
    const { $ref: _, ...rest } = node
    return rest
  }
  const defs: Record<string, unknown> = { ...(local.$defs as JsonSchema) }
  const pending = ['AgentConfig']
  while (pending.length > 0) {
    const name = pending.pop() as string
    if (name in defs) continue
    defs[name] = transform(vendor[name], (node) => {
      if (typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/')) pending.push(node.$ref.slice(8))
      return modelsDev(node)
    })
  }
  // The frontmatter's unevaluatedProperties closes AgentConfig to its listed keys.
  return {
    ...local,
    $defs: { ...defs, AgentConfig: { ...(defs.AgentConfig as JsonSchema), additionalProperties: false } },
  }
}

async function types(source: string, schema: JsonSchema, name: string): Promise<string> {
  const {
    $id: _,
    title: __,
    $schema: ___,
    ...root
  } = withoutKeys(defaultsRequired(forTypes(schema)), ['default'])
  const body = await compile(root, name, { bannerComment: '', format: false, ignoreMinAndMaxItems: true })
  return `// Generated from ${relative(ROOT, source)} by \`bun run gen\`; do not edit.\n${body}`
}

export function layerSchema(config: JsonSchema): JsonSchema {
  const { $id, title: _, description: __, ...rest } = withoutKeys(config, ['required', 'default'])
  return {
    $comment: `Generated from config.schema.json by \`bun run gen\`; do not edit.`,
    $id: `${$id}/layer`,
    title: 'nightshift configuration layer',
    description:
      'One layer (defaults or user file); every key is optional, the merged result must be complete.',
    ...rest,
  }
}

function format(path: string, text: string): string {
  const res = Bun.spawnSync([BIOME, 'format', `--stdin-file-path=${path}`], {
    cwd: ROOT,
    stdin: Buffer.from(text),
  })
  if (res.exitCode !== 0) throw new Error(`biome format ${path}: ${res.stderr.toString()}`)
  return res.stdout.toString()
}

export async function generate(): Promise<Generated[]> {
  const config = readSchema(CONFIG_SCHEMA_PATH)
  const outputs: Generated[] = [
    { path: LAYER_SCHEMA_PATH, content: JSON.stringify(layerSchema(config)) },
    {
      path: join(import.meta.dir, 'config/generated/config.ts'),
      content: await types(CONFIG_SCHEMA_PATH, config, 'Config'),
    },
    {
      path: join(import.meta.dir, 'agents/generated/agent.ts'),
      content: await types(AGENT_SCHEMA, bundleOpenCodeAgent(readSchema(AGENT_SCHEMA)), 'AgentFrontmatter'),
    },
    {
      path: join(import.meta.dir, 'agents/generated/finish.ts'),
      content: await types(FINISH_SCHEMA, readSchema(FINISH_SCHEMA), 'FinishPayload'),
    },
    ...(await Promise.all(
      ['duplicate-judge', 'intake'].map(async (agent) => {
        const source = join(ROOT, 'schemas', `${agent}.json`)
        const name = agent === 'duplicate-judge' ? 'DuplicateJudgeOutput' : 'IntakeOutput'
        return {
          path: join(import.meta.dir, 'agents/generated', `${agent}.ts`),
          content: await types(source, readSchema(source), name),
        }
      }),
    )),
    {
      path: join(import.meta.dir, 'stacks/generated/stack.ts'),
      content: await types(STACK_SCHEMA, readSchema(STACK_SCHEMA), 'StackFile'),
    },
    {
      path: join(ROOT, 'packages/supervisor/src/state/generated/events.ts'),
      content: await types(EVENTS_SCHEMA, readSchema(EVENTS_SCHEMA), 'EventRecord'),
    },
    {
      path: join(ROOT, 'packages/supervisor/src/control/generated/control.ts'),
      content: await types(CONTROL_SCHEMA, readSchema(CONTROL_SCHEMA), 'ControlApi'),
    },
    {
      path: join(ROOT, 'packages/supervisor/src/state/generated/records.ts'),
      content: await types(RECORDS_SCHEMA, readSchema(RECORDS_SCHEMA), 'CliRecords'),
    },
  ]
  return outputs.map((o) => ({ path: o.path, content: format(o.path, o.content) }))
}

if (import.meta.main) {
  for (const { path, content } of await generate()) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}
