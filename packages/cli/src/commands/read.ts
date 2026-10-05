import { issueRecords, questionRecords, workerRecords } from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, paint, parseArgs, printJson } from '../cli'
import { duration, table, withDb } from './shared'

export const TASKS_USAGE = 'ns tasks [--project P] [--stage S] [--state S]'
export const WORKERS_USAGE = 'ns workers'
export const QUESTIONS_USAGE = 'ns questions'

export function tasks(ctx: Ctx, args: string[]): number {
  const usage = TASKS_USAGE
  const { values, positionals } = parseArgs(args, { values: ['--project', '--stage', '--state'] }, usage)
  if (positionals.length) throw new CliError(EXIT.usage, `usage: ${usage}`)
  const records = withDb(ctx, (db) => issueRecords(db))
  if (records === null) {
    throw new CliError(EXIT.error, 'no issue snapshot yet; the supervisor writes it on its next tick')
  }
  const rows = records.filter(
    (r) =>
      (values['--project'] === undefined || r.project === values['--project']) &&
      (values['--stage'] === undefined || r.stage === values['--stage']) &&
      (values['--state'] === undefined ||
        r.lifecycle === values['--state'] ||
        r.status === values['--state'] ||
        r.agent_state === values['--state']),
  )
  if (ctx.flags.json) {
    printJson(ctx, rows)
    return EXIT.ok
  }
  if (rows.length === 0) {
    ctx.io.out('no managed issues')
    return EXIT.ok
  }
  const p = paint(ctx.color)
  const lines = table([
    ['ISSUE', 'STAGE', 'STATUS', 'AGENT', 'ATTEMPT', 'BLOCKERS', 'WAITING', 'TITLE'],
    ...rows.map((r) => [
      r.identifier,
      r.stage ?? '-',
      r.lifecycle ?? r.status,
      r.agent_state ? `${r.agent} ${r.agent_state}` : '-',
      String(r.attempt),
      r.blockers.join(',') || '-',
      r.waiting ?? '-',
      r.title,
    ]),
  ])
  ctx.io.out(p('bold', lines[0] as string))
  for (const line of lines.slice(1)) ctx.io.out(line)
  return EXIT.ok
}

export function workers(ctx: Ctx, args: string[]): number {
  const usage = WORKERS_USAGE
  if (parseArgs(args, {}, usage).positionals.length) throw new CliError(EXIT.usage, `usage: ${usage}`)
  const rows = withDb(ctx, (db) => workerRecords(db, ctx.now()))
  if (ctx.flags.json) {
    printJson(ctx, rows)
    return EXIT.ok
  }
  if (rows.length === 0) {
    ctx.io.out('no active workers')
    return EXIT.ok
  }
  const p = paint(ctx.color)
  const lines = table([
    ['ISSUE', 'AGENT', 'MODEL', 'STATE', 'ELAPSED', 'STEPS', 'TOKENS', 'LAST TOOL'],
    ...rows.map((w) => [
      w.issue,
      w.agent,
      w.model,
      w.state,
      duration(w.elapsed_ms),
      String(w.steps),
      String(w.tokens),
      w.last_tool ?? '-',
    ]),
  ])
  ctx.io.out(p('bold', lines[0] as string))
  for (const line of lines.slice(1)) ctx.io.out(line)
  return EXIT.ok
}

export function questions(ctx: Ctx, args: string[]): number {
  const usage = QUESTIONS_USAGE
  if (parseArgs(args, {}, usage).positionals.length) throw new CliError(EXIT.usage, `usage: ${usage}`)
  const rows = withDb(ctx, (db) => questionRecords(db))
  if (ctx.flags.json) {
    printJson(ctx, rows)
    return EXIT.ok
  }
  if (rows.length === 0) {
    ctx.io.out('no open questions')
    return EXIT.ok
  }
  const p = paint(ctx.color)
  for (const q of rows) {
    ctx.io.out(`${p('bold', q.issue)} asked ${q.asked_at} (to ${q.asked_to})${q.url ? ` ${q.url}` : ''}`)
    ctx.io.out(`  ${q.question ?? '(question text not in the event log)'}`)
  }
  return EXIT.ok
}
