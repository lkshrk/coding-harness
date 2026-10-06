import type { CiFailure } from '../../ports'
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
