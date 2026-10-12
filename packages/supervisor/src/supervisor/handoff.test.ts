import { describe, expect, test } from 'bun:test'
import { historyItems } from '../stages/context/sections'
import { attemptsOf } from '../stages/context/task'
import { snapshot } from '../testing/testing'
import { dispatchOne, harness } from './testing'

const HANDOFF = {
  status: 'HANDOFF',
  summary: 'schemas done, stop flow half built',
  evidence: [{ kind: 'command', ref: 'bun test', result: 'pass' }],
  handoff: {
    done: ['schemas and migration'],
    in_progress: ['stop flow in run-lifecycle.ts'],
    next: ['dispatch the follow-up attempt'],
    questions: [],
    verify: ['bun test packages/supervisor'],
  },
}

async function running(h: ReturnType<typeof harness>) {
  const run = await dispatchOne(h)
  h.sandbox.add(run.id)
  await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
  h.executor.heads.set(run.id, 'head1')
  return run
}

describe('graceful stop with a handoff', () => {
  test('a worker that hands off within the grace period ends interrupted with its commit kept', async () => {
    const h = harness()
    h.config.limits.handoff_grace_seconds = 30
    const run = await running(h)
    const stopping = h.sup.handOff('deploy restart')
    await Bun.sleep(0)
    expect(h.executor.calls.find((c) => c.op === 'nudge')?.detail).toContain('HANDOFF')
    await h.sup.workerFinished(run.id, HANDOFF)
    await stopping
    await h.sup.stop('signal')
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'interrupted', headSha: 'head1', failure: null })
    expect(h.of('HANDOFF_WRITTEN').map((e) => e.run)).toEqual([run.id])
    expect(h.of('RUN_INTERRUPTED').map((e) => e.data)).toEqual([{ reason: 'deploy restart', handoff: true }])
    expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
    expect(h.executor.ops('stop')).toEqual([])
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(h.sup.leases.get('FOR-1')).toBeUndefined()
    expect(h.linear.get('FOR-1').status).toBe('Todo')
  })

  test('a worker that ignores the signal is killed after the grace period, its work kept as WIP', async () => {
    const h = harness()
    h.config.limits.handoff_grace_seconds = 0
    const run = await running(h)
    await h.sup.handOff('supervisor stopping')
    await h.sup.stop('signal')
    expect(h.executor.calls.filter((c) => c.op === 'stop')).toEqual([
      { op: 'stop', run: run.id, detail: 'interrupted: supervisor stopping' },
    ])
    expect(h.executor.ops('captureHead')).toEqual([run.id])
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'interrupted', headSha: 'head1', failure: null })
    expect(h.of('RUN_INTERRUPTED').map((e) => e.data)).toEqual([
      { reason: 'supervisor stopping', handoff: false },
    ])
    expect(h.of('WORKER_FAILED')).toEqual([])
    expect(h.sup.escalationCount('FOR-1')).toBe(0)
  })

  test('a worker failure during the grace period still ends the run interrupted', async () => {
    const h = harness()
    h.config.limits.handoff_grace_seconds = 30
    const run = await running(h)
    const stopping = h.sup.handOff('deploy restart')
    await Bun.sleep(0)
    await h.sup.workerFailed(run.id, 'crash', 'killed')
    await stopping
    expect(h.sup.runs.get(run.id)?.state).toBe('interrupted')
    expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
  })

  test('a HANDOFF at a run limit ends the run interrupted and requeues the issue', async () => {
    const h = harness()
    const run = await running(h)
    await h.sup.workerFinished(run.id, HANDOFF)
    expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'interrupted', headSha: 'head1' })
    expect(h.of('RUN_INTERRUPTED').map((e) => e.data)).toEqual([
      { reason: 'worker handed off', handoff: true },
    ])
    expect(h.linear.get('FOR-1').status).toBe('Todo')
  })

  test('the next attempt continues from the handoff commit with the same agent and the note first in HISTORY', async () => {
    const h = harness()
    h.config.limits.handoff_grace_seconds = 30
    const run = await running(h)
    const stopping = h.sup.handOff('deploy restart')
    await Bun.sleep(0)
    await h.sup.workerFinished(run.id, HANDOFF)
    await stopping
    await h.sup.stop('signal')

    const next = h.make()
    await next.start()
    await next.tick()
    const second = next.runs.forIssue('FOR-1').at(-1)
    expect(second).toMatchObject({ attempt: 2, agent: run.agent })
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: run.id, headSha: 'head1' })
    expect(next.continuedFrom(second as NonNullable<typeof second>)).toBe('head1')

    const attempts = attemptsOf(h.db, 'FOR-1', second?.id ?? '')
    expect(attempts).toMatchObject([{ attempt: 1, failureClass: 'interrupted', handoff: HANDOFF.handoff }])
    const items = historyItems({
      issue: {} as never,
      repository: {} as never,
      blockers: [],
      attempts,
      vaultPages: [],
      answers: [{ question: 'q', answer: 'a' }],
    })
    expect(items[0]?.source).toBe('handoff 1')
    expect(items[0]?.text).toContain('## Handoff from attempt 1')
    expect(items[0]?.text).toContain('- stop flow in run-lifecycle.ts')
    expect(items[0]?.text).toContain('- bun test packages/supervisor')
  })

  test('interrupted runs do not count toward repair rounds or escalation', async () => {
    const h = harness()
    h.config.limits.handoff_grace_seconds = 0
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    for (let i = 0; i < 5; i++) {
      await h.sup.tick()
      const run = h.sup.runs.active()[0]
      if (!run) throw new Error('no run')
      await h.sup.workerStarted(run.id, { sandbox: 'sb', session: 's' })
      await h.sup.interruptRun(run.id, 'deploy restart')
    }
    expect(h.sup.runs.forIssue('FOR-1').map((r) => r.state)).toEqual(Array(5).fill('interrupted'))
    expect(h.sup.escalationCount('FOR-1')).toBe(0)
    expect(h.sup.awaiting('FOR-1')).toBeNull()
    expect(h.linear.get('FOR-1').status).toBe('Todo')
  })

  test('ns stop hands off by default and holds the issue; --now kills as before', async () => {
    const h = harness()
    h.config.limits.handoff_grace_seconds = 30
    const run = await running(h)
    const stopping = h.sup.stopForUser('FOR-1', undefined, 'cli')
    await Bun.sleep(0)
    await h.sup.workerFinished(run.id, HANDOFF)
    expect((await stopping).state).toBe('interrupted')
    expect(h.of('RUN_INTERRUPTED').map((e) => e.data)).toEqual([
      { reason: 'stopped by you', handoff: true, by: 'cli' },
    ])
    expect(h.sup.awaiting('FOR-1')?.kind).toBe('escalated')

    const k = harness()
    const other = await running(k)
    expect((await k.sup.stopForUser('FOR-1', undefined, 'cli', { now: true })).state).toBe('stopped')
    expect(k.executor.calls.filter((c) => c.op === 'nudge')).toEqual([])
    expect(k.sup.runs.get(other.id)?.headSha).toBe('head1')
  })
})

describe('run limits', () => {
  test.each(['step_cap', 'time_cap', 'token_cap'])(
    'a worker that ignores the limit handoff (%s) ends interrupted, not failed',
    async (cap) => {
      const h = harness()
      const run = await running(h)
      await h.sup.workerFailed(run.id, cap)
      expect(h.sup.runs.get(run.id)).toMatchObject({ state: 'interrupted', headSha: 'head1', failure: null })
      expect(h.of('RUN_INTERRUPTED').map((e) => e.data)).toEqual([
        { reason: `run limit: ${cap}`, handoff: false },
      ])
      expect(h.of('WORKER_NO_FINISH')).toEqual([])
      expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
      expect(h.sup.escalationCount('FOR-1')).toBe(0)
      expect(h.linear.get('FOR-1').status).toBe('Todo')
    },
  )

  test('a worker that finishes without a limit keeps the failure path', async () => {
    const h = harness()
    const run = await running(h)
    await h.sup.workerFailed(run.id, 'no_finish')
    expect(h.sup.runs.get(run.id)?.state).toBe('failed')
    expect(h.of('RUN_INTERRUPTED')).toEqual([])
  })
})
