import type { Db } from './db'

function list(db: Db, key: string): string[] {
  const raw = db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value
  return raw ? (JSON.parse(raw) as string[]) : []
}

function toggle(db: Db, key: string, issue: string, on: boolean): void {
  const rest = list(db, key).filter((i) => i !== issue)
  const next = on ? [...rest, issue].sort() : rest
  db.query(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(next))
}

export function coveredIssues(db: Db): string[] {
  return list(db, 'covered')
}

export function setCovered(db: Db, issue: string, covered: boolean): void {
  toggle(db, 'covered', issue, covered)
}

export function heldIssues(db: Db): string[] {
  return list(db, 'held')
}

export function setHeld(db: Db, issue: string, held: boolean): void {
  toggle(db, 'held', issue, held)
}
