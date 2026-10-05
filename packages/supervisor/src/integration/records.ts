import type { Db } from '../db'
import type { PullRequest } from '../interfaces'
import type { MergeMode } from '../ports'

export type PullRequestRecord = PullRequest & {
  issue: string
  run: string
  headSha: string
  mode: MergeMode
  draft: boolean
  ci: 'pending' | 'passed' | 'failed'
  title?: string
  body?: string
  mergeSha?: string
}

const KEY = 'pull_requests'

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
