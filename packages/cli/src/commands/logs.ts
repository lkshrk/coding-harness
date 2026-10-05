import {
  type Db,
  EVENT_TYPES,
  type Event,
  type EventQuery,
  eventsAfter,
  isIssueRef,
  isRunId,
  openStateReadOnly,
  runStore,
} from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, paint, parseArgs } from '../cli'
import { eventLine } from '../render/events'

export const POLL_MS = 500

export function issueOf(db: Db, cache: Map<string, string>): (e: Event) => string | undefined {
  const runs = runStore(db)
  return (e) => {
    if (e.issue) return e.issue
    if (!e.run) return undefined
    const known = cache.get(e.run)
    if (known) return known
    const issue = runs.get(e.run)?.issue
    if (issue) cache.set(e.run, issue)
    return issue
  }
}

export async function follow(
  ctx: Ctx,
  query: EventQuery,
  after: string | null,
  onEvent: (e: Event, db: Db) => void,
  until: (db: Db) => boolean = () => false,
): Promise<void> {
  let cursor = after
  while (!ctx.signal?.aborted) {
    const db = openStateReadOnly(ctx.statePath())
    if (db) {
      try {
        const events = eventsAfter(db, cursor, query)
        for (const e of events) onEvent(e, db)
        cursor = events.at(-1)?.id ?? cursor
        if (until(db)) return
      } finally {
        db.close()
      }
    }
    await ctx.sleep(POLL_MS)
  }
}

export const LOGS_USAGE = 'ns logs [<target>] [-f] [--type T]…'

export async function logs(ctx: Ctx, args: string[]): Promise<number> {
  const usage = LOGS_USAGE
  const { positionals, bools, lists } = parseArgs(
    args,
    { bools: ['--follow'], repeat: ['--type'], aliases: { '-f': '--follow' } },
    usage,
  )
  if (positionals.length > 1) throw new CliError(EXIT.usage, `usage: ${usage}`)
  const target = positionals[0]
  const types = (lists['--type'] ?? []).flatMap((t) => t.split(',')).map((t) => t.trim().toUpperCase())
  const unknown = types.filter((t) => !(EVENT_TYPES as readonly string[]).includes(t))
  if (unknown.length) throw new CliError(EXIT.usage, `unknown event type ${unknown.join(', ')}`)
  const query: EventQuery = { ...(types.length ? { types } : {}) }
  if (target !== undefined) {
    if (isRunId(target)) query.run = target
    else if (isIssueRef(target)) query.issue = target
    else throw new CliError(EXIT.usage, `not an issue identifier or run id: ${target}`)
  }
  const p = paint(ctx.color)
  const runs = new Map<string, string>()
  const print = (e: Event, db: Db) => {
    if (ctx.flags.json) ctx.io.out(JSON.stringify(e))
    else ctx.io.out(eventLine(e, p, target === undefined ? (issueOf(db, runs)(e) ?? '-') : undefined))
  }
  const db = openStateReadOnly(ctx.statePath())
  if (!db)
    throw new CliError(EXIT.error, `no state database at ${ctx.statePath()}; has the supervisor run yet?`)
  let last: string | null = null
  try {
    if (target !== undefined && runStore(db).forIssue(target).length === 0 && !query.run) {
      const any = eventsAfter(db, null, { issue: target, limit: 1 })
      if (any.length === 0 && !bools.has('--follow'))
        throw new CliError(EXIT.notFound, `no events for ${target}`)
    }
    if (query.run && !runStore(db).get(query.run)) throw new CliError(EXIT.notFound, `no run ${query.run}`)
    for (const e of eventsAfter(db, null, query)) {
      print(e, db)
      last = e.id
    }
    if (last === null)
      last = db.query<{ id: string }, []>('SELECT id FROM events ORDER BY id DESC LIMIT 1').get()?.id ?? null
  } finally {
    db.close()
  }
  if (bools.has('--follow')) await follow(ctx, query, last, print)
  return EXIT.ok
}
