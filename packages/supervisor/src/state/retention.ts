import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db'

const RETENTION_MS = 90 * 24 * 3600_000
const ARTIFACT_RETENTION_MS = 30 * 24 * 3600_000

export function retain(db: Db, now: Date): void {
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString()
  const open = "SELECT id FROM runs WHERE state NOT IN ('done','failed','stopped','interrupted')"
  db.query(
    `DELETE FROM events WHERE ts < ? AND (run IS NULL OR run NOT IN (${open}))
       AND (issue IS NULL OR issue NOT IN (SELECT issue FROM questions WHERE answered_at IS NULL))`,
  ).run(cutoff)
  db.query(
    `DELETE FROM runs WHERE started_at < ? AND state IN ('done','failed','stopped','interrupted')
       AND id NOT IN (SELECT run FROM events WHERE run IS NOT NULL)
       AND id NOT IN (SELECT run FROM leases)
       AND id NOT IN (SELECT run FROM questions WHERE run IS NOT NULL)`,
  ).run(cutoff)
}

export function retainArtifacts(db: Db, dirs: readonly string[], now: Date): string[] {
  const cutoff = now.getTime() - ARTIFACT_RETENTION_MS
  const run = db.query<{ state: string; ended_at: string | null; open: number }, [string]>(
    `SELECT state, ended_at,
       EXISTS (SELECT 1 FROM questions WHERE run = runs.id AND answered_at IS NULL) AS open
     FROM runs WHERE id = ?`,
  )
  const terminal = new Set(['done', 'failed', 'stopped', 'interrupted'])
  const deleted: string[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') console.error(`artifact retention: ${dir}: ${err.message}`)
      continue
    }
    for (const name of names) {
      const path = join(dir, name)
      try {
        const stat = lstatSync(path)
        if (!stat.isDirectory()) continue
        const row = run.get(name)
        const expired = row
          ? terminal.has(row.state) &&
            row.open === 0 &&
            row.ended_at !== null &&
            Date.parse(row.ended_at) < cutoff
          : stat.mtimeMs < cutoff
        if (!expired) continue
        rmSync(path, { recursive: true, force: true })
        deleted.push(path)
      } catch (e) {
        console.error(`artifact retention: ${path}: ${(e as Error).message}`)
      }
    }
  }
  return deleted
}
