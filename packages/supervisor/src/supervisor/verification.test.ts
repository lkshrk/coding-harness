import { describe, expect, test } from 'bun:test'
import type { ExecResult, GateResult } from '../ports'
import { snapshot } from '../testing/testing'

import { dispatchOne, harness } from './testing'

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
    expect(h.of('STAGE_COMPLETED').at(-1)?.data).toEqual({ stage: 'acceptance', last: true })
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
