import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import YAML from 'yaml'
import { configJsonSchema, layerJsonSchema } from './schema'
import { FIXTURES, readFixture, setPath, unsetPath } from './testing'
import { parseConfig } from './validate'

type Patch = { name: string; set?: Record<string, unknown>; unset?: string[] }

function compile(schema: object) {
  return new Ajv2020({ strict: false, allErrors: true }).compile(schema)
}

const spec = compile(configJsonSchema())

const valid = readdirSync(join(FIXTURES, 'valid')).map((file) => ({
  name: file,
  data: readFixture(`valid/${file}`),
}))

const invalid = (YAML.parse(readFileSync(join(FIXTURES, 'invalid.yaml'), 'utf8')) as Patch[]).map((p) => {
  const data = readFixture('valid/minimal.yaml')
  for (const [path, value] of Object.entries(p.set ?? {})) setPath(data, path, value)
  for (const path of p.unset ?? []) unsetPath(data, path)
  return { name: p.name, data }
})

describe('valid fixtures', () => {
  test.each(valid)('$name is accepted by the spec and parseConfig', ({ data }) => {
    expect(spec(data)).toBe(true)
    expect(() => parseConfig(data)).not.toThrow()
  })
})

describe('invalid fixtures', () => {
  test.each(invalid)('$name is rejected by the spec and parseConfig', ({ data }) => {
    expect(spec(data)).toBe(false)
    expect(() => parseConfig(data)).toThrow()
  })
})

describe('layer schema', () => {
  test('accepts a partial layer and rejects unknown keys', () => {
    const layer = compile(layerJsonSchema())
    expect(layer({ limits: { concurrency: 2 } })).toBe(true)
    expect(layer({ github: { default: 'work' } })).toBe(true)
    expect(layer({ repositoris: {} })).toBe(false)
  })
})
