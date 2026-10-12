import {
  type Event,
  eventsAfter,
  isTerminal,
  openStateReadOnly,
  type Run,
  runStore,
  workerRecords,
} from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, paint, parseArgs } from '../cli'
import { LOCAL } from '../remote'
import { eventLine } from '../render/events'
import { shellLine, Tmux } from '../tmux'
import { issueOf } from './logs'
import { duration, table, withDb } from './shared'
import { renderStatus, statusRecord } from './status'
import { LIFECYCLE, tailRun, terminalWidth } from './tail'

export const WATCH_USAGE = 'ns watch [<issue>…] [--all] [--panes [--max-panes N]] | ns watch --snapshot'
const POLL_MS = 2_000
const MAX_PANES = 6
// One poll of lead plus one of slack keeps every close within 60 s of the run's end.
const CLOSE_AFTER_MS = 60_000 - 2 * POLL_MS
const FEED_SIZE = 15
const FEED_TYPES = [
  'PR_CREATED',
  'REVIEW_RECEIVED',
  'FAILURE_CLASSIFIED',
  'QUESTION_ASKED',
  'DISPATCHED',
  'RUN_INTERRUPTED',
  'WORKER_FAILED',
  'GATEWAY_UNAVAILABLE',
  'GATEWAY_RECOVERED',
  'TICK_STALLED',
]
const CLEAR = '\x1b[H\x1b[2J'
const SNAPSHOT_EVENTS = 10

function ns(ctx: Ctx, ...args: string[]): string[] {
  return [...ctx.self, '--host', LOCAL, ...(ctx.flags.config ? ['--config', ctx.flags.config] : []), ...args]
}

// ctrl+c in a watch pane must not end its process and leave a dead pane; an ignored SIGINT survives exec.
function stream(ctx: Ctx, issue: string): string {
  return `trap '' INT; exec ${shellLine(ns(ctx, 'tail', '--no-footer', issue))}`
}

function closeEnded(ctx: Ctx, tmux: Tmux, o: { fresh?: boolean; note?: (line: string) => void }) {
  const panes = tmux.panes()
  const workers = panes.filter((p) => p.run)
  const runs = withDb(ctx, (db) => {
    const store = runStore(db)
    return { active: store.active(), states: new Map(workers.map((p) => [p.run, store.get(p.run)])) }
  })
  const now = ctx.now().getTime()
  const open = panes.filter((pane) => {
    if (!pane.run) return true
    const run = runs.states.get(pane.run)
    if (run && !isTerminal(run.state)) return true
    const ended = run?.endedAt ? Date.parse(run.endedAt) : Number.NaN
    if (o.fresh || !(now - ended < CLOSE_AFTER_MS)) {
      tmux.close(pane)
      o.note?.(`pane closed: ${pane.issue}`)
      return false
    }
    if (!pane.title.endsWith(']'))
      tmux.title(pane.id, `${pane.issue} [${run?.state === 'done' ? 'done' : 'failed'}]`)
    return true
  })
  return { panes: open, active: runs.active }
}

export function syncPanes(
  ctx: Ctx,
  tmux: Tmux,
  o: { issues: string[]; maxPanes: number; fresh?: boolean; note?: (line: string) => void },
): string[] {
  const { panes, active } = closeEnded(ctx, tmux, o)
  const known = new Set(panes.map((p) => p.run))
  const added: string[] = []
  for (const run of active) {
    if (o.issues.length && !o.issues.includes(run.issue)) continue
    if (known.has(run.id)) continue
    tmux.addPane({
      run: run.id,
      issue: run.issue,
      command: stream(ctx, run.issue),
      maxPanes: o.maxPanes,
    })
    added.push(run.issue)
    o.note?.(`pane opened: ${run.issue}`)
  }
  return added
}

export type Manager = {
  issues: string[]
  maxPanes: number
  fresh: boolean
  first: boolean
  notes: { ts: string; line: string }[]
}

function recentEvents(ctx: Ctx): Event[] {
  const db = openStateReadOnly(ctx.statePath())
  if (!db) return []
  try {
    const issue = issueOf(db, new Map())
    return eventsAfter(db, null, { types: FEED_TYPES, limit: FEED_SIZE }).map((e) => {
      const known = issue(e)
      return known ? { ...e, issue: known } : e
    })
  } finally {
    db.close()
  }
}

export async function manageOnce(ctx: Ctx, tmux: Tmux, m: Manager, height: number): Promise<void> {
  const p = paint(ctx.color)
  const errors: string[] = []
  const note = (line: string) => {
    const ts = ctx.now().toISOString()
    m.notes = [...m.notes, { ts, line: `${p('dim', ts.slice(11, 19))} ${line}` }].slice(-FEED_SIZE)
  }
  try {
    const added = syncPanes(ctx, tmux, { issues: m.issues, maxPanes: m.maxPanes, fresh: m.fresh, note })
    m.fresh = false
    if (m.first && added.length) {
      tmux.selectWorkers()
      m.first = false
    }
  } catch (e) {
    errors.push((e as Error).message)
  }
  let status: string[] = []
  let events: { ts: string; line: string }[] = []
  try {
    status = renderStatus(ctx, await statusRecord(ctx))
    events = recentEvents(ctx).map((e) => ({ ts: e.ts, line: eventLine(e, p, e.issue ?? '-') }))
  } catch (e) {
    errors.push((e as Error).message)
  }
  const feed = [...events, ...m.notes]
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .slice(-FEED_SIZE)
    .map((f) => f.line)
  const help = `watching ${m.issues.length ? m.issues.join(', ') : 'all workers'}; prefix a in a pane attaches, prefix d leaves`
  const head = [...status, ...errors.map((e) => p('red', e)), '']
  const room = Math.max(0, height - head.length - 1)
  const lines = [...head, ...(room ? feed.slice(-room) : []), help]
  ctx.io.out(`${CLEAR}${lines.join('\n')}`)
}

async function manage(ctx: Ctx, tmux: Tmux, issues: string[], maxPanes: number): Promise<number> {
  const m: Manager = { issues, maxPanes, fresh: true, first: true, notes: [] }
  while (!ctx.signal?.aborted) {
    try {
      // The line written after the frame ends in a newline, which would scroll a full pane by one.
      await manageOnce(ctx, tmux, m, (process.stdout.rows || 24) - 1)
    } catch (e) {
      ctx.io.err((e as Error).message)
    }
    await ctx.sleep(POLL_MS)
  }
  return EXIT.ok
}

export type StreamDeps = {
  runs(ids: string[]): { active: Run[]; known: Map<string, Run | undefined> }
  stream(run: Run, out: (line: string) => void, signal: AbortSignal): Promise<unknown>
}

const ISSUE_COLORS = ['cyan', 'magenta', 'yellow', 'blue', 'green'] as const

function tailDeps(ctx: Ctx, prefix: () => number): StreamDeps {
  return {
    runs: (ids) =>
      withDb(ctx, (db) => {
        const store = runStore(db)
        return { active: store.active(), known: new Map(ids.map((id) => [id, store.get(id)])) }
      }),
    stream: (run, out, signal) => {
      const any = AbortSignal.any(ctx.signal ? [ctx.signal, signal] : [signal])
      return tailRun(
        { ...ctx, signal: any },
        run.issue,
        run,
        null,
        false,
        out,
        () => terminalWidth() - prefix(),
      )
    },
  }
}

function newEvents(ctx: Ctx, after: string | null, limit?: number): Event[] {
  const db = openStateReadOnly(ctx.statePath())
  if (!db) return []
  try {
    const issue = issueOf(db, new Map())
    return eventsAfter(db, after, { types: FEED_TYPES, ...(limit ? { limit } : {}) }).map((e) => {
      const known = issue(e)
      return known ? { ...e, issue: known } : e
    })
  } finally {
    db.close()
  }
}

export async function streamWatch(ctx: Ctx, issues: string[], deps?: StreamDeps): Promise<number> {
  const p = paint(ctx.color)
  const interrupt = new AbortController()
  const onInt = () => interrupt.abort()
  process.once('SIGINT', onInt)
  const signal = AbortSignal.any(ctx.signal ? [ctx.signal, interrupt.signal] : [interrupt.signal])
  const live = new Map<string, { run: Run; stop: AbortController; done: Promise<unknown> }>()
  const colors = new Map<string, (typeof ISSUE_COLORS)[number]>()
  let width = Math.max(0, ...issues.map((i) => i.length))
  const tag = (issue: string) => {
    const color = colors.get(issue) ?? ISSUE_COLORS[colors.size % ISSUE_COLORS.length] ?? 'cyan'
    colors.set(issue, color)
    return p(color, issue.padEnd(width))
  }
  // Each streamed line is written after its `<issue> │ ` prefix.
  const streams = deps ?? tailDeps(ctx, () => width + ' │ '.length)
  const start = (run: Run) => {
    const stop = new AbortController()
    ctx.io.out(`${tag(run.issue)} started (${run.agent})`)
    // Each line is written whole, so streams of different runs never interleave mid-line.
    const write = (text: string) => {
      if (stop.signal.aborted) return
      for (const line of text.split('\n')) ctx.io.out(`${tag(run.issue)} │ ${line}`)
    }
    const done = streams.stream(run, write, stop.signal).catch((e) => {
      if (!stop.signal.aborted) ctx.io.err(`${tag(run.issue)} │ stream failed: ${(e as Error).message}`)
    })
    live.set(run.id, { run, stop, done })
  }
  const status = async () => {
    try {
      for (const line of renderStatus(ctx, await statusRecord(ctx))) ctx.io.out(line)
    } catch (e) {
      ctx.io.err((e as Error).message)
    }
  }
  let cursor: string | null = null
  try {
    try {
      cursor = newEvents(ctx, null, 1).at(-1)?.id ?? null
    } catch (e) {
      ctx.io.err((e as Error).message)
    }
    await status()
    let first = true
    while (!signal.aborted) {
      let changed = false
      try {
        const { active, known } = streams.runs([...live.keys()])
        for (const [id, s] of live) {
          const run = known.get(id)
          if (run && !isTerminal(run.state)) continue
          changed = true
          s.stop.abort()
          live.delete(id)
          const state = run?.state ?? 'gone'
          const end = state === 'done' ? 'done' : `failed: ${run?.failure ?? state}`
          ctx.io.out(`${tag(s.run.issue)} ${end}`)
        }
        const fresh = active.filter((r) => !live.has(r.id) && (!issues.length || issues.includes(r.issue)))
        width = Math.max(width, ...fresh.map((r) => r.issue.length))
        for (const run of fresh) start(run)
        if (fresh.length) changed = true
        for (const e of newEvents(ctx, cursor)) {
          cursor = e.id
          if (issues.length && !issues.includes(e.issue ?? '')) continue
          // A run's own stream already prints its lifecycle events.
          const streamed = e.run ? live.has(e.run) : [...live.values()].some((s) => s.run.issue === e.issue)
          if (streamed && (LIFECYCLE as readonly string[]).includes(e.type)) continue
          ctx.io.out(eventLine(e, p, e.issue ?? '-'))
        }
      } catch (e) {
        ctx.io.err((e as Error).message)
      }
      // The first poll's starts are already covered by the status printed on start.
      if (changed && !first) await status()
      first = false
      await Promise.race([
        ctx.sleep(POLL_MS),
        new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
      ])
    }
    return EXIT.ok
  } finally {
    process.off('SIGINT', onInt)
    for (const s of live.values()) s.stop.abort()
    await Promise.all([...live.values()].map((s) => s.done))
  }
}

export function snapshot(ctx: Ctx): number {
  const p = paint(ctx.color)
  const db = openStateReadOnly(ctx.statePath())
  if (!db) {
    ctx.io.out('no state yet')
    return EXIT.ok
  }
  try {
    const workers = workerRecords(db, ctx.now())
    const issue = issueOf(db, new Map())
    const types = [...new Set<string>([...LIFECYCLE, ...FEED_TYPES])]
    const events = eventsAfter(db, null, { types, limit: SNAPSHOT_EVENTS })
    if (workers.length === 0) ctx.io.out('workers: none')
    else {
      ctx.io.out('workers:')
      const rows = workers.map((w) => [
        `  ${w.issue}`,
        w.agent,
        `attempt ${w.attempt}`,
        duration(w.elapsed_ms),
        w.last_tool ? `last ${w.last_tool}` : w.state,
      ])
      for (const line of table(rows)) ctx.io.out(line)
    }
    ctx.io.out(events.length ? 'recent events:' : 'recent events: none')
    for (const e of events) ctx.io.out(`  ${eventLine(e, p, issue(e) ?? '-')}`)
    return EXIT.ok
  } finally {
    db.close()
  }
}

export async function watch(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals, bools, values } = parseArgs(
    args,
    { bools: ['--all', '--manage', '--panes', '--snapshot'], values: ['--max-panes', '--swap'] },
    WATCH_USAGE,
  )
  if (bools.has('--snapshot')) {
    if (positionals.length || bools.size > 1 || Object.keys(values).length)
      throw new CliError(EXIT.usage, `usage: ${WATCH_USAGE}`)
    return snapshot(ctx)
  }
  if (bools.has('--all') && positionals.length) throw new CliError(EXIT.usage, `usage: ${WATCH_USAGE}`)
  if (!bools.has('--panes') && !bools.has('--manage') && values['--swap'] === undefined)
    return streamWatch(ctx, positionals)
  if (ctx.which('tmux') === null) {
    throw new CliError(EXIT.error, 'tmux is not installed; install it (brew install tmux, apt install tmux)')
  }
  const tmux = new Tmux((argv) => ctx.capture(argv))
  const maxPanes = Number(values['--max-panes'] ?? MAX_PANES)
  if (!Number.isInteger(maxPanes) || maxPanes < 1) throw new CliError(EXIT.usage, `usage: ${WATCH_USAGE}`)
  const swap = values['--swap']
  if (swap !== undefined) {
    const issue = tmux.issueOf(swap)
    if (!issue) {
      tmux.message(swap, 'no worker in this pane')
      return EXIT.ok
    }
    const id = tmux.runOf(swap)
    const state = withDb(ctx, (db) => runStore(db).get(id)?.state)
    if (!state || isTerminal(state)) {
      tmux.message(swap, `${issue} is not running`)
      return EXIT.ok
    }
    tmux.respawn(swap, `trap : INT; ${shellLine(ns(ctx, 'attach', issue))}; ${stream(ctx, issue)}`)
    return EXIT.ok
  }
  if (bools.has('--manage')) return manage(ctx, tmux, positionals, maxPanes)
  const manager = ns(ctx, 'watch', '--manage', '--max-panes', String(maxPanes), ...positionals)
  if (tmux.hasSession()) {
    // The running manager keeps the scope it was started with, so it is restarted with this one.
    syncPanes(ctx, tmux, { issues: positionals, maxPanes, fresh: true })
    tmux.restartManager(manager)
  } else tmux.createSession(manager, ns(ctx, 'watch', '--swap'))
  return ctx.exec(tmux.attachCommand(), { env: { TMUX: undefined } })
}
