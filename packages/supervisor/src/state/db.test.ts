import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, MIGRATIONS, openState, STATE_SQL_PATH } from './db'

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-db-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('openState', () => {
  test('migration 1 is the spec schema verbatim', () => {
    expect(MIGRATIONS[0]).toBe(readFileSync(STATE_SQL_PATH, 'utf8'))
  })

  test('creates the schema and records the version', () => {
    const db = openState(join(tempDir(), 'nightshift.db'))
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((t) => t.name)
    expect(tables).toEqual(['events', 'issues', 'leases', 'meta', 'questions', 'runs', 'session_choices'])
    expect(db.query('SELECT value FROM meta WHERE key = ?').get('schema_version')).toEqual({
      value: String(MIGRATIONS.length),
    })
    expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    db.close()
  })

  test('reopening keeps the data and does not re-run migrations', () => {
    const path = join(tempDir(), 'nightshift.db')
    const db = openState(path)
    db.run("INSERT INTO meta (key, value) VALUES ('x', 'y')")
    db.close()
    const again = openState(path)
    expect(again.query('SELECT value FROM meta WHERE key = ?').get('x')).toEqual({ value: 'y' })
    again.close()
  })

  test('an unreadable database is replaced with an empty one', () => {
    const path = join(tempDir(), 'nightshift.db')
    writeFileSync(path, 'not a database at all, just garbage bytes '.repeat(200))
    const db = openState(path)
    expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 })
    db.close()
  })
})

describe('acquireLock', () => {
  test('a second holder is refused while the first is alive', () => {
    const path = join(tempDir(), 'nightshift.db')
    const release = acquireLock(path)
    expect(() => acquireLock(path)).toThrow(`another nightshift supervisor holds ${path}.lock`)
    release()
    acquireLock(path)()
  })

  test('a lock left by a dead process is taken over', () => {
    const path = join(tempDir(), 'nightshift.db')
    const dead = Bun.spawnSync(['true']).pid
    writeFileSync(`${path}.lock`, String(dead))
    const release = acquireLock(path)
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe(String(process.pid))
    release()
  })
})
