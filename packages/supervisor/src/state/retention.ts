import type { Db } from './db'

const RETENTION_MS = 90 * 24 * 3600_000

export function retain(db: Db, now: Date): void {
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString()
  const open = "SELECT id FROM runs WHERE state NOT IN ('done','failed','stopped')"
  db.query(
    `DELETE FROM events WHERE ts < ? AND (run IS NULL OR run NOT IN (${open}))
       AND (issue IS NULL OR issue NOT IN (SELECT issue FROM questions WHERE answered_at IS NULL))`,
  ).run(cutoff)
  db.query(
    `DELETE FROM runs WHERE started_at < ? AND state IN ('done','failed','stopped')
       AND id NOT IN (SELECT run FROM events WHERE run IS NOT NULL)
       AND id NOT IN (SELECT run FROM leases)
       AND id NOT IN (SELECT run FROM questions WHERE run IS NOT NULL)`,
  ).run(cutoff)
}
