import type { Db } from './db'
import { type EventInput, type EventType, validateEvent } from './event-schema'

export type Event = EventInput & { id: string; ts: string }

export type EventFilter = { issue?: string; run?: string; types?: EventType[] }

export class EventValidationError extends Error {
  override name = 'EventValidationError'

  constructor(
    readonly type: string,
    readonly errors: string[],
  ) {
    super(`invalid ${type} event: ${errors.join('; ')}`)
  }
}

type Row = { id: string; ts: string; type: EventType; issue: string | null; run: string | null; data: string }

function fromRow(r: Row): Event {
  return {
    id: r.id,
    ts: r.ts,
    type: r.type,
    ...(r.issue !== null ? { issue: r.issue } : {}),
    ...(r.run !== null ? { run: r.run } : {}),
    data: JSON.parse(r.data),
  }
}

export class EventLog {
  private readonly now: () => Date
  private readonly ulid: () => string

  constructor(
    private readonly db: Db,
    opts: { now: () => Date; ulid: () => string },
  ) {
    this.now = opts.now
    this.ulid = opts.ulid
  }

  append(input: EventInput): Event {
    const errors = validateEvent(input)
    if (errors.length) throw new EventValidationError(input.type, errors)
    const event: Event = { ...input, id: this.ulid(), ts: this.now().toISOString() }
    this.db
      .query('INSERT INTO events (id, ts, type, issue, run, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.id, event.ts, event.type, event.issue ?? null, event.run ?? null, JSON.stringify(event.data))
    return event
  }

  since(id: string | null, filter: EventFilter = {}): Event[] {
    const where: string[] = []
    const params: string[] = []
    if (id !== null) {
      where.push('id > ?')
      params.push(id)
    }
    if (filter.issue !== undefined) {
      where.push('issue = ?')
      params.push(filter.issue)
    }
    if (filter.run !== undefined) {
      where.push('run = ?')
      params.push(filter.run)
    }
    if (filter.types?.length) {
      where.push(`type IN (${filter.types.map(() => '?').join(', ')})`)
      params.push(...filter.types)
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`
    return this.db
      .query<Row, string[]>(sql)
      .all(...params)
      .map(fromRow)
  }
}
