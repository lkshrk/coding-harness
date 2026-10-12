import {
  type Db,
  type Event,
  issueRecords,
  isTerminal,
  OpenCodeClient,
  type Run,
  resolveRun,
  runStore,
  workerRecords,
} from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, paint, parseArgs, requireArg } from '../cli'
import { ControlFailure } from '../client'
import { eventLine } from '../render/events'
import { SessionRenderer } from '../render/session'
import {
  branchParts,
  footerFrame,
  idleParts,
  type Part,
  RESET_REGION,
  scrollRegion,
  statusParts,
} from '../render/status'
import { attachInfo } from './attach'
import { follow } from './logs'
import { runDiff, statLines } from './results'
import { withDb } from './shared'

export const TAIL_USAGE = 'ns tail <issue> [--follow-issue] [--no-footer] [--reasoning]'

export const LIFECYCLE = [
  'DISPATCHED',
  'WORKER_STARTED',
  'WORKER_STALLED',
  'WORKER_FINISHED',
  'WORKER_NO_FINISH',
  'WORKER_FAILED',
  'MESSAGE_SENT',
  'GATE_PASSED',
  'GATE_FAILED',
  'REVIEW_RECEIVED',
  'FAILURE_CLASSIFIED',
  'PR_CREATED',
] as const

type Stream = { stop(): void; done: Promise<void> }

function streamSession(
  ctx: Ctx,
  run: Run,
  out: (line: string) => void,
  reasoning: boolean,
  width: () => number,
): Stream | null {
  const controller = new AbortController()
  const done = (async () => {
    let info: Awaited<ReturnType<typeof attachInfo>>
    try {
      info = await attachInfo(ctx, run.id)
    } catch (e) {
      if (e instanceof CliError || e instanceof ControlFailure) {
        out(`(live session unavailable: ${e.message}; showing the event log only)`)
        return
      }
      throw e
    }
    const renderer = new SessionRenderer(info.session, paint(ctx.color), width, { reasoning })
    const client = new OpenCodeClient(info.url, info.password, ctx.fetch)
    try {
      for await (const raw of client.events(controller.signal))
        for (const line of renderer.feed(raw)) out(line)
    } catch (e) {
      if (!controller.signal.aborted) out(`(live session lost: ${(e as Error).message})`)
    }
    for (const line of renderer.flush()) out(line)
  })()
  return {
    stop: () => controller.abort(),
    done,
  }
}

function newestRun(db: Db, issue: string): Run | undefined {
  return resolveRun(runStore(db), issue)
}

export async function tailRun(
  ctx: Ctx,
  issue: string,
  run: Run,
  after: string | null,
  reasoning: boolean,
  out: (line: string) => void = (line) => ctx.io.out(line),
  width: () => number = terminalWidth,
): Promise<string | null> {
  const p = paint(ctx.color)
  let session: Stream | null = null
  let diffShown = false
  let lastDiff: number | undefined
  let cursor = after
  const onEvent = (e: Event, db: Db) => {
    cursor = e.id
    if (e.run !== undefined && e.run !== run.id) return
    if (e.type === 'WORKER_PROGRESS') {
      const lines = (e.data as { diff_lines?: number }).diff_lines
      if (lines !== undefined && lines !== lastDiff) out(p('dim', `· diff ${lines} lines`))
      lastDiff = lines ?? lastDiff
      return
    }
    out(eventLine(e, p))
    if ((e.type === 'GATE_PASSED' || e.type === 'GATE_FAILED') && !diffShown) {
      diffShown = true
      const record = runDiff(ctx, runStore(db).get(run.id) ?? run, false)
      if (record) for (const line of statLines(record.files)) out(p('dim', line))
    }
  }
  const startSession = (db: Db) => {
    const current = runStore(db).get(run.id)
    if (!session && current?.state === 'running') session = streamSession(ctx, current, out, reasoning, width)
  }
  const ended = (db: Db) => {
    startSession(db)
    const current = runStore(db).get(run.id)
    return current === undefined || isTerminal(current.state)
  }
  await follow(ctx, { issue, types: [...LIFECYCLE, 'WORKER_PROGRESS'] }, after, onEvent, ended)
  const s = session as Stream | null
  if (s) {
    s.stop()
    await s.done
  }
  return cursor
}

export async function tail(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals, bools } = parseArgs(
    args,
    { bools: ['--follow-issue', '--no-footer', '--reasoning'] },
    TAIL_USAGE,
  )
  const issue = requireArg(positionals[0], TAIL_USAGE)
  const followIssue = bools.has('--follow-issue')
  const run = withDb(ctx, (db) => newestRun(db, issue))
  if (!run && !followIssue) throw new CliError(EXIT.notFound, `no run for ${issue}`)
  const cursor: string | null = null
  const stopFooter = bools.has('--no-footer') ? () => {} : startFooter(ctx, () => issueFooter(ctx, issue))
  try {
    return await tailLoop(ctx, issue, run, followIssue, cursor, bools.has('--reasoning'))
  } finally {
    stopFooter()
  }
}

async function tailLoop(
  ctx: Ctx,
  issue: string,
  first: Run | undefined,
  followIssue: boolean,
  start: string | null,
  reasoning: boolean,
): Promise<number> {
  let run = first
  let cursor = start
  for (;;) {
    if (run) {
      const id = run.id
      cursor = await tailRun(ctx, issue, run, cursor, reasoning)
      const state = withDb(ctx, (db) => runStore(db).get(id)?.state ?? 'gone')
      ctx.io.out(paint(ctx.color)('dim', `· run ${id} ended (${state})`))
    }
    if (!followIssue || ctx.signal?.aborted) return EXIT.ok
    const previous: string | undefined = run?.id
    for (;;) {
      await ctx.sleep(500)
      if (ctx.signal?.aborted) return EXIT.ok
      const next = withDb(ctx, (db) => newestRun(db, issue))
      if (next && next.id !== previous && !isTerminal(next.state)) {
        run = next
        break
      }
    }
  }
}

export function terminalWidth(): number {
  const columns = process.stdout.columns
  return columns && columns > 20 ? columns - 2 : 100
}

export type FooterLine = { left: Part[]; right: Part[] }

function issueFooter(ctx: Ctx, issue: string): FooterLine {
  const now = ctx.now()
  return withDb(ctx, (db) => {
    const w = workerRecords(db, now).find((r) => r.issue === issue)
    const stage = (issueRecords(db) ?? []).find((i) => i.identifier === issue)?.stage
    return w ? { left: statusParts(w, stage), right: branchParts(w) } : { left: idleParts(issue), right: [] }
  })
}

export function startFooter(ctx: Ctx, line: () => FooterLine | Promise<FooterLine>): () => void {
  const stdout = process.stdout
  if (!stdout.isTTY || ctx.flags.json || !stdout.rows || stdout.rows < 4) return () => {}
  let stopped = false
  const draw = async () => {
    try {
      const l = await line()
      if (!stopped)
        stdout.write(footerFrame(stdout.rows ?? 0, l.left, stdout.columns ?? 100, ctx.color, l.right))
    } catch {}
  }
  const layout = () => {
    stdout.write(scrollRegion(stdout.rows ?? 24))
    void draw()
  }
  layout()
  const timer = setInterval(draw, 2000)
  stdout.on('resize', layout)
  return () => {
    stopped = true
    clearInterval(timer)
    stdout.off('resize', layout)
    stdout.write(RESET_REGION)
  }
}
