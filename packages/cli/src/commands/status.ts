import {
  type Health,
  openStateReadOnly,
  questionRecords,
  readSignalState,
  readStatus,
  type StatusRecord,
  workerRecords,
} from '@nightshift/supervisor'
import { type Ctx, EXIT, paint, parseArgs, printJson } from '../cli'
import { duration, health, table } from './shared'

const WATCH_MS = 2_000
export const STATUS_USAGE = 'ns status [--watch]'

export async function statusRecord(ctx: Ctx): Promise<StatusRecord | { supervisor: 'down'; state: null }> {
  const up = await health<Health>(ctx)
  const db = openStateReadOnly(ctx.statePath())
  if (!db) return { supervisor: 'down', state: null }
  try {
    const s = readStatus(db)
    const signal = signalConfigured(ctx) ? readSignalState(db) : null
    return {
      supervisor: up ? 'running' : 'down',
      dispatch: up?.dispatch ?? s.dispatch,
      gateway: up?.gateway ?? null,
      ...(signal ? { signal } : {}),
      profile: s.activeProfile,
      restart_required: s.restartRequired,
      held: s.held,
      covered: s.covered,
      workers: workerRecords(db, ctx.now()),
      waiting: s.waiting,
      questions: questionRecords(db),
      failures: s.failures,
    }
  } finally {
    db.close()
  }
}

function signalConfigured(ctx: Ctx): boolean {
  try {
    return Boolean(ctx.config().notifications?.signal)
  } catch {
    return false
  }
}

function render(ctx: Ctx, r: Awaited<ReturnType<typeof statusRecord>>): string[] {
  const p = paint(ctx.color)
  const lines: string[] = []
  if (r.supervisor === 'down') lines.push(p('red', 'supervisor not running'))
  if (!('dispatch' in r)) return [...lines, 'no state yet']
  const dispatch = r.dispatch === 'paused' ? p('yellow', 'paused') : p('green', 'running')
  const gateway =
    r.gateway === null ? 'unknown' : r.gateway === 'ok' ? p('green', 'ok') : p('red', 'unavailable')
  const signal = !r.signal
    ? ''
    : r.signal.state === 'ok'
      ? `  signal: ${p('green', 'ok')}`
      : `  signal: ${p(r.signal.state === 'unpaired' ? 'yellow' : 'red', r.signal.state)}${r.signal.detail ? ` (${r.signal.detail})` : ''}`
  lines.push(
    `dispatch: ${dispatch}  gateway: ${gateway}${signal}${r.restart_required ? '  (restart required)' : ''}`,
  )
  lines.push(`profile: ${r.profile ?? 'none'}`)
  if (r.workers.length === 0) lines.push('workers: none')
  else {
    lines.push('workers:')
    lines.push(
      ...table(
        r.workers.map((w) => [
          `  ${w.issue}`,
          w.agent,
          w.state,
          `attempt ${w.attempt}`,
          duration(w.elapsed_ms),
          `${w.steps} steps`,
          w.last_tool ?? '',
        ]),
      ),
    )
  }
  for (const w of r.waiting) lines.push(`ready: ${w.identifier}: ${w.reason}`)
  for (const q of r.questions) {
    lines.push(
      `${p('yellow', 'waiting for you')}: ${q.issue}: question to ${q.asked_to}${q.url ? ` ${q.url}` : ''}`,
    )
  }
  if (r.held.length) lines.push(`held: ${r.held.join(', ')}`)
  lines.push(`covered: ${r.covered.length === 0 ? 'none' : r.covered.join(', ')}`)
  for (const f of r.failures.slice(-5) as {
    issue?: string
    ts?: string
    data?: { class?: string; action?: string }
  }[]) {
    lines.push(
      `${p('red', 'failure')}: ${f.issue ?? '-'} ${f.data?.class ?? ''} → ${f.data?.action ?? ''} (${f.ts ?? ''})`,
    )
  }
  return lines
}

export async function status(ctx: Ctx, args: string[]): Promise<number> {
  const { bools } = parseArgs(args, { bools: ['--watch'], aliases: { '-w': '--watch' } }, STATUS_USAGE)
  for (;;) {
    const r = await statusRecord(ctx)
    if (ctx.flags.json) printJson(ctx, r)
    else {
      if (bools.has('--watch') && ctx.stdoutIsTTY) ctx.io.out('\x1b[2J\x1b[H')
      for (const line of render(ctx, r)) ctx.io.out(line)
    }
    if (!bools.has('--watch') || ctx.signal?.aborted) return EXIT.ok
    await ctx.sleep(WATCH_MS)
    if (ctx.signal?.aborted) return EXIT.ok
  }
}
