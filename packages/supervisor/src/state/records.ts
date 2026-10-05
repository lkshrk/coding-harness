import type { Db } from './db'
import type { Event } from './events'
import type { IssueRecord, QuestionRecord, WorkerRecord } from './generated/records'
import { type Run, RunStore } from './runs'
import { createUlid } from './ulid'

type Progress = { steps: number; tool_calls: number; tokens: number; diff_lines?: number; last_tool?: string }

function tableExists(db: Db, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null
}

export function runStore(db: Db): RunStore {
  return new RunStore(db, { now: () => new Date(), ulid: createUlid() })
}

function latestProgress(db: Db, run: string): Progress | undefined {
  const row = db
    .query<{ data: string }, [string]>(
      "SELECT data FROM events WHERE run = ? AND type = 'WORKER_PROGRESS' ORDER BY id DESC LIMIT 1",
    )
    .get(run)
  return row ? (JSON.parse(row.data) as Progress) : undefined
}

export function workerRecord(db: Db, run: Run, now: Date): WorkerRecord {
  const p = latestProgress(db, run.id)
  return {
    run: run.id,
    issue: run.issue,
    agent: run.agent,
    model: run.model,
    profile: run.profile,
    state: run.state,
    attempt: run.attempt,
    started_at: run.startedAt,
    elapsed_ms: Math.max(0, now.getTime() - Date.parse(run.startedAt)),
    steps: p?.steps ?? 0,
    tool_calls: p?.tool_calls ?? 0,
    tokens: p?.tokens ?? run.tokensIn + run.tokensOut,
    last_tool: p?.last_tool ?? null,
    diff_lines: p?.diff_lines ?? null,
  }
}

export function workerRecords(db: Db, now: Date): WorkerRecord[] {
  return runStore(db)
    .active()
    .map((r) => workerRecord(db, r, now))
}

type IssueRow = {
  identifier: string
  title: string
  project: string | null
  stage: string | null
  lifecycle: IssueRecord['lifecycle']
  status: string
  blockers: string
  waiting: string | null
  updated_at: string
}

export function issueRecords(db: Db): IssueRecord[] | null {
  if (!tableExists(db, 'issues')) return null
  const runs = runStore(db)
  return db
    .query<IssueRow, []>('SELECT * FROM issues ORDER BY identifier')
    .all()
    .map((r) => {
      const last = runs.forIssue(r.identifier).at(-1)
      return {
        identifier: r.identifier,
        title: r.title,
        project: r.project,
        stage: r.stage,
        lifecycle: r.lifecycle,
        status: r.status,
        blockers: JSON.parse(r.blockers) as string[],
        waiting: r.waiting,
        agent: last?.agent ?? null,
        agent_state: last?.state ?? null,
        attempt: last?.attempt ?? 0,
        updated_at: r.updated_at,
      }
    })
}

export function commentUrl(org: string | null, issue: string, comment: string): string | null {
  return org ? `https://linear.app/${org}/issue/${issue}#comment-${comment.slice(0, 8)}` : null
}

export function questionRecords(db: Db): QuestionRecord[] {
  const org =
    db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get('linear_org')?.value ??
    null
  const asked = new Map(
    db
      .query<{ data: string }, []>("SELECT data FROM events WHERE type = 'QUESTION_ASKED'")
      .all()
      .map((e) => JSON.parse(e.data) as { comment: string; question: string })
      .map((d) => [d.comment, d.question]),
  )
  return db
    .query<
      { comment: string; issue: string; run: string | null; asked_to: 'lead' | 'user'; asked_at: string },
      []
    >(
      'SELECT comment, issue, run, asked_to, asked_at FROM questions WHERE answered_at IS NULL ORDER BY asked_at',
    )
    .all()
    .map((q) => ({
      issue: q.issue,
      comment: q.comment,
      run: q.run,
      asked_to: q.asked_to,
      asked_at: q.asked_at,
      question: asked.get(q.comment) ?? null,
      url: commentUrl(org, q.issue, q.comment),
    }))
}

export type EventQuery = { issue?: string; run?: string; types?: readonly string[]; limit?: number }

type EventRow = {
  id: string
  ts: string
  type: Event['type']
  issue: string | null
  run: string | null
  data: string
}

export function eventsAfter(db: Db, after: string | null, q: EventQuery = {}): Event[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (after !== null) {
    where.push('e.id > ?')
    params.push(after)
  }
  if (q.issue !== undefined) {
    where.push('(e.issue = ? OR e.run IN (SELECT id FROM runs WHERE issue = ?))')
    params.push(q.issue, q.issue)
  }
  if (q.run !== undefined) {
    where.push('e.run = ?')
    params.push(q.run)
  }
  if (q.types?.length) {
    where.push(`e.type IN (${q.types.map(() => '?').join(', ')})`)
    params.push(...q.types)
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const order = q.limit === undefined ? 'ORDER BY e.id' : 'ORDER BY e.id DESC LIMIT ?'
  if (q.limit !== undefined) params.push(q.limit)
  const rows = db
    .query<EventRow, (string | number)[]>(
      `SELECT e.id, e.ts, e.type, e.issue, e.run, e.data FROM events e ${filter} ${order}`,
    )
    .all(...params)
  if (q.limit !== undefined) rows.reverse()
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    type: r.type,
    ...(r.issue !== null ? { issue: r.issue } : {}),
    ...(r.run !== null ? { run: r.run } : {}),
    data: JSON.parse(r.data),
  }))
}

export function newestEventId(db: Db): string | null {
  return db.query<{ id: string }, []>('SELECT id FROM events ORDER BY id DESC LIMIT 1').get()?.id ?? null
}
