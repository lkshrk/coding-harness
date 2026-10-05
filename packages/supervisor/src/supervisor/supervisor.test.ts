import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import type { Classifier, ExecResult, FailureSignal, GateResult } from '../ports'
import { attemptsOf, TaskTooLargeError } from '../stages/context'
import { integrationHarness } from '../stages/integration/testing'
import { issueBody, snapshot, testConfig } from '../testing/testing'

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

describe('stage engine', () => {
  test('an issue without a stage enters the first stage of its pipeline', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-1', status: 'Triage', labels: [] }))
    await h.sup.start()
    await h.sup.tick()
    expect(h.of('STAGE_ENTERED')[0]).toMatchObject({ issue: 'FOR-1', data: { stage: 'intake' } })
    expect(h.linear.get('FOR-1').labels).toEqual(['ai-stage:intake'])
  })

  test('a stage the pipeline omits is skipped', async () => {
    const h = harness()
    h.linear.put(
      snapshot({ identifier: 'FOR-1', project: null, labels: ['bug', 'repo:omni', 'ai-stage:design'] }),
    )
    await h.sup.start()
    await h.sup.tick()
    expect(h.of('STAGE_ENTERED')[0]?.data).toEqual({ stage: 'implementation', from: 'design' })
  })

  test('role stages go to the stage handler once at a time', async () => {
    const calls: string[] = []
    let finish: () => void = () => {}
    const h = harness({
      stageHandler: {
        run: (w) => {
          calls.push(`${w.issue.identifier}:${w.stage}:${w.agent}`)
          return new Promise<void>((r) => {
            finish = r
          })
        },
      },
    })
    h.linear.put(snapshot({ identifier: 'FOR-1', status: 'Triage', labels: ['ai-stage:intake'] }))
    await h.sup.start()
    await h.sup.tick()
    await h.sup.tick()
    expect(calls).toEqual(['FOR-1:intake:intake'])
    finish()
    await Bun.sleep(0)
    await h.sup.tick()
    expect(calls.length).toBe(2)
  })

  test('a stage that fails three times in a row blocks the issue and notifies once', async () => {
    let calls = 0
    const h = harness({
      stageHandler: {
        run: async () => {
          calls++
          throw new Error('gh pr create exited 1: No commits between main and ns/FOR-1')
        },
      },
    })
    h.linear.put(snapshot({ identifier: 'FOR-1', status: 'Triage', labels: ['ai-stage:intake'] }))
    await h.sup.start()
    for (let i = 0; i < 4; i++) {
      await h.sup.tick()
      await Bun.sleep(0)
    }
    expect(calls).toBe(3)
    expect(h.linear.get('FOR-1')).toMatchObject({ status: 'Blocked' })
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'intake' })
    expect(h.notifier.sent.map((n) => [n.title, n.context])).toEqual([
      ['intake failed 3 times in a row', ['gh pr create exited 1: No commits between main and ns/FOR-1']],
    ])
  })

  test('completing a stage enters the next one; a checkpoint after holds it for you', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-1', status: 'In Review', labels: ['ai-stage:verification'] }))
    await h.sup.start()
    await h.sup.completeStage('FOR-1')
    expect(h.of('STAGE_COMPLETED')[0]?.data).toEqual({ stage: 'verification' })
    expect(h.of('STAGE_ENTERED')[0]?.data).toEqual({ stage: 'integration', from: 'verification' })
    h.linear.patch('FOR-1', { labels: ['ai-stage:acceptance'] })
    await h.sup.completeStage('FOR-1')
    expect(h.linear.get('FOR-1')).toMatchObject({ status: 'Blocked', labels: ['ai-stage:acceptance'] })
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'after', stage: 'acceptance' })
    expect(h.of('STAGE_COMPLETED').length).toBe(1)
    h.linear.patch('FOR-1', { status: 'Todo' })
    await h.sup.tick()
    expect(h.of('STAGE_COMPLETED').at(-1)?.data).toEqual({ stage: 'acceptance' })
  })

  test('entering a stage with a checkpoint before holds it; ready releases it', async () => {
    const h = harness()
    h.config.stages.implementation = { automatic: true, human_checkpoint: 'before' }
    h.linear.put(
      snapshot({
        identifier: 'FOR-1',
        status: 'Backlog',
        project: null,
        labels: ['bug', 'repo:omni', 'ai-stage:intake'],
      }),
    )
    await h.sup.start()
    await h.sup.completeStage('FOR-1')
    expect(h.linear.get('FOR-1')).toMatchObject({
      status: 'Blocked',
      labels: ['bug', 'repo:omni', 'ai-stage:implementation'],
    })
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'before', stage: 'implementation' })
    expect((await h.sup.tick()).dispatched).toEqual([])
    h.linear.patch('FOR-1', { status: 'Todo' })
    await h.sup.tick()
    expect(h.sup.awaiting('FOR-1')).toBeNull()
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
  })
})

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

describe('failures and retries', () => {
  test('an environment failure retries the same issue after backoff without counting', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'gateway_error', '502')
    expect(h.of('FAILURE_CLASSIFIED')[0]?.data).toEqual({
      class: 'environment',
      action: 'retry_same',
      fallback: false,
    })
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'failed', failure: 'environment' })
    expect(h.sup.leases.get('FOR-1')).toBeUndefined()
    expect(h.of('LEASE_RELEASED').length).toBe(1)
    expect(h.linear.get('FOR-1')).toMatchObject({ status: 'Todo', labels: ['ai-stage:implementation'] })
    expect((await h.sup.tick()).dispatched).toEqual([])
    h.advance(1000)
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
    expect(h.sup.runs.forIssue('FOR-1').map((r) => r.attempt)).toEqual([1, 2])
    expect(h.sup.escalationCount('FOR-1')).toBe(0)
  })

  test('the next attempt selects its agent with the attempt number and failure class', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'gateway_error')
    h.advance(1000)
    await h.sup.tick()
    const second = h.sup.runs.forIssue('FOR-1')[1]
    if (!second) throw new Error('no second run')
    await h.sup.workerFailed(second.id, 'gateway_error')
    h.advance(2000)
    await h.sup.tick()
    expect(h.sup.runs.forIssue('FOR-1').map((r) => r.agent)).toEqual([
      'implementer',
      'implementer',
      'implementer-strong',
    ])
  })

  test('three environment failures in a row pause dispatch and notify', async () => {
    const h = harness()
    h.linear.put(
      snapshot({ identifier: 'FOR-1', description: files('a') }),
      snapshot({ identifier: 'FOR-2', description: files('b') }),
      snapshot({ identifier: 'FOR-3', description: files('c') }),
    )
    h.config.limits.concurrency = 3
    await h.sup.start()
    await h.sup.tick()
    for (const r of h.sup.runs.active()) await h.sup.workerFailed(r.id, 'sandbox_error')
    expect(h.of('DISPATCH_PAUSED')[0]?.data).toEqual({
      reason: '3 environment failures in a row',
      by: 'supervisor',
    })
    expect(h.notifier.sent.map((n) => n.title)).toEqual(['dispatch paused: 3 environment failures in a row'])
    expect(h.of('NOTIFICATION_SENT')[0]?.data).toEqual({
      channel: 'macos',
      title: 'dispatch paused: 3 environment failures in a row',
    })
    h.advance(60_000)
    expect((await h.sup.tick()).dispatched).toEqual([])
    h.sup.resume('ns resume')
    expect((await h.sup.tick()).dispatched.length).toBe(3)
  })

  test('an unclassifiable failure escalates to you with one comment', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'crash', 'segfault')
    expect(h.of('FAILURE_CLASSIFIED')[0]?.data).toEqual({
      class: 'unknown',
      action: 'escalate_user',
      fallback: true,
    })
    expect(h.linear.get('FOR-1')).toMatchObject({ status: 'Blocked', labels: ['ai-stage:implementation'] })
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'implementation' })
    expect((await h.linear.comments('FOR-1')).length).toBe(1)
    expect(h.sup.escalationCount('FOR-1')).toBe(1)
  })

  test('a failed review is an implementation defect: the repairer continues from the failed commit on its base', async () => {
    let bases = 0
    let classifications = 0
    const h = harness({
      repos: { baseSha: async () => `base${++bases}` },
      classifier: {
        classify: async () => {
          classifications++
          return { class: 'unknown', action: 'escalate_user' }
        },
      },
    })
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb', session: 's' })
    await h.sup.workerFinished(run.id, {
      status: 'DONE',
      summary: 's',
      evidence: [{ kind: 'test', ref: 't', result: 'pass' }],
    })
    await h.sup.headImported(run.id, 'head1')
    await h.sup.gatesFinished(run.id, [
      {
        check: 't',
        passed: true,
        result: { exitCode: 0, durationMs: 1, stdoutTail: '', stderrTail: '', artifact: '', timedOut: false },
      },
    ])
    await h.sup.reviewFinished(run.id, {
      kind: 'verdict',
      review: {
        verdict: 'fail',
        findings: [
          {
            severity: 'BLOCKER',
            file: 'a.ts',
            lines: '1',
            message: 'listbox unbounded',
            evidence: 'e',
            confidence: 0.9,
          },
        ],
      },
      model: 'm',
    })
    expect(h.of('FAILURE_CLASSIFIED')[0]?.data).toMatchObject({
      class: 'implementation_defect',
      action: 'retry_same',
    })
    expect(h.sup.awaiting('FOR-1')).toBeNull()
    h.advance(5_000)
    await h.sup.tick()
    const next = h.sup.runs.forIssue('FOR-1').at(-1)
    expect(next).toMatchObject({ attempt: 2, agent: 'repairer', baseSha: 'base1' })
    expect(classifications).toBe(0)
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: run.id, headSha: 'head1' })
  })

  test('a worker failure without a commit starts the next attempt fresh from the current base', async () => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'sandbox_error', 'docker down')
    h.advance(5_000)
    await h.sup.tick()
    expect(h.sup.runs.forIssue('FOR-1').at(-1)).toMatchObject({ attempt: 2, baseSha: 'base2' })
    expect(h.executor.starts.at(-1)?.repairFrom).toBeUndefined()
  })

  test('actions the supervisor does not own go to the remediation handler', async () => {
    const handled: string[] = []
    const h = harness({
      classifier: { classify: async () => ({ class: 'implementation_defect', action: 'repair' }) },
      remediation: {
        handle: async (run, c) => {
          handled.push(`${run.issue}:${c.action}`)
          return 'handled'
        },
      },
    })
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'crash')
    expect(handled).toEqual(['FOR-1:repair'])
    expect(h.sup.awaiting('FOR-1')).toBeNull()
  })

  test('reaching repair_rounds + 2 non-environment failures escalates regardless of class', async () => {
    const h = harness({
      classifier: { classify: async () => ({ class: 'implementation_defect', action: 'repair' }) },
      remediation: { handle: async () => 'handled' },
    })
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    for (let i = 0; i < 4; i++) {
      h.linear.patch('FOR-1', { status: 'Todo', labels: ['ai-stage:implementation'] })
      await h.sup.tick()
      const run = h.sup.runs.active()[0]
      if (!run) throw new Error('no run')
      await h.sup.workerFailed(run.id, 'crash')
    }
    expect(h.sup.escalationCount('FOR-1')).toBe(4)
    expect(h.linear.get('FOR-1').status).toBe('Blocked')
    expect(h.sup.awaiting('FOR-1')?.kind).toBe('escalated')
  })
})

describe('manual retry', () => {
  async function failedWithCommit(h: ReturnType<typeof harness>) {
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: 'sb', session: 's' })
    await h.sup.headImported(run.id, 'head1')
    await h.sup.workerFailed(run.id, 'crash', 'segfault')
    expect(h.sup.runs.get(run.id)?.failure).toBe('unknown')
    return run
  }

  test('--continue resumes from the commit of a failed attempt whatever its failure class', async () => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    const first = await failedWithCommit(h)
    const next = await h.sup.retryRun('FOR-1', { continue: true }, 'cli')
    expect(next).toMatchObject({ attempt: 2, baseSha: 'base1' })
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: first.id, headSha: 'head1' })
    expect(h.of('DISPATCHED').at(-1)?.data).toMatchObject({ continues: first.id, reason: 'manual retry' })
  })

  test('--continue skips later attempts without a commit and uses the latest one that has one', async () => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    const first = await failedWithCommit(h)
    const second = await h.sup.retryRun('FOR-1', {}, 'cli')
    await h.sup.workerFailed(second.id, 'crash', 'segfault')
    const third = await h.sup.retryRun('FOR-1', { continue: true }, 'cli')
    expect(third).toMatchObject({ attempt: 3, baseSha: 'base1' })
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: first.id, headSha: 'head1' })
  })

  test('--continue is refused when no earlier attempt has a commit', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerFailed(run.id, 'crash', 'segfault')
    await expect(h.sup.retryRun('FOR-1', { continue: true }, 'cli')).rejects.toMatchObject({
      code: 'refused',
      message: 'FOR-1: no earlier attempt has a commit to continue from',
    })
    expect(h.sup.runs.forIssue('FOR-1').length).toBe(1)
  })

  async function runningWithCommit(h: ReturnType<typeof harness>) {
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.executor.heads.set(run.id, 'head1')
    return run
  }

  const exits: [string, (h: ReturnType<typeof harness>, id: string) => Promise<void>][] = [
    [
      'BLOCKED finish',
      (h, id) =>
        h.sup.workerFinished(id, {
          status: 'BLOCKED',
          summary: 's',
          evidence: [{ kind: 'test', ref: 't', result: 'pass' }],
          blocker: { needs: 'decision', reason: 'r' },
        }),
    ],
    ['step limit', (h, id) => h.sup.workerFailed(id, 'step_cap')],
    ['time limit', (h, id) => h.sup.workerFailed(id, 'time_cap')],
    [
      'stall',
      async (h, id) => {
        await h.sup.workerStalled(id, 'no_tool_calls')
        await h.sup.workerStalled(id, 'no_tool_calls')
      },
    ],
    ['supervisor stop', (h, id) => h.sup.stopRun(id, 'issue changed in Linear')],
  ]

  test.each(exits)('a run ending by %s records its commit and --continue resumes from it', async (_, end) => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    const run = await runningWithCommit(h)
    await end(h, run.id)
    expect(h.sup.runs.get(run.id)?.headSha).toBe('head1')
    expect(h.executor.calls.find((c) => c.op === 'captureHead')).toEqual({
      op: 'captureHead',
      run: run.id,
      detail: `sb-${run.id}`,
    })
    h.linear.patch('FOR-1', { status: 'Todo', labels: ['ai-stage:implementation'] })
    const next = await h.sup.retryRun('FOR-1', { continue: true }, 'cli')
    expect(next).toMatchObject({ attempt: 2, baseSha: 'base1' })
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: run.id, headSha: 'head1' })
  })

  test('a supervisor stop captures the commit before the sandbox is destroyed', async () => {
    const h = harness()
    const run = await runningWithCommit(h)
    let alive: boolean | undefined
    h.executor.captureHead = async (r) => {
      alive = h.sandbox.sandboxes.has(`sb-${r.id}`)
      return 'head1'
    }
    await h.sup.stopRun(run.id, 'retry requested')
    expect(alive).toBe(true)
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(h.sup.runs.get(run.id)?.headSha).toBe('head1')
  })

  test('a failed run without commits keeps a null head and --continue is refused', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    await h.sup.workerFailed(run.id, 'step_cap')
    expect(h.sup.runs.get(run.id)?.headSha).toBeNull()
    await expect(h.sup.retryRun('FOR-1', { continue: true }, 'cli')).rejects.toMatchObject({
      code: 'refused',
    })
  })

  test('a plain retry after a failure with a commit starts fresh from the current base', async () => {
    let bases = 0
    const h = harness({ repos: { baseSha: async () => `base${++bases}` } })
    await failedWithCommit(h)
    const next = await h.sup.retryRun('FOR-1', {}, 'cli')
    expect(next).toMatchObject({ attempt: 2, baseSha: 'base2' })
    expect(h.executor.starts.at(-1)?.repairFrom).toBeUndefined()
    expect(h.of('DISPATCHED').at(-1)?.data).not.toHaveProperty('continues')
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

describe('gates', () => {
  const gate = (check: string, exitCode: number, over: Partial<ExecResult> = {}): GateResult => ({
    check,
    passed: exitCode === 0,
    result: {
      exitCode,
      durationMs: 1234.4,
      stdoutTail: `${check} output`,
      stderrTail: '',
      artifact: `/state/artifacts/r/gate-${check}.log`,
      timedOut: false,
      ...over,
    },
  })

  async function gating(h: ReturnType<typeof harness>) {
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    await h.sup.workerFinished(run.id, {
      status: 'DONE',
      summary: 'done',
      evidence: [{ kind: 'test', ref: 'bun test', result: 'pass' }],
    })
    return run
  }

  test('an imported head is stored and the worker sandbox destroyed', async () => {
    const h = harness()
    const run = await gating(h)
    await h.sup.headImported(run.id, 'c0ffee')
    expect(h.sup.runs.get(run.id)).toMatchObject({ headSha: 'c0ffee', sandbox: null, state: 'gating' })
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(h.of('SANDBOX_DESTROYED')[0]?.data).toEqual({ driver: 'docker', id: `sb-${run.id}` })
  })

  test('passing gates move the run to reviewing and run the next step', async () => {
    const h = harness()
    const run = await gating(h)
    await h.sup.gatesFinished(run.id, [gate('lint', 0), gate('test', 0)])
    expect(h.of('GATE_PASSED').map((e) => e.data)).toEqual([
      {
        check: 'lint',
        exit_code: 0,
        duration_ms: 1234,
        output_tail: 'lint output',
        artifact: '/state/artifacts/r/gate-lint.log',
      },
      {
        check: 'test',
        exit_code: 0,
        duration_ms: 1234,
        output_tail: 'test output',
        artifact: '/state/artifacts/r/gate-test.log',
      },
    ])
    expect(h.sup.runs.get(run.id)?.state).toBe('reviewing')
    expect(h.executor.calls.filter((c) => c.op === 'runStep').map((c) => c.detail)).toEqual([
      'gating',
      'reviewing',
    ])
  })

  test('a failed gate fails the run, comments the tail once under the event marker, and remediates', async () => {
    let classifications = 0
    const h = harness({
      classifier: {
        classify: async () => {
          classifications++
          return { class: 'unknown', action: 'escalate_user' }
        },
      },
    })
    const run = await gating(h)
    await h.sup.gatesFinished(run.id, [gate('lint', 0), gate('test', 1, { stdoutTail: 'has ``` fence' })])
    const failed = h.of('GATE_FAILED')
    expect(failed.map((e) => e.data.check)).toEqual(['test'])
    expect(h.sup.runs.get(run.id)?.state).toBe('failed')
    const marker = `<!-- nightshift:${failed[0]?.id} -->`
    const posted = (await h.linear.comments('FOR-1')).filter((c) => c.body.includes(marker))
    expect(posted).toHaveLength(1)
    expect(posted[0]?.body).toStartWith(
      'Gate `test` failed: exit code 1 after 1.2s.\n\n````text\nhas ``` fence\n````',
    )
    expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(1)
    expect(h.of('FAILURE_CLASSIFIED')[0]?.data).toMatchObject({
      class: 'implementation_defect',
      fallback: false,
    })
    expect(classifications).toBe(0)
    expect(String((await h.linear.comments('FOR-1')).at(-1)?.body)).toContain(
      'failed: gate_failed (test exited 1)',
    )
    expect(h.sup.leases.get('FOR-1')).toBeUndefined()

    await h.sup.gatesFinished(run.id, [gate('test', 1)])
    expect(h.of('GATE_FAILED')).toHaveLength(1)
  })

  test('gate output in events is bounded to 8000 characters', async () => {
    const h = harness()
    const run = await gating(h)
    await h.sup.gatesFinished(run.id, [gate('test', 1, { stdoutTail: 'x'.repeat(20_000) })])
    expect(String(h.of('GATE_FAILED')[0]?.data.output_tail).length).toBe(8000)
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

describe('pull request watching', () => {
  async function watching(extra: Parameters<typeof integrationHarness>[2] = {}) {
    const root = mkdtempSync(join(tmpdir(), 'ns-watch-'))
    const h = integrationHarness(root, (c) => c, extra)
    const run = await h.integrated()
    return { ...h, run, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  test('checks turning green log CI_PASSED once', async () => {
    const h = await watching()
    try {
      h.gh.checks = [{ name: 'build', bucket: 'pending' }]
      await h.first.tick()
      expect(h.of('CI_PASSED')).toEqual([])
      h.gh.checks = [{ name: 'build', bucket: 'pass' }]
      await h.first.tick()
      await h.first.tick()
      expect(h.of('CI_PASSED').map((e) => [e.issue, e.run, e.data])).toEqual([
        ['FOR-1', h.run.id, { url: 'https://github.com/lkshrk/omni/pull/1' }],
      ])
      expect(h.gh.ciReads()).toHaveLength(2)
    } finally {
      h.cleanup()
    }
  })

  test('a failing check logs CI_FAILED with the check names and remediates with ci_failed', async () => {
    const signals: FailureSignal[] = []
    const classifier: Classifier = {
      async classify(f) {
        signals.push(f)
        return { class: 'implementation_defect', action: 'retry_same' }
      },
    }
    const h = await watching({ classifier })
    try {
      h.gh.checks = [
        { name: 'build', bucket: 'pass' },
        { name: 'e2e', bucket: 'fail' },
      ]
      await h.first.tick()
      await h.first.tick()
      expect(h.of('CI_FAILED').map((e) => e.data)).toEqual([
        {
          url: 'https://github.com/lkshrk/omni/pull/1',
          failed_checks: ['e2e'],
          failures: [{ name: 'e2e', url: 'https://github.com/lkshrk/omni/pull/1' }],
        },
      ])
      expect(signals).toEqual([])
      expect(h.of('FAILURE_CLASSIFIED').at(-1)?.data).toEqual({
        class: 'implementation_defect',
        action: 'retry_same',
        evidence: 'failed checks: e2e',
        fallback: false,
      })
      expect(h.linear.get('FOR-1')).toMatchObject({ status: 'Todo', labels: ['ai-stage:implementation'] })
      const marker = `<!-- nightshift:${h.of('CI_FAILED')[0]?.id} -->`
      expect((await h.linear.comments('FOR-1')).filter((c) => c.body.includes(marker))).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('a failing check hands its job log excerpt to the repair attempt, not to the event log', async () => {
    const h = await watching()
    try {
      h.gh.checks = [{ name: 'quality', bucket: 'fail', run: 5, job: 77 }]
      h.gh.logs['job 77'] =
        'quality\tTest\t2026-10-05T10:00:01Z (fail) stable locator contract\nquality\tTest\t2026-10-05T10:00:01Z error: expected "a" got "b"'
      await h.first.tick()
      const url = 'https://github.com/lkshrk/omni/actions/runs/5/job/77'
      expect(h.of('CI_FAILED').map((e) => e.data)).toEqual([
        {
          url: 'https://github.com/lkshrk/omni/pull/1',
          failed_checks: ['quality'],
          failures: [{ name: 'quality', url }],
        },
      ])
      expect(JSON.stringify(h.first.log.since(null, {}))).not.toContain('stable locator contract')
      const [attempt] = attemptsOf(h.db, 'FOR-1', 'next')
      expect(attempt?.ciFailures).toEqual([
        { name: 'quality', url, log: '(fail) stable locator contract\nerror: expected "a" got "b"' },
      ])
    } finally {
      h.cleanup()
    }
  })

  test('a merge logs MERGED, sets done and unblocks an issue blocked only by it', async () => {
    const h = await watching()
    try {
      h.first.cover('FOR-1')
      h.linear.put(
        snapshot({
          identifier: 'FOR-2',
          status: 'Backlog',
          blockedBy: [{ identifier: 'FOR-1', team: 'FOR', status: 'In Review' }],
          description: issueBody(['src/other.ts']),
        }),
      )
      expect((await h.first.tick()).unblocked).toEqual([])
      ;(h.gh.prs[0] as { state: string }).state = 'MERGED'
      const report = await h.first.tick()
      expect(h.of('MERGED').map((e) => [e.issue, e.data])).toEqual([
        [
          'FOR-1',
          {
            url: 'https://github.com/lkshrk/omni/pull/1',
            branch: 'ns/FOR-1',
            account: 'agent',
            mode: 'manual',
          },
        ],
      ])
      expect(h.of('STAGE_COMPLETED').at(-1)?.data).toEqual({ stage: 'integration' })
      expect(h.linear.get('FOR-1').status).toBe('Done')
      expect(h.first.covered()).not.toContain('FOR-1')
      expect(report.unblocked).toEqual(['FOR-2'])
      expect(h.of('DEPENDENCY_UNBLOCKED').map((e) => [e.issue, e.data])).toEqual([
        ['FOR-2', { by: ['FOR-1'] }],
      ])
      expect((await h.first.tick()).dispatched).toEqual(['FOR-2'])
      expect(h.first.pullRequests.all()).toEqual([])
      await h.first.tick()
      expect(h.gh.gh('view').length - h.gh.ciReads().length).toBe(2)
    } finally {
      h.cleanup()
    }
  })

  test('a PR closed without merge blocks the issue for you with one comment', async () => {
    const h = await watching()
    try {
      ;(h.gh.prs[0] as { state: string }).state = 'CLOSED'
      await h.first.tick()
      await h.first.tick()
      expect(h.linear.get('FOR-1').status).toBe('Blocked')
      expect(h.first.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'integration' })
      const closed = (await h.linear.comments('FOR-1')).filter((c) =>
        c.body.includes('closed without merging'),
      )
      expect(closed).toHaveLength(1)
      expect(h.gh.gh('create')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('an issue moved to Done or Canceled by hand stops watching its PR', async () => {
    const h = await watching()
    try {
      h.linear.patch('FOR-1', { status: 'Canceled' })
      await h.first.tick()
      await h.first.tick()
      expect(h.gh.gh('view')).toEqual([])
      expect(h.first.pullRequests.all()).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  test('an issue already Done by the GitHub automation still takes the merge path', async () => {
    const h = await watching()
    try {
      ;(h.gh.prs[0] as { state: string }).state = 'MERGED'
      h.linear.patch('FOR-1', { status: 'Done' })
      await h.first.tick()
      expect(h.of('MERGED')).toHaveLength(1)
      expect(h.of('STAGE_COMPLETED').at(-1)?.data).toEqual({ stage: 'integration' })
      expect(h.first.pullRequests.all()).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  test('an issue moved to Done by hand with an open PR stops watching it', async () => {
    const h = await watching()
    try {
      h.linear.patch('FOR-1', { status: 'Done' })
      await h.first.tick()
      expect(h.of('MERGED')).toEqual([])
      expect(h.first.pullRequests.all()).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  test('watching survives a supervisor restart', async () => {
    const h = await watching()
    try {
      const restarted = h.make('inst-2')
      await restarted.start()
      ;(h.gh.prs[0] as { state: string }).state = 'MERGED'
      await restarted.tick()
      expect(h.of('MERGED', restarted)).toHaveLength(1)
      expect(h.linear.get('FOR-1').status).toBe('Done')
    } finally {
      h.cleanup()
    }
  })
})
