import { Database } from 'bun:sqlite'
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Config, expandHome } from '@nightshift/core'
import { STATE_V1, STATE_V2 } from './migrations'

export const STATE_SQL_PATH = join(import.meta.dir, 'state.sql')

export const MIGRATIONS: readonly string[] = [STATE_V1, STATE_V2]

export type Db = Database

export const STATE_DB = 'state.db'

export function statePath(config: Pick<Config, 'paths'>, home: string = homedir()): string {
  return join(expandHome(config.paths.state, home), STATE_DB)
}

function schemaVersion(db: Database): number {
  const hasMeta = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
  if (!hasMeta) return 0
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
    .get('schema_version')
  return row ? Number(row.value) : 0
}

function migrate(db: Database): void {
  const from = schemaVersion(db)
  MIGRATIONS.slice(from).forEach((sql, i) => {
    db.exec(sql)
    db.query(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(from + i + 1))
  })
}

function open(path: string): Database {
  const db = new Database(path, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

export function openState(path: string): Database {
  try {
    return open(path)
  } catch (e) {
    if (path === ':memory:' || !existsSync(path)) throw e
    renameSync(path, `${path}.unreadable`)
    for (const suffix of ['-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
    return open(path)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function acquireLock(dbPath: string): () => void {
  const lockPath = `${dbPath}.lock`
  const write = () => {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, String(process.pid))
    closeSync(fd)
  }
  try {
    write()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const holder = Number(readFileSync(lockPath, 'utf8').trim())
    if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
      throw new Error(`another nightshift supervisor holds ${lockPath}`)
    }
    rmSync(lockPath, { force: true })
    write()
  }
  return () => rmSync(lockPath, { force: true })
}

export function openStateReadOnly(path: string): Database | null {
  if (path !== ':memory:' && !existsSync(path)) return null
  const db = new Database(path, { readonly: true, strict: true })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}
