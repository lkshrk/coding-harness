import { describe, expect, test } from 'bun:test'
import { TaskTooLargeError } from '../stages/context'

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

  test('stopRun keeps the work in progress by default', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.executor.heads.set(run.id, 'head1')
    await h.sup.stopRun(run.id, 'stopped by you')
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'stopped', headSha: 'head1' })
  })

  test('stopRun with keepWork false skips preserveHead but still destroys the sandbox and releases the lease', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.executor.heads.set(run.id, 'head1')
    await h.sup.stopRun(run.id, 'dropped', { keepWork: false })
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'stopped', headSha: null })
    expect(h.executor.ops('captureHead')).toEqual([])
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(h.sup.leases.get('FOR-1')).toBeUndefined()
  })

  test('a BLOCKED finish destroys the sandbox after preserving the head', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.executor.heads.set(run.id, 'head1')
    let aliveAtCapture = false
    const capture = h.executor.captureHead.bind(h.executor)
    h.executor.captureHead = async (r) => {
      aliveAtCapture = h.sandbox.sandboxes.has(`sb-${r.id}`)
      return capture(r)
    }
    await h.sup.workerFinished(run.id, {
      status: 'BLOCKED',
      summary: 'blocked',
      evidence: [],
      blocker: { needs: 'decision', reason: 'open choice' },
    })
    expect(aliveAtCapture).toBe(true)
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'failed', headSha: 'head1', sandbox: null })
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(h.of('SANDBOX_DESTROYED').map((e) => [e.run, e.data])).toEqual([
      [run.id, { driver: 'docker', id: `sb-${run.id}` }],
    ])
  })

  test('a NEEDS_CONTEXT finish destroys the sandbox after preserving the head', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.executor.heads.set(run.id, 'head1')
    await h.sup.workerFinished(run.id, {
      status: 'NEEDS_CONTEXT',
      summary: 'missing',
      evidence: [],
      blocker: { needs: 'context', reason: 'which API?', question: 'Which API version?' },
    })
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'failed', headSha: 'head1', sandbox: null })
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(h.of('SANDBOX_DESTROYED').map((e) => e.run)).toEqual([run.id])
    expect(h.of('QUESTION_ASKED').length).toBe(1)
  })

  test('a stall failure destroys the sandbox after preserving the head', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.executor.heads.set(run.id, 'head1')
    await h.sup.workerStalled(run.id, 'idle')
    await h.sup.workerStalled(run.id, 'idle')
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'failed', headSha: 'head1', sandbox: null })
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(h.of('SANDBOX_DESTROYED').map((e) => e.run)).toEqual([run.id])
  })

  test('a crashed run is failed even when destroying its sandbox fails', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.executor.heads.set(run.id, 'head1')
    h.sandbox.destroy = async () => {
      throw new Error('docker gone')
    }
    await h.sup.workerFailed(run.id, 'crash', 'exit 137')
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'failed', headSha: 'head1' })
    expect(h.of('SANDBOX_DESTROYED')).toEqual([])
    expect(h.sup.leases.get('FOR-1')?.run).not.toBe(run.id)
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
