import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { integrationHarness } from '../stages/integration/testing'
import { dispatchOne, harness } from './testing'

// One regression test per state incident listed in XXX-284.
describe('XXX-284 state incidents', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ns-incidents-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  async function running() {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    return { h, run }
  }

  test('XXX-268: a lagging read of our own status write does not stop the fresh run', async () => {
    const { h, run } = await running()
    // Linear returns the pre-dispatch status with a newer updatedAt; the history says nightshift wrote last.
    h.advance(60_000)
    h.linear.store.set('FOR-1', {
      ...h.linear.get('FOR-1'),
      status: 'Todo',
      updatedAt: '2026-10-04T10:01:00.000Z',
    })
    h.linear.changes.set('FOR-1', { actor: 'nightshift', app: true, at: '2026-10-04T10:00:00.000Z' })
    const report = await h.sup.tick()
    await h.sup.tick()
    expect(report.stopped).toEqual([])
    expect(h.sup.runs.get(run.id)?.state).toBe('running')
    expect(h.executor.ops('stop')).toEqual([])
    expect(h.linear.get('FOR-1').status).toBe('In Progress')
  })

  test('XXX-266: an issue moved to Done while running is no longer listed as covered', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sup.cover('FOR-1')
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.linear.patch('FOR-1', { status: 'Done' })
    await h.sup.tick()
    await h.sup.tick()
    expect(h.sup.runs.get(run.id)?.state).toBe('stopped')
    expect(h.linear.get('FOR-1').status).toBe('Done')
    expect(h.sup.covered()).toEqual([])
    expect(h.sup.status().covered).toEqual([])
    expect(h.sup.awaiting('FOR-1')).toBeNull()
  })

  test('2026-10 reset after a closed PR: moving the issue to Todo is not overwritten by the hold', async () => {
    const h = integrationHarness(root)
    await h.integrated()
    ;(h.gh.prs[0] as { state: string }).state = 'CLOSED'
    await h.first.tick()
    expect(h.linear.get('FOR-1').status).toBe('Blocked')
    expect(h.first.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'integration' })
    h.linear.patch('FOR-1', { status: 'Todo' })
    await h.first.tick()
    await h.first.tick()
    expect(h.linear.get('FOR-1').status).not.toBe('Blocked')
    expect(h.first.awaiting('FOR-1')).toBeNull()
    expect(h.first.pullRequests.get('FOR-1')).toBeNull()
  })

  test('XXX-245: a retry with an open PR is not stopped by the integration handler', async () => {
    const h = integrationHarness(root)
    await h.integrated()
    const before = h.linear.get('FOR-1')
    const retry = await h.first.retryRun('FOR-1', {}, 'cli')
    expect(h.linear.get('FOR-1')).toMatchObject({
      status: 'In Progress',
      labels: ['ai-stage:implementation'],
    })
    // An integration pass already in flight with the pre-retry snapshot.
    await h.handler.run({ issue: before, stage: 'integration', agent: undefined })
    const record = h.first.pullRequests.get('FOR-1')
    if (record) await h.first.pullRequestOpened(record, 'FOR-1: Trim names')
    await h.first.tick()
    await h.first.tick()
    expect(h.first.runs.get(retry.id)?.state).not.toBe('stopped')
    expect(h.linear.get('FOR-1')).toMatchObject({
      status: 'In Progress',
      labels: ['ai-stage:implementation'],
    })
    expect(h.of('WORKER_FAILED').filter((e) => e.run === retry.id)).toEqual([])
  })

  test('2026-10 restart: runs are not killed over the supervisor’s own Linear writes', async () => {
    const { h, run } = await running()
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
})
