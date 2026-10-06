import { describe, expect, test } from 'bun:test'
import type { Config } from '@nightshift/core'
import { snapshot, testConfig } from '../testing/testing'

import { dispatchOne, files, harness } from './testing'

describe('start', () => {
  test('records SUPERVISOR_STARTED and the instance id', async () => {
    const h = harness()
    await h.sup.start()
    expect(h.of('SUPERVISOR_STARTED')[0]?.data).toEqual({ version: '0.0.0' })
    expect(h.db.query('SELECT value FROM meta WHERE key = ?').get('instance')).toEqual({ value: 'inst-1' })
  })

  test('refuses to start when the config does not match the Linear workspace', async () => {
    const h = harness()
    h.linear.workspaceValue = { ...h.linear.workspaceValue, teams: [] }
    await expect(h.sup.start()).rejects.toThrow('linear.teams[0].key: no team FOR in workspace h-cloud')
  })
})

describe('poll and dispatch', () => {
  test('dispatches ready issues: run, lease, Linear status, executor', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    expect(run).toMatchObject({
      issue: 'FOR-1',
      agent: 'implementer',
      profile: 'default',
      model: 'default/implementer',
      repository: 'omni',
      baseSha: 'base1',
      attempt: 1,
      state: 'starting',
    })
    expect(h.types()).toEqual(['SUPERVISOR_STARTED', 'DISPATCHED', 'LEASE_ACQUIRED', 'RUN_STARTING'])
    expect(h.sup.leases.get('FOR-1')?.run).toBe(run.id)
    expect(h.linear.get('FOR-1')).toMatchObject({
      status: 'In Progress',
      labels: ['ai-stage:implementation'],
    })
    expect(h.executor.ops('start')).toEqual([run.id])
  })

  test('respects the concurrency limit and does not dispatch an issue twice', async () => {
    const h = harness()
    h.linear.put(
      snapshot({ identifier: 'FOR-1', description: files('a') }),
      snapshot({ identifier: 'FOR-2', description: files('b') }),
      snapshot({ identifier: 'FOR-3', description: files('c') }),
    )
    await h.sup.start()
    const report = await h.sup.tick()
    expect(report.dispatched).toEqual(['FOR-1', 'FOR-2'])
    expect(report.waiting).toEqual([{ identifier: 'FOR-3', reason: 'concurrency limit reached' }])
    expect((await h.sup.tick()).dispatched).toEqual([])
    expect(h.sup.runs.active().length).toBe(2)
  })

  test('two ready issues touching the same files run one after the other', async () => {
    const h = harness()
    h.linear.put(
      snapshot({ identifier: 'FOR-1', description: files('src/sync/*.go') }),
      snapshot({ identifier: 'FOR-2', description: files('src/sync/store.go') }),
    )
    await h.sup.start()
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
    expect((await h.sup.tick()).waiting).toEqual([{ identifier: 'FOR-2', reason: 'files overlap FOR-1' }])
  })

  test('ignores excluded, unmanaged and non-automatic issues', async () => {
    const h = harness()
    h.linear.put(
      snapshot({ identifier: 'FOR-1', labels: ['ai-stage:implementation', 'business'] }),
      snapshot({ identifier: 'FOR-2', project: null, labels: ['ai-stage:implementation'] }),
      snapshot({ identifier: 'FOR-3', status: 'Backlog', labels: ['ai-stage:design'] }),
    )
    await h.sup.start()
    expect((await h.sup.tick()).dispatched).toEqual([])
    expect(h.linear.updates).toEqual([])
  })

  test('a backlog issue whose blockers are done is unblocked, then dispatched', async () => {
    const h = harness()
    h.linear.put(
      snapshot({
        identifier: 'FOR-2',
        status: 'Backlog',
        blockedBy: [{ identifier: 'FOR-1', team: 'FOR', status: 'Done' }],
      }),
    )
    await h.sup.start()
    expect((await h.sup.tick()).dispatched).toEqual([])
    expect(h.of('DEPENDENCY_UNBLOCKED')[0]).toMatchObject({ issue: 'FOR-2', data: { by: ['FOR-1'] } })
    expect(h.linear.get('FOR-2').status).toBe('Todo')
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-2'])
    expect(h.of('DEPENDENCY_UNBLOCKED').length).toBe(1)
  })

  test('paused dispatch takes no new work until resumed', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    h.sup.pause('ns pause')
    expect((await h.sup.tick()).dispatched).toEqual([])
    h.sup.resume('ns resume')
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
    expect(h.types()).toContain('DISPATCH_PAUSED')
    expect(h.types()).toContain('DISPATCH_RESUMED')
  })

  test('only changed issues are fetched after the first sweep', async () => {
    const h = harness()
    const seen: (string | undefined)[] = []
    const issues = h.linear.issues.bind(h.linear)
    h.linear.issues = async (q) => {
      seen.push(q.updatedSince)
      return issues(q)
    }
    h.linear.put(snapshot({ identifier: 'FOR-1', status: 'Backlog', labels: ['ai-stage:design'] }))
    await h.sup.start()
    await h.sup.tick()
    h.advance(1000)
    await h.sup.tick()
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toBe('2026-10-04T10:00:00.000Z')
  })
})

describe('config reload', () => {
  const reloaded = (config: Config) => ({ ok: true as const, config, sources: [] })

  test('a valid change is applied to new dispatches and recorded with the changed paths', async () => {
    const h = harness()
    h.linear.put(
      snapshot({ identifier: 'FOR-1', description: files('a') }),
      snapshot({ identifier: 'FOR-2', description: files('b') }),
    )
    await h.sup.start()
    const next = testConfig()
    next.limits.concurrency = 1
    await h.sup.reloadConfig(reloaded(next))
    expect(h.of('CONFIG_RELOADED')[0]?.data).toEqual({
      changed: ['limits.concurrency'],
      restart_required: false,
    })
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
  })

  test('an invalid change keeps the running config, is recorded and notified', async () => {
    const h = harness()
    await h.sup.start()
    await h.sup.reloadConfig({ ok: false, errors: [{ path: 'limits.concurrency', message: 'too big' }] })
    expect(h.of('CONFIG_REJECTED')[0]?.data).toEqual({ errors: ['limits.concurrency: too big'] })
    expect(h.notifier.sent[0]?.title).toBe('config rejected: limits.concurrency: too big')
    expect(h.sup.config.limits.concurrency).toBe(2)
  })

  test('paths and sandbox.driver are applied only after restart', async () => {
    const h = harness()
    await h.sup.start()
    const next = testConfig()
    next.paths.state = '/elsewhere'
    next.limits.concurrency = 4
    await h.sup.reloadConfig(reloaded(next))
    expect(h.of('CONFIG_RELOADED')[0]?.data).toEqual({
      changed: ['limits.concurrency', 'paths.state'],
      restart_required: true,
    })
    expect(h.sup.config.paths.state).toBe('/tmp/ns/state')
    expect(h.sup.config.limits.concurrency).toBe(4)
    expect(h.sup.status().restartRequired).toBe(true)
  })
})

describe('gateway reachability', () => {
  test('ordinary dispatch has a run cause and no gateway events', async () => {
    const h = harness()
    await dispatchOne(h)
    expect(h.types()).toContain('RUN_STARTING')
    expect(h.types()).not.toContain('GATEWAY_RECOVERED')
    expect(h.types()).not.toContain('GATEWAY_UNAVAILABLE')
  })

  test('gateway failures are deduplicated and the next successful run recovers once', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'gateway_error', 'HTTP 502')
    h.sup.gatewayReachable(false, 'still offline')
    expect(h.sup.gateway()).toBe('unavailable')
    expect(h.of('GATEWAY_UNAVAILABLE')).toHaveLength(1)
    h.advance(1000)
    await h.sup.tick()
    expect(h.sup.gateway()).toBe('ok')
    expect(h.of('GATEWAY_RECOVERED')).toHaveLength(1)
    const retried = h.sup.runs.active()[0]
    if (!retried) throw new Error('retry missing')
    await h.sup.workerStarted(retried.id, { sandbox: 'sb', session: 'session' })
    expect(h.of('GATEWAY_RECOVERED')).toHaveLength(1)
  })

  test('ingester gateway failures update reachability before ending ingestion', async () => {
    const h = harness()
    const run = h.sup.runs.create({
      issue: 'FOR-1',
      agent: 'ingester',
      profile: 'default',
      model: 'm',
      repository: 'omni',
      baseSha: 'b',
      attempt: 1,
    })
    await h.sup.workerFailed(run.id, 'gateway_error', 'connection refused')
    expect(h.sup.gateway()).toBe('unavailable')
    expect(h.of('GATEWAY_UNAVAILABLE')).toHaveLength(1)
  })
})

describe('retention and status', () => {
  test('events and finished runs older than 90 days are deleted at start; open runs are kept', async () => {
    const h = harness()
    const old = await dispatchOne(h)
    await h.sup.workerFailed(old.id, 'crash')
    h.linear.put(snapshot({ identifier: 'FOR-2', description: files('z') }))
    await h.sup.tick()
    h.advance(91 * 24 * 3600_000)
    await h.make({ instanceId: 'inst-2' }).start()
    expect(h.sup.runs.get(old.id)).toBeUndefined()
    expect(h.sup.runs.forIssue('FOR-2').length).toBe(1)
    expect(h.sup.log.since(null, { run: h.sup.runs.forIssue('FOR-2')[0]?.id ?? '' }).length).toBeGreaterThan(
      0,
    )
  })

  test('status reports dispatch state, active runs, open questions and the ready queue', async () => {
    const h = harness()
    h.linear.put(
      snapshot({ identifier: 'FOR-1', description: files('a') }),
      snapshot({ identifier: 'FOR-2', description: files('b') }),
      snapshot({ identifier: 'FOR-3', description: files('c') }),
    )
    await h.sup.start()
    await h.sup.tick()
    h.sup.pause('ns pause')
    expect(h.sup.status()).toMatchObject({
      dispatch: 'paused',
      restartRequired: false,
      activeProfile: 'default',
      active: [{ issue: 'FOR-1' }, { issue: 'FOR-2' }],
      waiting: [{ identifier: 'FOR-3', reason: 'concurrency limit reached' }],
      questions: [],
    })
  })
})
