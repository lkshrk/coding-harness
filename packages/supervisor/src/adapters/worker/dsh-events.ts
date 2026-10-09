import type { HarnessEvent } from '../../ports'
import { argsDigest } from './opencode-events'

type Usage = { inputTokens?: number; outputTokens?: number; cacheWriteTokens?: number }

type RawEvent = {
  type?: string
  phase?: string
  callId?: string
  tool?: string
  input?: unknown
  status?: string
  text?: string
  message?: string
  usage?: Usage
  reason?: { kind?: string; message?: string }
}

export class DshEventMapper {
  private readonly tools = new Map<string, string>()
  private steps = 0

  map(raw: unknown): HarnessEvent[] {
    const e = raw as RawEvent
    switch (e.type) {
      case 'tool_call': {
        const tool = String(e.tool ?? 'unknown')
        this.tools.set(String(e.callId), tool)
        return [{ kind: 'tool_call', tool, argsDigest: argsDigest(tool, e.input) }]
      }
      case 'tool_result':
        return [
          {
            kind: 'tool_result',
            tool: this.tools.get(String(e.callId)) ?? 'unknown',
            ok: e.status === 'completed',
          },
        ]
      case 'text':
        return [{ kind: 'text', chars: e.text?.length ?? 0 }]
      case 'error':
        return [{ kind: 'error', message: String(e.message ?? 'dsh error'), fatal: true }]
      case 'status':
        if (e.phase === 'step_end') {
          this.steps += 1
          const u = e.usage ?? {}
          return [
            {
              kind: 'step',
              step: this.steps,
              tokensIn: (u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0),
              tokensOut: u.outputTokens ?? 0,
            },
          ]
        }
        if (e.phase === 'turn_end' && e.reason?.kind && e.reason.kind !== 'completed')
          return [
            { kind: 'error', message: `turn ended: ${e.reason.message ?? e.reason.kind}`, fatal: false },
          ]
        return []
      case 'final':
        return [{ kind: 'idle', sinceMs: 0 }]
      default:
        return []
    }
  }
}
