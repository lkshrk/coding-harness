import type { Db } from './db'

export type Lease = { issue: string; run: string; holder: string; expiresAt: string }

type Row = { issue: string; run: string; holder: string; expires_at: string }

const fromRow = (r: Row): Lease => ({ issue: r.issue, run: r.run, holder: r.holder, expiresAt: r.expires_at })

export class LeaseStore {
  readonly holder: string
  readonly ttlMs: number
  private readonly now: () => Date

  constructor(
    private readonly db: Db,
    opts: { now: () => Date; holder: string; ttlMs: number },
  ) {
    this.now = opts.now
    this.holder = opts.holder
    this.ttlMs = opts.ttlMs
  }

  acquire(issue: string, run: string, ttlMs = this.ttlMs): boolean {
    const now = this.now()
    const expires = new Date(now.getTime() + ttlMs).toISOString()
    const res = this.db
      .query(
        `INSERT INTO leases (issue, run, holder, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(issue) DO UPDATE SET run = excluded.run, holder = excluded.holder, expires_at = excluded.expires_at
         WHERE leases.expires_at <= ?`,
      )
      .run(issue, run, this.holder, expires, now.toISOString())
    return res.changes > 0
  }

  renew(issue: string, ttlMs = this.ttlMs): void {
    const expires = new Date(this.now().getTime() + ttlMs).toISOString()
    this.db
      .query('UPDATE leases SET expires_at = ? WHERE issue = ? AND holder = ?')
      .run(expires, issue, this.holder)
  }

  release(issue: string): void {
    this.db.query('DELETE FROM leases WHERE issue = ?').run(issue)
  }

  get(issue: string): Lease | undefined {
    const row = this.db.query<Row, [string]>('SELECT * FROM leases WHERE issue = ?').get(issue)
    return row ? fromRow(row) : undefined
  }

  all(): Lease[] {
    return this.db.query<Row, []>('SELECT * FROM leases ORDER BY issue').all().map(fromRow)
  }

  expired(now: Date = this.now()): Lease[] {
    return this.db
      .query<Row, [string]>('SELECT * FROM leases WHERE expires_at <= ? ORDER BY issue')
      .all(now.toISOString())
      .map(fromRow)
  }
}
