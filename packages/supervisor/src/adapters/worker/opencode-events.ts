import { createHash } from 'node:crypto'
import type { HarnessEvent } from '../../ports'

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function argsDigest(tool: string, input: unknown): string {
  return createHash('sha256')
    .update(`${tool}\0${stableJson(input)}`)
    .digest('hex')
    .slice(0, 16)
}

type RawEvent = { type?: string; data?: Record<string, unknown> }

type Tokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

function errorMessage(data: Record<string, unknown>): string {
  const e = data.error
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  return typeof data.message === 'string' ? data.message : JSON.stringify(e ?? data).slice(0, 300)
}

export class EventMapper {
  private readonly tools = new Map<string, string>()
  private steps = 0

  constructor(private readonly sessionId: string) {}

  map(raw: unknown): HarnessEvent[] {
    const { type, data } = raw as RawEvent
    if (!type || !data || data.sessionID !== this.sessionId) return []
    switch (type) {
      case 'session.tool.input.started':
        this.tools.set(String(data.id), String(data.name))
        return []
      case 'session.tool.called': {
        const tool = this.tools.get(String(data.id)) ?? 'unknown'
        return [{ kind: 'tool_call', tool, argsDigest: argsDigest(tool, data.input) }]
      }
      case 'session.tool.success':
      case 'session.tool.failed':
        return [
          {
            kind: 'tool_result',
            tool: this.tools.get(String(data.id)) ?? 'unknown',
            ok: type === 'session.tool.success',
          },
        ]
      case 'session.step.ended': {
        const t = (data.tokens ?? {}) as Tokens
        this.steps += 1
        return [
          {
            kind: 'step',
            step: this.steps,
            tokensIn: (t.input ?? 0) + (t.cache?.write ?? 0),
            tokensOut: (t.output ?? 0) + (t.reasoning ?? 0),
          },
        ]
      }
      case 'session.text.ended':
        return [{ kind: 'text', chars: typeof data.text === 'string' ? data.text.length : 0 }]
      case 'session.step.failed':
        return [{ kind: 'error', message: errorMessage(data), fatal: false }]
      case 'session.execution.failed':
        return [{ kind: 'error', message: errorMessage(data), fatal: true }]
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        return [{ kind: 'idle', sinceMs: 0 }]
      default:
        return []
    }
  }
}
