import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadAgents } from './load'
import { type FetchLike, runSingleCall } from './single-call'
import type { AgentDef } from './types'

const { agents } = loadAgents(join(import.meta.dir, 'fixtures/valid/agents'))
const classifier = agents.get('classifier') as AgentDef
const jsonOnly: AgentDef = { ...classifier, reasoning: 'json_only' }
const profile = { name: 'default', profile: { roles: { classifier: 'ns/small' }, models: {} } }

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function fakeGateway(replies: (string | Response)[], tokens = 100): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    })
    if (url.endsWith('/utils/token_counter')) return Response.json({ total_tokens: tokens })
    const reply = replies.shift()
    if (reply === undefined) throw new Error('unexpected call')
    if (reply instanceof Response) return reply
    return Response.json({
      id: `resp-${calls.length}`,
      choices: [{ message: { role: 'assistant', content: reply } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  }
  return { fetch, calls }
}

function gateway(fetch: FetchLike, baseUrl = 'https://gw.test/v1') {
  return { baseUrl, apiKey: 'sk-test', fetch }
}

const valid = { class: 'environment', reason: 'npm registry unreachable' }

describe('runSingleCall', () => {
  test('json_only: returns the parsed object and the trace', async () => {
    const gw = fakeGateway([JSON.stringify(valid)])
    const r = await runSingleCall(jsonOnly, 'task', { profile, gateway: gateway(gw.fetch), sessionId: 's1' })
    expect(r).toEqual({
      ok: true,
      output: valid,
      trace: {
        sessionId: 's1',
        inputTokens: 100,
        calls: [
          {
            id: 'resp-2',
            content: JSON.stringify(valid),
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ],
      },
    })
  })

  test('base_url includes /v1: chat appends to it, the token counter strips it', async () => {
    for (const baseUrl of ['https://gw.test/v1', 'https://gw.test/v1/']) {
      const gw = fakeGateway([JSON.stringify(valid)])
      await runSingleCall(jsonOnly, 'task', { profile, gateway: gateway(gw.fetch, baseUrl) })
      expect(gw.calls.map((c) => c.url)).toEqual([
        'https://gw.test/utils/token_counter',
        'https://gw.test/v1/chat/completions',
      ])
    }
  })

  test('sends system, user, model, temperature and the json schema', async () => {
    const gw = fakeGateway([JSON.stringify(valid)])
    await runSingleCall(jsonOnly, 'the task', { profile, gateway: gateway(gw.fetch), sessionId: 's1' })
    const [count, chat] = gw.calls
    expect(count?.url).toBe('https://gw.test/utils/token_counter')
    expect(count?.body).toEqual({ model: 'ns/small', messages: [{ role: 'user', content: 'the task' }] })
    expect(chat?.url).toBe('https://gw.test/v1/chat/completions')
    expect(chat?.headers).toMatchObject({
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
      'x-litellm-session-id': 's1',
    })
    expect(chat?.body).toEqual({
      model: 'ns/small',
      temperature: 0,
      messages: [
        { role: 'system', content: classifier.body },
        { role: 'user', content: 'the task' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'classifier', schema: classifier.output },
      },
    })
  })

  test('free_then_json: parses the last fenced json block', async () => {
    const reply = `Gates show a DNS error.\n\`\`\`json\n{"class":"unknown","reason":"x"}\n\`\`\`\nThen:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n`
    const gw = fakeGateway([reply])
    const r = await runSingleCall(classifier, 'task', { profile, gateway: gateway(gw.fetch) })
    expect(r.ok && r.output).toEqual(valid)
    expect(gw.calls[1]?.body).not.toHaveProperty('response_format')
    expect(r.ok && r.trace.calls[0]?.content).toBe(reply)
  })

  test('free_then_json: a fence inside a JSON string does not end the block', async () => {
    const out = { class: 'unknown', reason: 'ran ```sh\nbun test\n``` and it hung' }
    const gw = fakeGateway([`Unclear.\n\`\`\`json\n${JSON.stringify(out, null, 2)}\n\`\`\`\n`])
    const r = await runSingleCall(classifier, 'task', { profile, gateway: gateway(gw.fetch) })
    expect(r.ok && r.output).toEqual(out)
  })

  test('retries once with the validation errors, then succeeds', async () => {
    const gw = fakeGateway(['{"class":"weather"}', JSON.stringify(valid)])
    const r = await runSingleCall(jsonOnly, 'task', { profile, gateway: gateway(gw.fetch) })
    expect(r.ok).toBe(true)
    const retry = gw.calls[2]?.body.messages as { role: string; content: string }[]
    expect(retry.slice(2, 3)).toEqual([{ role: 'assistant', content: '{"class":"weather"}' }])
    expect(retry[3]?.role).toBe('user')
    expect(retry[3]?.content).toContain('class: ')
    expect(retry[3]?.content).toContain('reason: ')
  })

  test('invalid twice: invalid_output', async () => {
    const gw = fakeGateway(['not json', '{"class":"weather"}'])
    const r = await runSingleCall(jsonOnly, 'task', { profile, gateway: gateway(gw.fetch) })
    expect(r).toMatchObject({ ok: false, reason: 'invalid_output' })
    expect(!r.ok && r.trace?.calls.length).toBe(2)
    expect(gw.calls.length).toBe(3)
  })

  test('missing json block counts as invalid', async () => {
    const gw = fakeGateway(['no block here', 'still none'])
    const r = await runSingleCall(classifier, 'task', { profile, gateway: gateway(gw.fetch) })
    expect(r).toMatchObject({ ok: false, reason: 'invalid_output' })
  })

  test('json_only accepts a reply wrapped in one json fence', async () => {
    const gw = fakeGateway([`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``])
    const r = await runSingleCall(jsonOnly, 'task', { profile, gateway: gateway(gw.fetch) })
    expect(r.ok && r.output).toEqual(valid)
  })

  test('input over budget: no model call', async () => {
    const gw = fakeGateway([], 9000)
    const r = await runSingleCall(jsonOnly, 'task', { profile, gateway: gateway(gw.fetch) })
    expect(r).toMatchObject({ ok: false, reason: 'input_over_budget', tokens: 9000 })
    expect(gw.calls.length).toBe(1)
  })

  test('gateway error status', async () => {
    const gw = fakeGateway([new Response('boom', { status: 502 })])
    const r = await runSingleCall(jsonOnly, 'task', { profile, gateway: gateway(gw.fetch) })
    expect(r).toMatchObject({ ok: false, reason: 'gateway_error' })
    expect(!r.ok && r.detail).toContain('502')
  })

  test('network failure is a gateway error', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }
    const r = await runSingleCall(jsonOnly, 'task', { profile, gateway: gateway(fetch) })
    expect(r).toMatchObject({ ok: false, reason: 'gateway_error' })
    expect(!r.ok && r.detail).toContain('ECONNREFUSED')
  })

  test('validates against an explicit JSON Schema', async () => {
    const schema = {
      type: 'object',
      required: ['class', 'reason'],
      properties: { class: { const: 'environment' }, reason: { type: 'string' } },
    }
    const gw = fakeGateway([JSON.stringify(valid)])
    const r = await runSingleCall<{ class: 'environment'; reason: string }>(jsonOnly, 'task', {
      profile,
      gateway: gateway(gw.fetch),
      schema,
    })
    if (!r.ok) throw new Error(r.detail)
    const out: { class: 'environment'; reason: string } = r.output
    expect(out).toEqual(valid as never)
  })

  test('rejects agents that are not single_call', async () => {
    const worker = { ...classifier, kind: 'worker' as const }
    const gw = fakeGateway([])
    expect(runSingleCall(worker, 'task', { profile, gateway: gateway(gw.fetch) })).rejects.toThrow(
      'single_call',
    )
  })

  test('rejects a role missing from the profile', async () => {
    const gw = fakeGateway([])
    expect(
      runSingleCall(jsonOnly, 'task', {
        profile: { name: 'p', profile: { roles: { worker: 'x' }, models: {} } },
        gateway: gateway(gw.fetch),
      }),
    ).rejects.toThrow("nightshift.role: 'classifier' not in profile p")
  })
})
