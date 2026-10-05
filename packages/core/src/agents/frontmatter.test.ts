import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import { parse } from 'yaml'
import { splitFrontmatter, validateFrontmatter } from './frontmatter'

const SPECS = join(import.meta.dir, '../../schema')
const FIXTURES = join(import.meta.dir, 'fixtures')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function specValidator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  ajv.addSchema(readJson(join(SPECS, 'vendor/models-dev-model.schema.json')))
  ajv.addSchema(
    readJson(join(SPECS, 'vendor/opencode-config.schema.json')),
    'https://nightshift.local/schema/agent/vendor/opencode-config.schema.json',
  )
  return ajv.compile(readJson(join(SPECS, 'agent.schema.json')))
}

function fixtureFrontmatters(): [string, unknown][] {
  const out: [string, unknown][] = []
  for (const set of ['valid', 'invalid']) {
    const dir = join(FIXTURES, set, 'agents')
    for (const f of readdirSync(dir).sort()) {
      const split = splitFrontmatter(readFileSync(join(dir, f), 'utf8'))
      if (split) out.push([`${set}/${f}`, parse(split.frontmatter)])
    }
  }
  return out
}

const SCHEMA_INVALID = new Set([
  'invalid/single-call-permission.md',
  'invalid/worker-no-steps.md',
  'invalid/model-set.md',
  'invalid/unknown-key.md',
  'invalid/short-description.md',
  'invalid/interactive-output.md',
  'invalid/bad-role.md',
  'invalid/bad-permission.md',
])

describe('validateFrontmatter agrees with agent.schema.json', () => {
  const spec = specValidator()
  test.each(fixtureFrontmatters())('%s', (name, data) => {
    const ours = validateFrontmatter(data).ok
    expect({ name, ours }).toEqual({ name, ours: spec(data) })
    expect(ours).toBe(!SCHEMA_INVALID.has(name))
  })

  test.each([
    ['bare permission action', { permission: 'deny' }, 'worker'],
    ['action-only key with object', { permission: { webfetch: { '*': 'allow' } } }, 'worker'],
    ['hex color', { color: '#ff5733' }, 'worker'],
    ['bad color', { color: 'pink' }, 'worker'],
    ['zero steps', { steps: 0 }, 'worker'],
    ['tools', { tools: { bash: true } }, 'worker'],
    ['reasoning on interactive', { nightshift: { reasoning: 'json_only' } }, 'interactive'],
    ['grace_turns on single_call', { nightshift: { grace_turns: 1 } }, 'single_call'],
    ['skills on single_call', { nightshift: { skills: ['x'] } }, 'single_call'],
    ['duplicate skills', { nightshift: { skills: ['x', 'x'] } }, 'worker'],
    ['grace_turns 3', { nightshift: { grace_turns: 3 } }, 'worker'],
    ['budget too small', { nightshift: { budget: { prompt_words: 10, input_tokens: 6000 } } }, 'worker'],
    ['bad output path', { nightshift: { output: 'out.json' } }, 'worker'],
    [
      'fractional input tokens',
      { nightshift: { budget: { prompt_words: 100, input_tokens: 1000.5 } } },
      'worker',
    ],
  ])('inline case: %s', (_, patch, kind) => {
    const data = withPatch(kind as Kind, patch)
    expect(validateFrontmatter(data).ok).toBe(spec(data))
  })
})

type Kind = 'worker' | 'single_call' | 'interactive'

function baseFor(kind: Kind): Record<string, unknown> {
  const budget = { prompt_words: 400, input_tokens: 6000 }
  if (kind === 'single_call') {
    return {
      description: 'Classifies a failed run into one class.',
      nightshift: { kind, role: 'classifier', output: 'schemas/classifier.json', budget },
    }
  }
  if (kind === 'interactive') {
    return {
      description: 'Plans features with you.',
      permission: 'ask',
      nightshift: { kind, role: 'lead', budget },
    }
  }
  return {
    description: 'Implements one feature issue.',
    steps: 40,
    permission: { '*': 'allow' },
    nightshift: { kind, role: 'worker', budget },
  }
}

function withPatch(kind: Kind, patch: Record<string, unknown>): Record<string, unknown> {
  const base = baseFor(kind)
  const { nightshift, ...rest } = patch
  return {
    ...base,
    ...rest,
    nightshift: { ...(base.nightshift as object), ...(nightshift as object | undefined) },
  }
}

describe('validateFrontmatter messages', () => {
  function issues(data: unknown): string[] {
    const r = validateFrontmatter(data)
    return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`)
  }

  test('forbids a permission block on single_call', () => {
    expect(issues(withPatch('single_call', { permission: { '*': 'deny' } }))).toContain(
      'permission: not allowed for kind single_call',
    )
  })

  test('requires steps on workers', () => {
    const { steps: _, ...data } = baseFor('worker')
    expect(issues(data)).toContain('steps: required for kind worker')
  })

  test('rejects renderer-owned keys', () => {
    expect(issues(withPatch('worker', { model: 'litellm/x' }))).toContain(
      'model: set by the profile, remove it',
    )
    expect(issues(withPatch('worker', { prompt: 'x' }))).toContain('prompt: set by the renderer, remove it')
  })

  test('names unknown keys', () => {
    expect(issues(withPatch('worker', { nightshift: { main_skill: 'x' } }))).toContain(
      'nightshift.main_skill: unknown key',
    )
  })

  test('reports kind rules together with other issues', () => {
    const { steps: _, ...data } = withPatch('worker', { description: 'short' })
    expect(issues(data)).toEqual(
      expect.arrayContaining(['steps: required for kind worker', expect.stringMatching(/^description: /)]),
    )
  })

  test('applies defaults', () => {
    const r = validateFrontmatter(baseFor('worker'))
    if (!r.ok) throw new Error('expected valid')
    expect(r.value.nightshift).toMatchObject({ skills: [], reasoning: 'json_only', grace_turns: 1 })
  })
})

describe('splitFrontmatter', () => {
  test('splits frontmatter and body', () => {
    expect(splitFrontmatter('---\na: 1\n---\nbody\n')).toEqual({ frontmatter: 'a: 1\n', body: 'body\n' })
  })

  test('accepts CRLF line endings', () => {
    expect(splitFrontmatter('---\r\na: 1\r\n---\r\nbody')).toEqual({ frontmatter: 'a: 1\r\n', body: 'body' })
  })

  test('returns undefined without frontmatter', () => {
    expect(splitFrontmatter('body\n---\n')).toBeUndefined()
    expect(splitFrontmatter('---\na: 1\n')).toBeUndefined()
  })
})
