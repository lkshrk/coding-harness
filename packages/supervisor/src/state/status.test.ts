import { describe, expect, test } from 'bun:test'
import { setCovered } from './coverage'
import { openState } from './db'
import { EventLog } from './events'
import { type NewRun, RunStore } from './runs'
import { readStatus } from './status'
import { createUlid } from './ulid'

function setup() {
  let t = Date.parse('2026-10-04T10:00:00.000Z')
  const now = () => new Date(t)
  const db = openState(':memory:')
  const ulid = createUlid(() => t)
  const log = new EventLog(db, { now, ulid })
  const runs = new RunStore(db, { now, ulid })
  const run = (issue: string) => {
    t += 1
    return runs.create({ ...newRun, issue })
  }
  const fail = (issue: string, runId = run(issue).id) => {
    t += 1
    return log.append({
      type: 'FAILURE_CLASSIFIED',
      issue,
      run: runId,
      data: { class: 'implementation_defect', action: 'escalate_user' },
    })
  }
  const later = () => (t += 1)
  return { db, log, runs, run, fail, later }
}

const newRun: NewRun = {
  issue: 'XXX-1',
  agent: 'implementer',
  profile: 'default',
  model: 'qwen',
  repository: 'omni',
  baseSha: 'abc',
  attempt: 1,
}

const failures = (db: ReturnType<typeof setup>['db']) => readStatus(db).failures.map((e) => e.issue)

describe('readStatus failures', () => {
  test('a failure followed by MERGED for the same issue is hidden', () => {
    const { db, log, fail, later } = setup()
    const f = fail('XXX-133')
    fail('XXX-134')
    later()
    log.append({
      type: 'MERGED',
      issue: 'XXX-133',
      run: f.run as string,
      data: { url: 'https://github.com/o/r/pull/1', branch: 'ns/XXX-133', account: 'bot', mode: 'manual' },
    })
    expect(failures(db)).toEqual(['XXX-134'])
  })

  test('a failure followed by a release of coverage is hidden', () => {
    const { db, log, fail, later } = setup()
    fail('XXX-133')
    later()
    log.append({ type: 'COVERAGE_CHANGED', issue: 'XXX-133', data: { covered: false, by: 'cli' } })
    expect(failures(db)).toEqual([])
  })

  test('a failure followed by completion of the last stage is hidden', () => {
    const { db, log, fail, later } = setup()
    fail('XXX-133')
    later()
    log.append({ type: 'STAGE_COMPLETED', issue: 'XXX-133', data: { stage: 'integration', last: true } })
    expect(failures(db)).toEqual([])
  })

  test('a failure followed by completion of an intermediate stage not yet moved on is shown', () => {
    const { db, log, fail, later } = setup()
    fail('XXX-133')
    later()
    log.append({ type: 'STAGE_COMPLETED', issue: 'XXX-133', data: { stage: 'implementation' } })
    expect(failures(db)).toEqual(['XXX-133'])
  })

  test('a failure followed by completion of an intermediate stage is shown', () => {
    const { db, log, fail, later } = setup()
    fail('XXX-133')
    later()
    log.append({ type: 'STAGE_COMPLETED', issue: 'XXX-133', data: { stage: 'implementation' } })
    log.append({
      type: 'STAGE_ENTERED',
      issue: 'XXX-133',
      data: { stage: 'verification', from: 'implementation' },
    })
    expect(failures(db)).toEqual(['XXX-133'])
  })

  test('a failure followed by a later successful run is hidden', () => {
    const { db, log, runs, run, fail } = setup()
    fail('XXX-133')
    const next = run('XXX-133')
    const cause = log.append({
      type: 'GATE_PASSED',
      issue: 'XXX-133',
      run: next.id,
      data: { check: 'test', exit_code: 0, duration_ms: 1 },
    })
    for (const s of ['starting', 'running', 'gating', 'reviewing', 'done'] as const)
      runs.transition(next.id, s, cause)
    expect(failures(db)).toEqual([])
  })

  test('a failure of an issue whose cached lifecycle is done or canceled is hidden', () => {
    const { db, fail } = setup()
    fail('XXX-133')
    fail('XXX-134')
    fail('XXX-135')
    const insert = db.query(
      `INSERT INTO issues (identifier, title, project, stage, lifecycle, status, blockers, waiting, updated_at)
       VALUES (?, 't', NULL, NULL, ?, 's', '[]', NULL, '2026-10-04T10:00:00.000Z')`,
    )
    insert.run('XXX-133', 'done')
    insert.run('XXX-134', 'canceled')
    insert.run('XXX-135', 'running')
    expect(failures(db)).toEqual(['XXX-135'])
  })

  test('failures of active, held or covered issues are shown', () => {
    const { db, log, fail, later } = setup()
    fail('XXX-1')
    fail('XXX-2')
    fail('XXX-3')
    later()
    log.append({ type: 'DISPATCH_PAUSED', issue: 'XXX-2', data: { reason: 'XXX-2 held', by: 'cli' } })
    log.append({ type: 'COVERAGE_CHANGED', issue: 'XXX-3', data: { covered: true, by: 'cli' } })
    setCovered(db, 'XXX-3', true)
    expect(failures(db)).toEqual(['XXX-1', 'XXX-2', 'XXX-3'])
  })

  test('a failure after a resolution is shown again', () => {
    const { db, log, fail, later } = setup()
    fail('XXX-133')
    later()
    log.append({ type: 'COVERAGE_CHANGED', issue: 'XXX-133', data: { covered: false, by: 'cli' } })
    const again = fail('XXX-133')
    expect(readStatus(db).failures.map((e) => e.id)).toEqual([again.id])
  })

  test('the 10-entry cap applies after filtering', () => {
    const { db, log, fail, later } = setup()
    const open = Array.from({ length: 10 }, (_, i) => fail(`XXX-${i + 1}`))
    for (let i = 0; i < 5; i++) fail('XXX-133')
    later()
    log.append({ type: 'COVERAGE_CHANGED', issue: 'XXX-133', data: { covered: false, by: 'cli' } })
    expect(readStatus(db).failures.map((e) => e.id)).toEqual(open.map((e) => e.id))
  })
})
