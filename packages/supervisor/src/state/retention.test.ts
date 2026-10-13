import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harness } from '../supervisor/testing'
import { type Db, openState } from './db'
import { retainArtifacts } from './retention'

const NOW = new Date('2026-10-13T12:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 3600_000)

function addRun(db: Db, id: string, state: string, endedAt: Date | null) {
  db.query(
    `INSERT INTO runs (id, issue, agent, profile, model, repository, base_sha, attempt, state, started_at, ended_at)
     VALUES (?, 'FOR-1', 'implementer', 'default', 'm', 'omni', 'base1', 1, ?, ?, ?)`,
  ).run(id, state, daysAgo(60).toISOString(), endedAt?.toISOString() ?? null)
}

describe('retainArtifacts', () => {
  let root: string
  let dir: string
  let db: Db

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'retention-'))
    dir = join(root, 'artifacts')
    db = openState(':memory:')
  })
  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const artifact = (name: string, mtime = NOW) => {
    const path = join(dir, name)
    mkdirSync(path, { recursive: true })
    utimesSync(path, mtime, mtime)
    return path
  }

  test('deletes a terminal run ended more than 30 days ago and keeps a recent one', () => {
    addRun(db, 'old', 'done', daysAgo(31))
    addRun(db, 'recent', 'failed', daysAgo(29))
    const old = artifact('old')
    const recent = artifact('recent', daysAgo(40))
    expect(retainArtifacts(db, [dir], NOW)).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  test('keeps a running run and a terminal run with an open question regardless of age', () => {
    addRun(db, 'running', 'running', null)
    addRun(db, 'asked', 'stopped', daysAgo(60))
    db.query(
      `INSERT INTO questions (comment, issue, run, asked_to, asked_at) VALUES ('c1', 'FOR-1', 'asked', 'user', ?)`,
    ).run(daysAgo(60).toISOString())
    const running = artifact('running', daysAgo(60))
    const asked = artifact('asked', daysAgo(60))
    expect(retainArtifacts(db, [dir], NOW)).toEqual([])
    expect(existsSync(running)).toBe(true)
    expect(existsSync(asked)).toBe(true)
  })

  test('deletes a directory without a run only when its mtime is older than 30 days', () => {
    const old = artifact('gate-old', daysAgo(31))
    const recent = artifact('gate-recent', daysAgo(29))
    expect(retainArtifacts(db, [dir], NOW)).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  test('ignores a missing directory', () => {
    expect(retainArtifacts(db, [join(root, 'missing')], NOW)).toEqual([])
  })
})

describe('Supervisor.start', () => {
  test('applies artifact retention to the given directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-'))
    try {
      const old = join(root, 'orphan')
      mkdirSync(old)
      const then = new Date(Date.parse('2026-10-04T10:00:00.000Z') - 31 * 24 * 3600_000)
      utimesSync(old, then, then)
      const h = harness({ artifactDirs: [root, join(root, 'missing')] })
      await h.sup.start()
      expect(existsSync(old)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
