import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { EVENT_TYPES, EVENTS_SCHEMA_PATH, validateEvent } from './event-schema'

const RUN = '01J9ZQ3W5C8XKQG4M2N7P6R1ST'

describe('validateEvent', () => {
  test('PR events preserve source metadata for closeout', () => {
    for (const type of ['PR_CREATED', 'MERGED'] as const) {
      expect(
        validateEvent({
          type,
          issue: 'FOR-42',
          data: {
            url: 'https://example.test/pr/1',
            branch: 'fix',
            title: 'Fix',
            body: 'Details',
            mergeSha: 'abc',
          },
        }),
      ).toEqual([])
    }
  })

  test('vault ingest events require an issue and their own payload', () => {
    for (const [type, data] of [
      ['VAULT_INGEST_STARTED', {}],
      ['VAULT_INGESTED', { commits: ['abc'] }],
      ['VAULT_INGEST_FAILED', { reason: 'lint failed' }],
    ] as const) {
      expect(validateEvent({ type, issue: 'FOR-42', data })).toEqual([])
      expect(validateEvent({ type, data })).toContain(`issue: required for ${type}`)
    }
    expect(validateEvent({ type: 'VAULT_INGESTED', issue: 'FOR-42', data: {} })).not.toEqual([])
    expect(validateEvent({ type: 'VAULT_INGESTED', issue: 'FOR-42', data: { commits: [1] } })).not.toEqual([])
    expect(validateEvent({ type: 'VAULT_INGEST_FAILED', issue: 'FOR-42', data: {} })).not.toEqual([])
    expect(
      validateEvent({ type: 'VAULT_INGEST_STARTED', issue: 'FOR-42', data: { extra: true } }),
    ).not.toEqual([])
  })

  test('EVENT_TYPES matches the schema enum', () => {
    const schema = JSON.parse(readFileSync(EVENTS_SCHEMA_PATH, 'utf8'))
    expect([...EVENT_TYPES]).toEqual(schema.$defs.eventType.enum)
  })

  test('accepts a valid event per type shape', () => {
    expect(validateEvent({ type: 'SUPERVISOR_STARTED', data: { version: '0.0.0' } })).toEqual([])
    expect(
      validateEvent({
        type: 'DISPATCHED',
        issue: 'FOR-42',
        run: RUN,
        data: { agent: 'implementer', profile: 'default', model: 'm', attempt: 1, repository: 'omni' },
      }),
    ).toEqual([])
    expect(
      validateEvent({
        type: 'FAILURE_CLASSIFIED',
        issue: 'FOR-42',
        run: RUN,
        data: { class: 'environment', action: 'retry_same' },
      }),
    ).toEqual([])
  })

  test('rejects data that does not match its type', () => {
    expect(
      validateEvent({ type: 'LEASE_ACQUIRED', issue: 'FOR-1', data: { holder: 'a', expires: 'never' } }),
    ).not.toEqual([])
    expect(
      validateEvent({
        type: 'FAILURE_CLASSIFIED',
        issue: 'FOR-42',
        run: RUN,
        data: { class: 'bad', action: 'retry_same' },
      }),
    ).not.toEqual([])
    expect(validateEvent({ type: 'CONFIG_RELOADED', data: { extra: true } })).not.toEqual([])
  })

  test('requires issue and run where the schema does', () => {
    const errors = validateEvent({ type: 'WORKER_FAILED', data: { reason: 'crash' } })
    expect(errors).toContain('issue: required for WORKER_FAILED')
    expect(errors).toContain('run: required for WORKER_FAILED')
  })

  test('checks the envelope', () => {
    expect(validateEvent({ type: 'NOPE' as never, data: {} })).toEqual(["type: unknown event type 'NOPE'"])
    expect(validateEvent({ type: 'SUPERVISOR_STARTED', issue: 'for-1', data: {} })).toContain(
      'issue: must be a Linear identifier',
    )
    expect(validateEvent({ type: 'SUPERVISOR_STARTED', run: 'x', data: {} })).toContain('run: must be a ULID')
  })

  test('validates WORKER_FINISHED data as a finish payload', () => {
    const base = { type: 'WORKER_FINISHED' as const, issue: 'FOR-42', run: RUN }
    expect(
      validateEvent({
        ...base,
        data: { status: 'DONE', summary: 's', evidence: [{ kind: 'test', ref: 't', result: 'pass' }] },
      }),
    ).toEqual([])
    expect(validateEvent({ ...base, data: { status: 'BLOCKED', summary: 's', evidence: [] } })).toContain(
      'data.blocker: required for status BLOCKED',
    )
  })
})
