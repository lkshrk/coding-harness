export type GhRollupItem = {
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

export const MAX_JOB_LOG = 8 * 1024

export const MAX_CI_LOG = 24 * 1024

export const ACTIONS_URL = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/

const FAILING = /error|fail|assert|panic|exception|expected|✗|✘/i

const BEFORE = 3

const AFTER = 8

const TRUNCATED = '\n[... truncated]'

function logLine(raw: string): string {
  const fields = raw.split('\t')
  const text = fields.length >= 3 ? fields.slice(2).join('\t') : raw
  return text.replace(ANSI, '').replace(TIMESTAMP, '').trimEnd()
}

export function logExcerpt(log: string, limit: number = MAX_JOB_LOG): string {
  if (limit <= 0) return ''
  const lines = log.split('\n').map(logLine)
  while (lines.length && lines.at(-1) === '') lines.pop()
  const hits = lines.flatMap((l, n) => (FAILING.test(l) ? [n] : []))
  const keep = new Set<number>()
  if (hits.length === 0) for (let n = Math.max(0, lines.length - 40); n < lines.length; n++) keep.add(n)
  for (const h of hits)
    for (let n = Math.max(0, h - BEFORE); n <= Math.min(lines.length - 1, h + AFTER); n++) keep.add(n)
  const out: string[] = []
  let last = -1
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && n > last + 1) out.push('...')
    out.push(lines[n] as string)
    last = n
  }
  const text = out.join('\n')
  if (text.length <= limit) return text
  if (limit <= TRUNCATED.length) return ''
  const head = text.slice(0, limit - TRUNCATED.length)
  const cut = head.lastIndexOf('\n')
  return `${cut > 0 ? head.slice(0, cut) : head}${TRUNCATED}`
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

export function bucketOf(c: GhRollupItem): 'pass' | 'fail' | 'cancel' | 'pending' {
  if (c.status !== undefined && c.status !== 'COMPLETED') return 'pending'
  const result = (c.conclusion || c.state || '').toUpperCase()
  if (FAILED.has(result)) return 'fail'
  if (result === 'CANCELLED') return 'cancel'
  if (result === 'PENDING' || result === 'EXPECTED' || result === '') return 'pending'
  return 'pass'
}
