import type { GateResult } from '../../ports'
import { outputTail } from './runner'

export type GateEventData = {
  check: string
  exit_code: number
  duration_ms: number
  output_tail: string
  artifact?: string
}

function combinedTail(r: GateResult): string {
  return outputTail([r.result.stdoutTail, r.result.stderrTail].filter(Boolean).join('\n'))
}

export function gateEventData(r: GateResult): GateEventData {
  return {
    check: r.check,
    exit_code: r.result.exitCode,
    duration_ms: Math.max(0, Math.round(r.result.durationMs)),
    output_tail: combinedTail(r),
    ...(r.result.artifact ? { artifact: r.result.artifact } : {}),
  }
}

export function gateComment(r: GateResult): string {
  const tail = combinedTail(r)
  const longest = Math.max(0, ...(tail.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const seconds = (r.result.durationMs / 1000).toFixed(1)
  return [
    `Gate \`${r.check}\` failed: exit code ${r.result.exitCode} after ${seconds}s${r.result.timedOut ? ' (timed out)' : ''}.`,
    '',
    `${fence}text`,
    tail,
    fence,
  ].join('\n')
}
