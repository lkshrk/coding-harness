import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { activeProfile, type FetchLike, loadAgents } from '@nightshift/core'
import type { FailureSignal } from '../../ports'
import type { Event } from '../../state/events'
import { testConfig } from '../../testing/testing'
import { agentClassifier } from './classifier'

const { agents } = loadAgents(join(import.meta.dir, '../../../../../agents'))
const failure: FailureSignal = {
  run: {
    id: '01K6PQ94000000000000000000',
    issue: 'FOR-1',
    agent: 'implementer',
    profile: 'default',
    model: 'worker',
    repository: 'omni',
    baseSha: 'base',
    attempt: 1,
    state: 'failed',
    sandbox: null,
    session: null,
    headSha: null,
    finish: null,
    failure: null,
    startedAt: '2026-10-05T00:00:00.000Z',
    endedAt: null,
    tokensIn: 0,
    tokensOut: 0,
  },
  reason: 'crash',
  detail: 'registry unavailable',
}

function classifier(reply: string | Error, timeoutMs?: number) {
  const calls: Record<string, unknown>[] = []
  const logs: string[] = []
  const events: Event[] = [
    {
      id: 'event',
      ts: '2026-10-05T00:00:00.000Z',
      type: 'WORKER_FAILED',
      run: failure.run.id,
      issue: 'FOR-1',
      data: { reason: 'crash', detail: 'recent failure evidence' },
    },
  ]
  const fetch: FetchLike = async (url, init) => {
    calls.push(JSON.parse(String(init.body)))
    if (url.endsWith('/utils/token_counter')) return Response.json({ total_tokens: 100 })
    if (reply instanceof Error) throw reply
    if (timeoutMs !== undefined) return new Promise(() => {})
    return Response.json({ choices: [{ message: { content: reply } }] })
  }
  const config = testConfig()
  activeProfile(config.profiles).profile.roles.classifier = 'ns/reviewer'
  const instance = agentClassifier({
    config: () => config,
    agents,
    gateway: async () => ({ baseUrl: 'https://gateway.test/v1', apiKey: 'host-key', fetch }),
    events: (run) => {
      expect(run).toBe(failure.run.id)
      return events
    },
    out: (line) => logs.push(line),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
  return { instance, calls, logs }
}

describe('agent classifier', () => {
  test('uses the schema-valid class and includes the run, reason, detail and recent events', async () => {
    const h = classifier(JSON.stringify({ class: 'environment', evidence: 'registry unavailable' }))
    expect(await h.instance.classify(failure)).toEqual({
      class: 'environment',
      evidence: 'registry unavailable',
      action: 'retry_same',
      fallback: false,
    })
    const request = h.calls[1] as { messages: { content: string }[]; response_format: unknown }
    expect(request.response_format).toBeDefined()
    const input = request.messages[1]?.content ?? ''
    for (const value of [failure.run.id, failure.reason, failure.detail, 'recent failure evidence']) {
      expect(input).toContain(value as string)
    }
    expect(h.logs).toEqual([])
  })

  test.each(['not json', '{"class":"invented","evidence":"bad"}', '{"class":"environment"}'])(
    'falls back and logs invalid output: %s',
    async (reply) => {
      const h = classifier(reply)
      expect(await h.instance.classify(failure)).toEqual({
        class: 'unknown',
        action: 'escalate_user',
        fallback: true,
      })
      expect(h.calls).toHaveLength(3)
      expect(h.logs[0]).toContain('invalid_output')
    },
  )

  test('falls back and logs a gateway error', async () => {
    const h = classifier(new Error('gateway offline'))
    expect(await h.instance.classify(failure)).toEqual({
      class: 'unknown',
      action: 'escalate_user',
      fallback: true,
    })
    expect(h.logs[0]).toContain('gateway_error')
  })

  test('times out even if the gateway does not settle', async () => {
    const h = classifier('', 5)
    expect(await h.instance.classify(failure)).toEqual({
      class: 'unknown',
      action: 'escalate_user',
      fallback: true,
    })
    expect(h.logs[0]).toContain('timed out')
  })
})
