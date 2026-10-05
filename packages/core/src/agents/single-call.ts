import { outputValidator } from './finish'
import { issueLines } from './issues'
import { type ActiveProfile, AgentConfigError, resolveAlias } from './render'
import type { AgentDef, JsonSchema } from './types'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type Gateway = { baseUrl: string; apiKey: string; fetch?: FetchLike }

export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

export type TraceRef = {
  sessionId: string
  inputTokens?: number
  calls: { id?: string; content: string; usage?: Usage }[]
}

export type SingleCallFailure = 'invalid_output' | 'input_over_budget' | 'gateway_error'

export type SingleCallResult<T> =
  | { ok: true; output: T; trace: TraceRef }
  | {
      ok: false
      reason: SingleCallFailure
      detail: string
      errors?: string[]
      tokens?: number
      trace?: TraceRef
    }

export type SingleCallOptions = {
  profile: ActiveProfile
  gateway: Gateway
  schema?: JsonSchema
  sessionId?: string
}

type Message = { role: 'system' | 'user' | 'assistant'; content: string }

export class GatewayError extends Error {
  override name = 'GatewayError'
}

async function post(gw: Gateway, url: string, body: unknown, sessionId: string): Promise<unknown> {
  const fetch = gw.fetch ?? globalThis.fetch
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.apiKey}`,
        'content-type': 'application/json',
        'x-litellm-session-id': sessionId,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new GatewayError(`${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) throw new GatewayError(`${url}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  try {
    return await res.json()
  } catch {
    throw new GatewayError(`${url}: response is not JSON`)
  }
}

export async function countTokens(
  gw: Gateway,
  model: string,
  text: string,
  sessionId: string,
): Promise<number> {
  const url = `${gw.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/utils/token_counter`
  const counted = (await post(
    gw,
    url,
    { model, messages: [{ role: 'user', content: text }] },
    sessionId,
  )) as {
    total_tokens?: unknown
  }
  if (typeof counted.total_tokens !== 'number')
    throw new GatewayError('token counter returned no total_tokens')
  return counted.total_tokens
}

function extractJson(
  reasoning: AgentDef['reasoning'],
  content: string,
): { value: unknown } | { error: string } {
  let text: string
  if (reasoning === 'free_then_json') {
    const blocks = [...content.matchAll(/```json[^\S\n]*\n([\s\S]*?)^```/gm)]
    const last = blocks.at(-1)?.[1]
    if (last === undefined) return { error: 'no fenced json block in the response' }
    text = last
  } else {
    const trimmed = content.trim()
    text = /^```(?:json)?[^\S\n]*\n([\s\S]*?)```$/.exec(trimmed)?.[1] ?? trimmed
  }
  try {
    return { value: JSON.parse(text) }
  } catch (e) {
    return { error: `response is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function retryMessage(reasoning: AgentDef['reasoning'], errors: string[]): string {
  const ask =
    reasoning === 'free_then_json'
      ? 'Reply again and end with one fenced json block containing the corrected object.'
      : 'Reply again with the corrected JSON object only.'
  return `Your previous response was invalid:\n${errors.map((e) => `- ${e}`).join('\n')}\n${ask}`
}

export async function runSingleCall<T = unknown>(
  def: AgentDef,
  input: string,
  opts: SingleCallOptions,
): Promise<SingleCallResult<T>> {
  if (def.kind !== 'single_call')
    throw new AgentConfigError(`${def.file}: kind ${def.kind} is not single_call`)
  const model = resolveAlias(def, opts.profile)
  const schema = opts.schema ?? def.output
  if (!schema) throw new AgentConfigError(`${def.file}: nightshift.output: schema not loaded`)
  const validate = outputValidator(schema)

  const base = opts.gateway.baseUrl.replace(/\/+$/, '')
  const trace: TraceRef = { sessionId: opts.sessionId ?? crypto.randomUUID(), calls: [] }
  const send = (url: string, body: unknown) => post(opts.gateway, url, body, trace.sessionId)

  try {
    const tokens = await countTokens(opts.gateway, model, input, trace.sessionId)
    trace.inputTokens = tokens
    if (tokens > def.budget.inputTokens) {
      return {
        ok: false,
        reason: 'input_over_budget',
        detail: `input has ${tokens} tokens, budget ${def.budget.inputTokens}`,
        tokens,
        trace,
      }
    }

    const messages: Message[] = [
      { role: 'system', content: def.body },
      { role: 'user', content: input },
    ]
    const request = {
      model,
      ...(def.opencode.temperature === undefined ? {} : { temperature: def.opencode.temperature }),
      ...(def.opencode.top_p === undefined ? {} : { top_p: def.opencode.top_p }),
      ...(def.reasoning === 'json_only'
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: def.name, schema: def.output ?? schema },
            },
          }
        : {}),
    }

    let errors: string[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = (await send(`${base}/chat/completions`, { ...request, messages })) as {
        id?: unknown
        choices?: { message?: { content?: unknown } }[]
        usage?: Usage
      }
      const raw = res.choices?.[0]?.message?.content
      const content = typeof raw === 'string' ? raw : ''
      trace.calls.push({
        ...(typeof res.id === 'string' ? { id: res.id } : {}),
        content,
        ...(res.usage ? { usage: res.usage } : {}),
      })
      const extracted = extractJson(def.reasoning, content)
      if ('value' in extracted) {
        const issues = validate(extracted.value)
        if (issues.length === 0) return { ok: true, output: extracted.value as T, trace }
        errors = issueLines(issues)
      } else {
        errors = [extracted.error]
      }
      messages.push(
        { role: 'assistant', content },
        { role: 'user', content: retryMessage(def.reasoning, errors) },
      )
    }
    return { ok: false, reason: 'invalid_output', detail: errors.join('; '), errors, trace }
  } catch (e) {
    if (e instanceof GatewayError) return { ok: false, reason: 'gateway_error', detail: e.message, trace }
    throw e
  }
}
