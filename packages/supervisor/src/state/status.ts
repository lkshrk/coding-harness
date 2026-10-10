import type { SupervisorStatus, Waiting } from '../ports/control'
import { coveredIssues, heldIssues } from './coverage'
import type { Db } from './db'
import { type Event, EventLog } from './events'
import { RunStore } from './runs'
import { createUlid } from './ulid'

export type { OpenQuestion, SupervisorStatus, Waiting } from '../ports/control'

const RECENT_FAILURES = 10

function resolved(e: Event): boolean {
  if (e.type === 'MERGED') return true
  return e.type === 'COVERAGE_CHANGED' && (e.data as { covered?: boolean }).covered === false
}

function openFailures(db: Db, log: EventLog): Event[] {
  const lastResolution = new Map<string, string>()
  // A STAGE_COMPLETED resolves its issue when it was the last stage, i.e. no
  // STAGE_ENTERED moved on from that stage afterwards.
  const pendingStage = new Map<string, { stage: unknown; id: string }>()
  const commit = (issue: string) => {
    const p = pendingStage.get(issue)
    if (p && p.id > (lastResolution.get(issue) ?? '')) lastResolution.set(issue, p.id)
    pendingStage.delete(issue)
  }
  for (const e of log.since(null, {
    types: ['MERGED', 'COVERAGE_CHANGED', 'STAGE_COMPLETED', 'STAGE_ENTERED'],
  })) {
    if (!e.issue) continue
    const data = e.data as { stage?: unknown; from?: unknown }
    if (e.type === 'STAGE_COMPLETED') {
      commit(e.issue)
      pendingStage.set(e.issue, { stage: data.stage, id: e.id })
    } else if (e.type === 'STAGE_ENTERED') {
      if (pendingStage.get(e.issue)?.stage === data.from) pendingStage.delete(e.issue)
      else commit(e.issue)
    } else if (resolved(e)) lastResolution.set(e.issue, e.id)
  }
  for (const issue of [...pendingStage.keys()]) commit(issue)
  const lastSuccess = new Map(
    db
      .query<{ issue: string; ended: string }, []>(
        "SELECT issue, MAX(ended_at) AS ended FROM runs WHERE state = 'done' AND ended_at IS NOT NULL GROUP BY issue",
      )
      .all()
      .map((r) => [r.issue, r.ended]),
  )
  const hasIssues =
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'issues'").get() !== null
  const finished = new Set(
    hasIssues
      ? db
          .query<{ identifier: string }, []>(
            "SELECT identifier FROM issues WHERE lifecycle IN ('done', 'canceled')",
          )
          .all()
          .map((r) => r.identifier)
      : [],
  )
  return log.since(null, { types: ['FAILURE_CLASSIFIED'] }).filter((f) => {
    if (!f.issue) return true
    if (finished.has(f.issue)) return false
    if (f.id < (lastResolution.get(f.issue) ?? '')) return false
    return !(f.ts < (lastSuccess.get(f.issue) ?? ''))
  })
}

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
    failures: openFailures(db, new EventLog(db, stores)).slice(-RECENT_FAILURES),
    held: heldIssues(db),
    covered: coveredIssues(db),
    linearOrg: meta('linear_org') ?? null,
  }
}
