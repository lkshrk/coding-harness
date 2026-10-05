import { describe, expect, test } from 'bun:test'
import { openState } from './db'
import { EventLog, EventValidationError } from './events'
import { LeaseStore } from './leases'
import { type NewRun, RunStore, RunTransitionError } from './runs'
import { createUlid } from './ulid'

function setup() {
  let t = Date.parse('2026-10-04T10:00:00.000Z')
  const now = () => new Date(t)
  const db = openState(':memory:')
  const log = new EventLog(db, { now, ulid: createUlid(() => t) })
  const runs = new RunStore(db, { now, ulid: createUlid(() => t) })
  const leases = new LeaseStore(db, { now, holder: 'inst-1', ttlMs: 180_000 })
  return { db, log, runs, leases, advance: (ms: number) => (t += ms) }
}

const newRun: NewRun = {
  issue: 'FOR-42',
  agent: 'implementer',
  profile: 'default',
  model: 'qwen',
  repository: 'omni',
  baseSha: 'abc',
  attempt: 1,
}

describe('EventLog', () => {
  test('append assigns id and time and stores the event', () => {
    const { log } = setup()
    const e = log.append({ type: 'SUPERVISOR_STARTED', data: { version: '0.0.0' } })
    expect(e.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(e.ts).toBe('2026-10-04T10:00:00.000Z')
    expect(log.since(null)).toEqual([e])
  })

  test('an invalid event throws and nothing is written', () => {
    const { log } = setup()
    expect(() => log.append({ type: 'LEASE_ACQUIRED', issue: 'FOR-1', data: {} })).toThrow(
      EventValidationError,
    )
    expect(log.since(null)).toEqual([])
  })

  test('since returns newer events, filtered', () => {
    const { log, runs, advance } = setup()
    const run = runs.create(newRun)
    const a = log.append({ type: 'DISPATCH_PAUSED', data: {} })
    advance(1)
    const b = log.append({
      type: 'WORKER_FAILED',
      issue: 'FOR-42',
      run: run.id,
      data: { reason: 'crash' },
    })
    advance(1)
    const c = log.append({ type: 'DISPATCH_RESUMED', data: {} })
    expect(log.since(a.id).map((e) => e.id)).toEqual([b.id, c.id])
    expect(log.since(null, { issue: 'FOR-42' })).toEqual([b])
    expect(log.since(null, { run: run.id })).toEqual([b])
    expect(log.since(null, { types: ['DISPATCH_PAUSED', 'DISPATCH_RESUMED'] }).map((e) => e.id)).toEqual([
      a.id,
      c.id,
    ])
  })
})

describe('RunStore', () => {
  test('create starts a run in queued', () => {
    const { runs } = setup()
    const run = runs.create(newRun)
    expect(run).toMatchObject({ ...newRun, state: 'queued', startedAt: '2026-10-04T10:00:00.000Z' })
    expect(runs.active()).toEqual([run])
  })

  test('follows the state machine', () => {
    const { runs, log } = setup()
    const run = runs.create(newRun)
    const cause = log.append({ type: 'DISPATCH_RESUMED', data: {} })
    for (const to of ['starting', 'running', 'finishing', 'gating', 'reviewing', 'done'] as const) {
      expect(runs.transition(run.id, to, cause).state).toBe(to)
    }
    expect(runs.get(run.id)?.endedAt).toBe('2026-10-04T10:00:00.000Z')
    expect(runs.active()).toEqual([])
  })

  test('rejects transitions not in the state machine', () => {
    const { runs, log } = setup()
    const run = runs.create(newRun)
    const cause = log.append({ type: 'DISPATCH_RESUMED', data: {} })
    runs.transition(run.id, 'starting', cause)
    runs.transition(run.id, 'running', cause)
    expect(() => runs.transition(run.id, 'reviewing', cause)).toThrow('running → reviewing not allowed')
    expect(() => runs.transition(run.id, 'reviewing', cause)).toThrow(RunTransitionError)
  })

  test('any non-terminal state may fail or stop; terminal states are final', () => {
    const { runs, log } = setup()
    const cause = log.append({ type: 'DISPATCH_RESUMED', data: {} })
    const a = runs.create(newRun)
    expect(runs.transition(a.id, 'failed', cause).state).toBe('failed')
    expect(() => runs.transition(a.id, 'stopped', cause)).toThrow('failed → stopped not allowed')
    const b = runs.create({ ...newRun, attempt: 2 })
    runs.transition(b.id, 'starting', cause)
    expect(runs.transition(b.id, 'stopped', cause).state).toBe('stopped')
  })

  test('update sets runtime fields; forIssue lists attempts in order', () => {
    const { runs } = setup()
    const a = runs.create(newRun)
    runs.create({ ...newRun, attempt: 2 })
    const updated = runs.update(a.id, { sandbox: 'c1', session: 's1', failure: 'environment' })
    expect(updated).toMatchObject({ sandbox: 'c1', session: 's1', failure: 'environment' })
    expect(runs.forIssue('FOR-42').map((r) => r.attempt)).toEqual([1, 2])
  })
})

describe('LeaseStore', () => {
  test('one lease per issue until released or expired', () => {
    const { runs, leases, advance } = setup()
    const run = runs.create(newRun)
    expect(leases.acquire('FOR-42', run.id)).toBe(true)
    expect(leases.acquire('FOR-42', run.id)).toBe(false)
    expect(leases.get('FOR-42')).toEqual({
      issue: 'FOR-42',
      run: run.id,
      holder: 'inst-1',
      expiresAt: '2026-10-04T10:03:00.000Z',
    })
    advance(180_001)
    expect(leases.expired().map((l) => l.issue)).toEqual(['FOR-42'])
    expect(leases.acquire('FOR-42', run.id)).toBe(true)
    leases.release('FOR-42')
    expect(leases.get('FOR-42')).toBeUndefined()
  })

  test('renew extends the lease', () => {
    const { runs, leases, advance } = setup()
    const run = runs.create(newRun)
    leases.acquire('FOR-42', run.id)
    advance(120_000)
    leases.renew('FOR-42')
    advance(120_000)
    expect(leases.expired()).toEqual([])
  })
})
