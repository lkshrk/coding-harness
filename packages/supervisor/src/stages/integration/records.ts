import type { CiFailure, ReviewThread } from '../../ports'
import type { PullRequestRecord } from '../../ports/git-host'
import type { Db } from '../../state/db'

export type { PullRequestRecord } from '../../ports/git-host'

const KEY = 'pull_requests'
const CI_KEY = 'ci_failures'

export class CiFailureStore {
  constructor(private readonly db: Db) {}

  get(run: string): CiFailure[] {
    return this.read()[run] ?? []
  }

  put(run: string, failures: CiFailure[]): void {
    const known = new Set(
      this.db
        .query<{ id: string }, []>('SELECT id FROM runs')
        .all()
        .map((r) => r.id),
    )
    const kept = Object.fromEntries(Object.entries(this.read()).filter(([id]) => known.has(id)))
    this.db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(CI_KEY, JSON.stringify({ ...kept, [run]: failures }))
  }

  private read(): Record<string, CiFailure[]> {
    const row = this.db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(CI_KEY)
    return row ? (JSON.parse(row.value) as Record<string, CiFailure[]>) : {}
  }
}

const THREADS_KEY = 'review_threads'

export type ReviewRound = {
  seen: number
  own?: number[]
  pending?: { run: string; threads: ReviewThread[] }
}

// Per issue: the newest review comment id already handed to a worker, the ids of nightshift's own
// replies, and the round awaiting its close-out.
export class ReviewRoundStore {
  constructor(private readonly db: Db) {}

  get(issue: string): ReviewRound {
    return this.read()[issue] ?? { seen: 0 }
  }

  put(issue: string, round: ReviewRound): void {
    this.db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(THREADS_KEY, JSON.stringify({ ...this.read(), [issue]: round }))
  }

  threadsFor(run: string): ReviewThread[] {
    return Object.values(this.read()).find((r) => r.pending?.run === run)?.pending?.threads ?? []
  }

  private read(): Record<string, ReviewRound> {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
      .get(THREADS_KEY)
    return row ? (JSON.parse(row.value) as Record<string, ReviewRound>) : {}
  }
}

const BASE_CONFLICTS_KEY = 'base_conflicts'

// Per issue: the base sha a continued attempt last had to resolve a merge with, and the run resolving it.
export type BaseConflict = { base: string; files: string[]; run: string }

export class BaseConflictStore {
  constructor(private readonly db: Db) {}

  get(issue: string): BaseConflict | null {
    return this.read()[issue] ?? null
  }

  forRun(run: string): BaseConflict | null {
    return Object.values(this.read()).find((c) => c.run === run) ?? null
  }

  put(issue: string, conflict: BaseConflict): void {
    this.db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(BASE_CONFLICTS_KEY, JSON.stringify({ ...this.read(), [issue]: conflict }))
  }

  private read(): Record<string, BaseConflict> {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
      .get(BASE_CONFLICTS_KEY)
    return row ? (JSON.parse(row.value) as Record<string, BaseConflict>) : {}
  }
}

export class PullRequestStore {
  constructor(private readonly db: Db) {}

  all(): PullRequestRecord[] {
    return Object.values(this.read())
  }

  get(issue: string): PullRequestRecord | null {
    return this.read()[issue] ?? null
  }

  put(record: PullRequestRecord): void {
    this.write({ ...this.read(), [record.issue]: record })
  }

  remove(issue: string): void {
    const all = this.read()
    delete all[issue]
    this.write(all)
  }

  private read(): Record<string, PullRequestRecord> {
    const row = this.db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(KEY)
    return row ? (JSON.parse(row.value) as Record<string, PullRequestRecord>) : {}
  }

  private write(all: Record<string, PullRequestRecord>): void {
    this.db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(KEY, JSON.stringify(all))
  }
}
