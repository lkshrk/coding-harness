import { describe, expect, test } from 'bun:test'
import { snapshot } from '../testing/testing'

import { dispatchOne, harness } from './testing'

describe('recovery', () => {
  test('a queued run resumes after restart without waiting for a gateway key', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.db.query("UPDATE runs SET state = 'queued' WHERE id = ?").run(run.id)
    const restarted = h.make({ instanceId: 'inst-2' })
    expect((await restarted.start()).resumed).toEqual([run.id])
    await restarted.tick()
    expect(restarted.runs.get(run.id)?.state).toBe('starting')
    expect(h.executor.ops('start')).toEqual([run.id, run.id])
    expect(h.types(restarted)).not.toContain('GATEWAY_RECOVERED')
    expect(h.types(restarted)).not.toContain('GATEWAY_UNAVAILABLE')
  })

  async function crashed(state: 'alive' | 'gone') {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    if (state === 'alive') h.worker.sessions.add('s-1')
    else h.sandbox.sandboxes.clear()
    h.advance(120_000)
    const restarted = h.make({ instanceId: 'inst-2' })
    const report = await restarted.start()
    return { h, run, restarted, report }
  }

  test('a live sandbox is reattached, the lease renewed, and no failure is emitted', async () => {
    const { h, run, restarted, report } = await crashed('alive')
    expect(report.reattached).toEqual([run.id])
    expect(h.executor.ops('reattach')).toEqual([run.id])
    expect(restarted.leases.get('FOR-1')).toMatchObject({
      holder: 'inst-2',
      expiresAt: '2026-10-04T10:05:00.000Z',
    })
    expect(h.types(restarted)).not.toContain('WORKER_FAILED')
    expect(restarted.runs.get(run.id)?.state).toBe('running')
  })

  test('a gone sandbox fails the run with supervisor_restart and retries as attempt 2', async () => {
    const { h, run, restarted, report } = await crashed('gone')
    expect(report.failed).toEqual([run.id])
    expect(h.of('WORKER_FAILED', restarted)[0]?.data).toEqual({ reason: 'supervisor_restart' })
    h.advance(1000)
    expect((await restarted.tick()).dispatched).toEqual(['FOR-1'])
    expect(restarted.runs.forIssue('FOR-1').map((r) => r.attempt)).toEqual([1, 2])
    expect(restarted.escalationCount('FOR-1')).toBe(0)
  })

  test('an issue changed in Linear meanwhile stops the run', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.worker.sessions.add('s-1')
    h.linear.patch('FOR-1', { status: 'Canceled' })
    const restarted = h.make({ instanceId: 'inst-2' })
    const report = await restarted.start()
    expect(report.stopped).toEqual([run.id])
    expect(restarted.runs.get(run.id)?.state).toBe('stopped')
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(restarted.leases.get('FOR-1')).toBeUndefined()
  })

  test('a mismatch the supervisor made itself keeps the run across a restart', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.worker.sessions.add('s-1')
    h.linear.patch('FOR-1', { status: 'Todo' })
    h.linear.changes.set('FOR-1', { actor: 'nightshift', app: true, at: '2026-10-04T10:00:00.000Z' })
    const restarted = h.make({ instanceId: 'inst-2' })
    const report = await restarted.start()
    expect(report).toMatchObject({ stopped: [], reattached: [run.id] })
    expect(restarted.runs.get(run.id)?.state).toBe('running')
    expect(h.linear.get('FOR-1').status).toBe('In Progress')
    expect(h.of('MISMATCH_RESOLVED', restarted).map((e) => e.data)).toMatchObject([
      { actor: 'nightshift', app: true, action: 'reassert' },
    ])
  })

  test('runs in gating re-run that step', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-x', session: 's-1' })
    await h.sup.workerFinished(run.id, {
      status: 'DONE',
      summary: 's',
      evidence: [{ kind: 'test', ref: 't', result: 'pass' }],
    })
    const restarted = h.make({ instanceId: 'inst-2' })
    const report = await restarted.start()
    expect(report.resumed).toEqual([run.id])
    expect(h.executor.ops('runStep')).toEqual([run.id, run.id])
  })

  test('orphaned sandboxes and outboxes are removed', async () => {
    const h = harness()
    h.sandbox.add('01J9ZQ3W5C8XKQG4M2N7P6R1ST')
    h.outbox.dirs.add('01J9ZQ3W5C8XKQG4M2N7P6R1ST')
    h.outbox.dirs.add('01J9ZQ3W5C8XKQG4M2N7P6R1SV')
    const report = await h.sup.start()
    expect(report.orphanSandboxes).toEqual(['sb-01J9ZQ3W5C8XKQG4M2N7P6R1ST'])
    expect(h.outbox.list()).toEqual([])
  })

  test('with an empty database, issues running in Linear are treated as lost and re-dispatched as attempt 1', async () => {
    const h = harness()
    h.linear.put(
      snapshot({
        identifier: 'FOR-1',
        status: 'In Progress',
        labels: ['ai-stage:implementation', 'ai-agent:running'],
      }),
    )
    const report = await h.sup.start()
    expect(report.lost).toEqual(['FOR-1'])
    expect((await h.linear.comments('FOR-1')).length).toBe(1)
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
    const run = h.sup.runs.forIssue('FOR-1')[0]
    expect(run?.attempt).toBe(1)
    if (!run) return
    h.sandbox.add(run.id)
    h.worker.sessions.add('s-9')
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-9' })
    const report2 = await h.make({ instanceId: 'inst-3' }).start()
    expect(report2).toMatchObject({ lost: [], reattached: [run.id] })
    expect((await h.linear.comments('FOR-1')).length).toBe(1)
  })
})
