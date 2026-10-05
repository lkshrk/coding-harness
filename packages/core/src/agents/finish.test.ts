import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import { FINISH_STATUSES, finishToolInput, validateFinish } from './finish'

const SPEC = join(import.meta.dir, '../../schema/finish.schema.json')

const done = {
  status: 'DONE',
  summary: 'Fixed the off-by-one in pagination.',
  evidence: [{ kind: 'test', ref: 'pagination.test.ts', result: 'pass' }],
}

const CASES: [string, unknown][] = [
  ['done', done],
  ['done with all fields', { ...done, changed_files: ['a.ts'], concerns: ['slow'], report: { a: 1 } }],
  ['done without evidence', { ...done, evidence: [] }],
  ['concerns', { ...done, status: 'DONE_WITH_CONCERNS', concerns: ['flaky test'] }],
  ['concerns missing', { ...done, status: 'DONE_WITH_CONCERNS' }],
  ['concerns empty', { ...done, status: 'DONE_WITH_CONCERNS', concerns: [] }],
  [
    'blocked',
    { ...done, status: 'BLOCKED', evidence: [], blocker: { needs: 'permission', reason: 'no net' } },
  ],
  ['blocked without blocker', { ...done, status: 'BLOCKED', evidence: [] }],
  ['needs context without blocker', { ...done, status: 'NEEDS_CONTEXT' }],
  [
    'needs context with question',
    {
      ...done,
      status: 'NEEDS_CONTEXT',
      blocker: { needs: 'context', reason: 'unclear', question: 'Which API?' },
    },
  ],
  ['unknown status', { ...done, status: 'FAILED' }],
  ['extra key', { ...done, extra: 1 }],
  ['empty summary', { ...done, summary: '' }],
  ['long summary', { ...done, summary: 'x'.repeat(401) }],
  ['bad evidence kind', { ...done, evidence: [{ kind: 'vibe', ref: 'x', result: 'pass' }] }],
  ['evidence extra key', { ...done, evidence: [{ kind: 'test', ref: 'x', result: 'pass', why: 1 }] }],
  ['duplicate changed files', { ...done, changed_files: ['a.ts', 'a.ts'] }],
  ['report array', { ...done, report: [] }],
  ['blocker missing reason', { ...done, status: 'BLOCKED', blocker: { needs: 'context' } }],
  ['not an object', 'DONE'],
]

describe('validateFinish agrees with finish.schema.json', () => {
  const spec = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(SPEC, 'utf8')))
  test.each(CASES)('%s', (_, payload) => {
    expect(validateFinish({}, payload).ok).toBe(spec(payload))
  })

  test('the tool input is the spec without metadata and conditional rules', () => {
    const { $schema: _, $id: __, title: ___, allOf: ____, ...rest } = JSON.parse(readFileSync(SPEC, 'utf8'))
    expect(finishToolInput).toEqual(rest)
  })

  test('status enum matches the spec', () => {
    const schema = JSON.parse(readFileSync(SPEC, 'utf8'))
    expect([...FINISH_STATUSES]).toEqual(schema.properties.status.enum)
  })
})

describe('validateFinish', () => {
  test('returns the parsed payload', () => {
    expect(validateFinish({}, done)).toEqual({ ok: true, value: done as never })
  })

  test('explains a missing blocker', () => {
    expect(validateFinish({}, { ...done, status: 'BLOCKED' })).toEqual({
      ok: false,
      errors: ['blocker: required for status BLOCKED'],
    })
  })

  test('validates report against the agent output schema', () => {
    const output = {
      type: 'object',
      required: ['files'],
      properties: { files: { type: 'array', items: { type: 'string' } } },
    }
    expect(validateFinish({ output }, { ...done, report: { files: ['a.ts'] } }).ok).toBe(true)
    const bad = validateFinish({ output }, { ...done, report: { files: [1] } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors[0]).toStartWith('report.files[0]: ')
  })
})
