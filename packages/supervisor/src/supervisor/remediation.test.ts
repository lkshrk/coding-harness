import { describe, expect, test } from 'bun:test'
import { snapshot } from '../testing/testing'

import { dispatchOne, files, harness } from './testing'

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
