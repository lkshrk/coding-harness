import { issueRecords, workerRecords } from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, parseArgs } from '../cli'
import {
  branchParts,
  clipParts,
  fitLine,
  idleParts,
  type Part,
  renderLine,
  renderParts,
  type StatusStyle,
  statusParts,
  summaryParts,
} from '../render/status'
import { withDb } from './shared'

export const STATUS_LINE_USAGE = 'ns status-line [<issue>] [--tmux] [--width <n>]'

export function statusLineCommand(ctx: Ctx, args: string[]): number {
  const { positionals, bools, values } = parseArgs(
    args,
    { bools: ['--tmux'], values: ['--width'] },
    STATUS_LINE_USAGE,
  )
  const issue = positionals[0]
  const width = values['--width'] === undefined ? undefined : Number(values['--width'])
  if (width !== undefined && (!Number.isInteger(width) || width < 1)) {
    throw new CliError(EXIT.usage, `usage: ${STATUS_LINE_USAGE}`)
  }
  const fit = (left: Part[], right: Part[] = []) =>
    width === undefined ? { left, right } : fitLine(left, right, width)
  const style: StatusStyle = bools.has('--tmux') ? 'tmux' : ctx.color ? 'ansi' : 'plain'
  const now = ctx.now()
  const { rows, stages } = withDb(ctx, (db) => ({
    rows: workerRecords(db, now),
    stages: new Map((issueRecords(db) ?? []).map((i) => [i.identifier, i.stage])),
  }))
  if (issue) {
    const w = rows.find((r) => r.issue === issue)
    const line = w ? fit(statusParts(w, stages.get(issue)), branchParts(w)) : fit(idleParts(issue))
    ctx.io.out(renderLine(line.left, line.right, style))
    return EXIT.ok
  }
  const summary = summaryParts(rows)
  ctx.io.out(renderParts(width === undefined ? summary : clipParts(summary, width), style))
  return EXIT.ok
}
