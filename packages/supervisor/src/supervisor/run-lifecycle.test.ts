import { describe, expect, test } from 'bun:test'
import { TaskTooLargeError } from '../stages/context'
import { snapshot } from '../testing/testing'

import { dispatchOne, harness } from './testing'

describe('worker lifecycle', () => {
  test('WORKER_STARTED moves the run to running and posts the attach command once', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1', attach: 'ns attach FOR-1' })
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'running', sandbox: 'sb-1', session: 's-1' })
    const comments = await h.linear.comments('FOR-1')
    expect(comments.length).toBe(1)
    expect(comments[0]?.body).toContain('ns attach FOR-1')
    expect(comments[0]?.body).toMatch(/<!-- nightshift:[0-9A-Z]{26} -->/)
  })

  test('sandbox creation and worker progress are logged against the run', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.sandboxCreated(run.id, { driver: 'docker', id: 'sb-1', image: 'nightshift/worker:latest' })
    await h.sup.workerProgress(run.id, { steps: 3, tool_calls: 5, tokens: 1200, last_tool: 'edit' })
    expect(h.of('SANDBOX_CREATED').map((e) => [e.run, e.data])).toEqual([
      [run.id, { driver: 'docker', id: 'sb-1', image: 'nightshift/worker:latest' }],
    ])
    expect(h.of('WORKER_PROGRESS').map((e) => [e.run, e.data])).toEqual([
      [run.id, { steps: 3, tool_calls: 5, tokens: 1200, last_tool: 'edit' }],
    ])
  })

  test('a valid finish with DONE moves to gating and runs the next step', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    await h.sup.workerFinished(run.id, {
      status: 'DONE',
      summary: 'done',
      evidence: [{ kind: 'test', ref: 'bun test', result: 'pass' }],
    })
    expect(h.sup.runs.get(run.id)?.state).toBe('gating')
    expect(h.executor.ops('runStep')).toEqual([run.id])
    expect(h.linear.get('FOR-1').status).toBe('In Progress')
  })

  test('gates run in the background: finishing a worker returns before its step completes', async () => {
    const h = harness()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    h.executor.runStep = async (run) => {
      h.executor.calls.push({ op: 'runStep', run: run.id, detail: run.state })
      await gate
    }
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    await h.sup.workerFinished(run.id, {
      status: 'DONE',
      summary: 'done',
      evidence: [{ kind: 'test', ref: 'bun test', result: 'pass' }],
    })
    expect(h.sup.runs.get(run.id)?.state).toBe('gating')
    expect(h.sup.stepsRunning()).toEqual([`${run.id}:gating`])
    await h.sup.tick()
    expect(h.executor.ops('runStep')).toEqual([run.id])
    release()
    await h.sup.idle()
    expect(h.sup.stepsRunning()).toEqual([])
  })

  test('recovery starts a gating run in the background and does not start it twice', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    await h.sup.workerFinished(run.id, {
      status: 'DONE',
      summary: 'done',
      evidence: [{ kind: 'test', ref: 'bun test', result: 'pass' }],
    })
    await h.sup.idle()
    const hung = new Promise<void>(() => {})
    h.executor.runStep = async (r) => {
      h.executor.calls.push({ op: 'runStep', run: r.id, detail: r.state })
      await hung
    }
    const restarted = h.make()
    const report = await restarted.start()
    expect(report.resumed).toEqual([run.id])
    expect(restarted.stepsRunning()).toEqual([`${run.id}:gating`])
    await restarted.start()
    expect(h.executor.ops('runStep').filter((id) => id === run.id)).toHaveLength(2)
    expect(restarted.stepsRunning()).toEqual([`${run.id}:gating`])
  })

  test('a step that throws fails the run instead of escaping the background job', async () => {
    const h = harness()
    h.executor.runStep = async () => {
      throw new Error('docker gone')
    }
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    await h.sup.workerFinished(run.id, {
      status: 'DONE',
      summary: 'done',
      evidence: [{ kind: 'test', ref: 'bun test', result: 'pass' }],
    })
    await h.sup.idle()
    expect(h.sup.runs.get(run.id)?.state).toBe('failed')
    expect(h.of('WORKER_FAILED').map((e) => (e.data as { detail?: string }).detail)).toEqual([
      'gating: docker gone',
    ])
  })

  test('an invalid finish payload counts as no finish', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerFinished(run.id, { status: 'DONE' })
    expect(h.of('WORKER_NO_FINISH')[0]?.data).toMatchObject({ reason: 'no_finish' })
    expect(h.sup.runs.get(run.id)?.state).toBe('failed')
  })

  test('a stalled worker is nudged once, then stopped as failed', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    await h.sup.workerStalled(run.id, 'repeated_tool_call')
    expect(h.executor.ops('nudge')).toEqual([run.id])
    expect(h.sup.runs.get(run.id)?.state).toBe('running')
    await h.sup.workerStalled(run.id, 'idle')
    expect(h.executor.ops('stop')).toEqual([run.id])
    expect(h.sup.runs.get(run.id)?.state).toBe('failed')
    expect(h.of('WORKER_STALLED').length).toBe(2)
  })

  test('worker callbacks after stop are ignored and leave the run unchanged', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    h.sup.stop('signal')
    expect(h.types().at(-1)).toBe('SUPERVISOR_STOPPED')
    expect(h.executor.ops('detach')).toEqual(['*'])
    h.db.close()
    await h.sup.workerFailed(run.id, 'crash', 'late')
    await h.sup.workerStalled(run.id, 'idle')
    await h.sup.workerFinished(run.id, { status: 'DONE' })
    await h.sup.sandboxCreated(run.id, { driver: 'docker', id: 'sb-2', image: 'img' })
  })

  test('a worker failure after stop does not change the run', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    h.sup.stop('signal')
    const events = h.types()
    await h.sup.workerFailed(run.id, 'crash', 'late')
    expect(h.sup.runs.get(run.id)?.state).toBe('running')
    expect(h.types()).toEqual(events)
    expect(h.sup.leases.get('FOR-1')?.run).toBe(run.id)
  })

  test('an executor that cannot start the run fails it as a sandbox error', async () => {
    const h = harness()
    h.executor.failStart = 'docker not running'
    const run = await dispatchOne(h)
    expect(h.sup.runs.get(run.id)?.state).toBe('failed')
    expect(h.of('WORKER_FAILED')[0]?.data).toEqual({ reason: 'sandbox_error', detail: 'docker not running' })
  })

  test('an issue too large for the agent budget is recorded as task_too_large', async () => {
    const h = harness()
    h.executor.failStart = new TaskTooLargeError('ISSUE and VERIFY take 900 tokens, budget 800')
    const run = await dispatchOne(h)
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'failed', failure: 'task_too_large' })
    expect(h.of('WORKER_FAILED')[0]?.data).toEqual({
      reason: 'task_too_large',
      detail: "issue too large for the agent's budget: ISSUE and VERIFY take 900 tokens, budget 800",
    })
    expect(h.of('FAILURE_CLASSIFIED')[0]?.data).toMatchObject({ class: 'task_too_large' })
  })
})

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
