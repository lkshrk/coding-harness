import { coveredIssues, heldIssues } from './coverage'
import type { Db } from './db'
import { type Event, EventLog } from './events'
import { type Run, RunStore } from './runs'
import { createUlid } from './ulid'

export type Waiting = { identifier: string; reason: string }

export type OpenQuestion = {
  comment: string
  issue: string
  run: string | null
  askedTo: string
  askedAt: string
}

export type SupervisorStatus = {
  dispatch: 'running' | 'paused'
  restartRequired: boolean
  activeProfile: string | null
  active: Run[]
  waiting: Waiting[]
  questions: OpenQuestion[]
  failures: Event[]
  held: string[]
  covered: string[]
  linearOrg: string | null
}

const RECENT_FAILURES = 10

export function readStatus(db: Db): SupervisorStatus {
  const meta = (key: string) =>
    db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value
  const stores = { now: () => new Date(), ulid: createUlid() }
  const questions = db
    .query<{ comment: string; issue: string; run: string | null; asked_to: string; asked_at: string }, []>(
      'SELECT comment, issue, run, asked_to, asked_at FROM questions WHERE answered_at IS NULL ORDER BY asked_at',
    )
    .all()
    .map((q) => ({
      comment: q.comment,
      issue: q.issue,
      run: q.run,
      askedTo: q.asked_to,
      askedAt: q.asked_at,
    }))
  return {
    dispatch: meta('dispatch') === 'paused' ? 'paused' : 'running',
    restartRequired: meta('restart_required') === 'true',
    activeProfile: meta('active_profile') ?? null,
    active: new RunStore(db, stores).active(),
    waiting: JSON.parse(meta('ready_queue') ?? '[]') as Waiting[],
    questions,
    failures: new EventLog(db, stores).since(null, { types: ['FAILURE_CLASSIFIED'] }).slice(-RECENT_FAILURES),
    held: heldIssues(db),
    covered: coveredIssues(db),
    linearOrg: meta('linear_org') ?? null,
  }
}
