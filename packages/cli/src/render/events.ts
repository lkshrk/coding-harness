import type { Event } from '@nightshift/supervisor'
import type { Paint } from '../cli'

type Data = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v))

function summary(type: string, d: Data): string {
  switch (type) {
    case 'DISPATCHED':
      return `${str(d.agent)} attempt ${str(d.attempt)} on ${str(d.model)} (profile ${str(d.profile)})${d.reason ? `, ${str(d.reason)}` : ''}`
    case 'VAULT_INGEST_STARTED':
      return `attempt ${str(d.attempt ?? 1)}`
    case 'WORKER_STARTED':
      return `session ${str(d.session)}`
    case 'WORKER_PROGRESS':
      return `${str(d.steps)} steps, ${str(d.tool_calls)} tool calls, ${str(d.tokens)} tokens${d.diff_lines !== undefined ? `, ${str(d.diff_lines)} diff lines` : ''}${d.last_tool ? `, last ${str(d.last_tool)}` : ''}`
    case 'WORKER_STALLED':
      return `${str(d.signal)}${d.detail ? `: ${str(d.detail)}` : ''}`
    case 'WORKER_FINISHED':
      return `${str(d.status)}${typeof d.summary === 'string' ? `: ${d.summary}` : ''}`
    case 'WORKER_FAILED':
    case 'WORKER_NO_FINISH':
      return `${str(d.reason)}${d.detail ? `: ${str(d.detail)}` : ''}`
    case 'WIP_COMMITTED':
      return `${str(d.sha).slice(0, 12)}, ${str(d.lines)} lines`
    case 'GATE_PASSED':
    case 'GATE_FAILED':
      return `${str(d.check)} exit ${str(d.exit_code)} (${Math.round(Number(d.duration_ms) / 1000)}s)`
    case 'REVIEW_RECEIVED':
      return `${str(d.verdict)}, ${Array.isArray(d.findings) ? d.findings.length : 0} findings`
    case 'FAILURE_CLASSIFIED':
      return `${str(d.class)} → ${str(d.action)}`
    case 'QUESTION_ASKED':
      return `to ${str(d.to)}: ${str(d.question)}`
    case 'QUESTION_ANSWERED':
      return `${d.by ? `${str(d.by)}: ` : ''}${str(d.answer)}`
    case 'MESSAGE_SENT':
      return `${str(d.by)} → ${d.comment ? 'question' : 'worker'}: ${str(d.text)}`
    case 'PR_CREATED':
    case 'MERGED':
      return str(d.url)
    case 'CI_PASSED':
    case 'CI_FAILED':
      return `${str(d.url)}${Array.isArray(d.failed_checks) && d.failed_checks.length ? ` (${d.failed_checks.join(', ')})` : ''}`
    case 'STAGE_ENTERED':
      return `${d.from ? `${str(d.from)} → ` : ''}${str(d.stage)}`
    case 'STAGE_COMPLETED':
      return str(d.stage)
    case 'COVERAGE_CHANGED':
      return `${d.covered ? 'covered' : 'released'} by ${str(d.by)}`
    case 'DISPATCH_PAUSED':
    case 'DISPATCH_RESUMED':
      return `${str(d.reason)}${d.by ? ` (by ${str(d.by)})` : ''}`
    default:
      return Object.entries(d)
        .map(([k, v]) => `${k}=${str(v)}`)
        .join(' ')
  }
}

const BAD = new Set([
  'WORKER_FAILED',
  'WORKER_NO_FINISH',
  'WORKER_STALLED',
  'GATE_FAILED',
  'CI_FAILED',
  'FAILURE_CLASSIFIED',
  'GATEWAY_UNAVAILABLE',
  'CONFIG_REJECTED',
])
const GOOD = new Set(['GATE_PASSED', 'CI_PASSED', 'MERGED', 'PR_CREATED', 'WORKER_FINISHED'])

export function eventLine(e: Event, p: Paint, prefix?: string): string {
  const time = e.ts.slice(11, 19)
  const color = BAD.has(e.type)
    ? 'red'
    : GOOD.has(e.type)
      ? 'green'
      : e.type === 'REVIEW_RECEIVED'
        ? (e.data as Data).verdict === 'pass'
          ? 'green'
          : 'red'
        : 'cyan'
  const head = prefix ? `${p('bold', prefix.padEnd(9))} ` : ''
  return `${p('dim', time)} ${head}${p(color, e.type)} ${summary(e.type, e.data as Data)}`.trimEnd()
}
