import { issueRecords, workerRecords } from '@nightshift/supervisor'
import { type Ctx, EXIT, parseArgs } from '../cli'
import {
  branchParts,
  idleParts,
  renderLine,
  renderParts,
  type StatusStyle,
  statusParts,
  summaryParts,
} from '../render/status'
import { withDb } from './shared'

export const STATUS_LINE_USAGE = 'ns status-line [<issue>] [--tmux]'

export function statusLineCommand(ctx: Ctx, args: string[]): number {
  const { positionals, bools } = parseArgs(args, { bools: ['--tmux'] }, STATUS_LINE_USAGE)
  const issue = positionals[0]
  const style: StatusStyle = bools.has('--tmux') ? 'tmux' : ctx.color ? 'ansi' : 'plain'
  const now = ctx.now()
  const { rows, stages } = withDb(ctx, (db) => ({
    rows: workerRecords(db, now),
    stages: new Map((issueRecords(db) ?? []).map((i) => [i.identifier, i.stage])),
  }))
  if (issue) {
    const w = rows.find((r) => r.issue === issue)
    ctx.io.out(
      w
        ? renderLine(statusParts(w, stages.get(issue)), branchParts(w), style)
        : renderParts(idleParts(issue), style),
    )
    return EXIT.ok
  }
  ctx.io.out(renderParts(summaryParts(rows), style))
  return EXIT.ok
}
