import { describe, expect, test } from 'bun:test'
import { snapshot } from '../testing/testing'
import { dispatchOne, harness } from './testing'

describe('own Linear writes', () => {
  test('a stale read after dispatch does not stop the fresh run', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    h.linear.freezeReads()
    await h.sup.tick()
    const run = h.sup.runs.forIssue('FOR-1').at(-1)
    if (!run) throw new Error('not dispatched')
    await h.sup.tick()
    await h.sup.tick()
    expect(h.sup.runs.get(run.id)?.state).not.toBe('stopped')
    expect(h.of('WORKER_FAILED')).toEqual([])
  })

  test('an external status change newer than our write still stops the run', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.advance(60_000)
    h.linear.patch('FOR-1', { status: 'Todo' })
    await h.sup.tick()
    expect(h.sup.runs.get(run.id)?.state).toBe('stopped')
  })
})

describe('mismatch on a running issue', () => {
  async function running() {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    let reads = 0
    const lastChange = h.linear.lastChange.bind(h.linear)
    h.linear.lastChange = (id) => {
      reads += 1
      return lastChange(id)
    }
    return { h, run, reads: () => reads }
  }

  test('a clean tick reads no history', async () => {
    const { h, run, reads } = await running()
    await h.sup.tick()
    await h.sup.tick()
    expect(reads()).toBe(0)
    expect(h.sup.runs.get(run.id)?.state).toBe('running')
    expect(h.of('MISMATCH_RESOLVED')).toEqual([])
  })

  test('a status change by the Nightshift app keeps the run and re-asserts In Progress', async () => {
    const { h, run, reads } = await running()
    h.linear.patch('FOR-1', { status: 'Todo' })
    h.linear.changes.set('FOR-1', { actor: 'nightshift', app: true, at: '2026-10-04T10:00:00.000Z' })
    await h.sup.tick()
    expect(reads()).toBe(1)
    expect(h.sup.runs.get(run.id)?.state).toBe('running')
    expect(h.linear.get('FOR-1').status).toBe('In Progress')
    expect(h.of('MISMATCH_RESOLVED').map((e) => e.data)).toEqual([
      {
        linear: { status: 'Todo', stage: 'implementation' },
        expected: { status: 'In Progress', stage: 'implementation' },
        actor: 'nightshift',
        app: true,
        action: 'reassert',
      },
    ])
    await h.sup.tick()
    expect(reads()).toBe(1)
  })

  test('an app-made mismatch keeps the run even when the issue no longer has a view', async () => {
    const { h, run } = await running()
    h.linear.patch('FOR-1', { status: 'Todo', delegated: false })
    h.linear.changes.set('FOR-1', { actor: 'nightshift', app: true, at: '2026-10-04T10:00:00.000Z' })
    const report = await h.sup.tick()
    expect(report.stopped).not.toContain('FOR-1')
    expect(h.sup.runs.get(run.id)?.state).toBe('running')
    expect(h.executor.ops('stop')).toEqual([])
    expect(h.of('MISMATCH_RESOLVED').map((e) => e.data)).toMatchObject([
      { actor: 'nightshift', app: true, action: 'reassert' },
    ])
  })

  // Requeued issues go through the normal queue in the same tick: Todo is dispatched again,
  // an unblocked Backlog issue moves to Todo.
  const cases: [string, string, string][] = [
    ['Todo', 'requeue', 'In Progress'],
    ['Backlog', 'requeue', 'Todo'],
    ['Blocked', 'hold', 'Blocked'],
    ['Done', 'finish', 'Done'],
    ['Canceled', 'drop', 'Canceled'],
    ['In Review', 'stop', 'In Review'],
    ['Triage', 'stop', 'Triage'],
  ]
  for (const [status, action, after] of cases) {
    test(`an operator move to ${status} applies ${action}`, async () => {
      const { h, run } = await running()
      h.linear.patch('FOR-1', { status })
      const report = await h.sup.tick()
      expect(h.sup.runs.get(run.id)?.state).toBe('stopped')
      expect(report.stopped).toContain('FOR-1')
      expect(h.executor.ops('stop')).toEqual([run.id])
      expect(h.linear.get('FOR-1').status).toBe(after)
      expect(h.of('MISMATCH_RESOLVED').map((e) => e.data)).toEqual([
        {
          linear: { status, stage: 'implementation' },
          expected: { status: 'In Progress', stage: 'implementation' },
          actor: 'You',
          app: false,
          action,
        },
      ])
    })
  }

  test('an operator move to Blocked holds the run even when the issue no longer has a view', async () => {
    const { h, run } = await running()
    h.linear.patch('FOR-1', { status: 'Blocked', delegated: false })
    const report = await h.sup.tick()
    expect(report.stopped).toContain('FOR-1')
    expect(h.sup.runs.get(run.id)?.state).toBe('stopped')
    expect(h.executor.ops('stop')).toEqual([run.id])
    expect(h.linear.get('FOR-1').status).toBe('Blocked')
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'implementation' })
    expect(h.of('MISMATCH_RESOLVED').map((e) => e.data)).toMatchObject([
      { linear: { status: 'Blocked' }, actor: 'You', app: false, action: 'hold' },
    ])
  })

  test('an operator hold leaves the issue awaiting you', async () => {
    const { h } = await running()
    h.linear.patch('FOR-1', { status: 'Blocked' })
    await h.sup.tick()
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'implementation' })
  })
})

describe('Linear wins', () => {
  test('an issue canceled in Linear stops its run, destroys the sandbox and releases the lease', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.linear.patch('FOR-1', { status: 'Canceled' })
    await h.sup.tick()
    expect(h.sup.runs.get(run.id)?.state).toBe('stopped')
    expect(h.executor.ops('stop')).toEqual([run.id])
    expect(h.sandbox.destroyed).toEqual([`sb-${run.id}`])
    expect(h.sup.leases.get('FOR-1')).toBeUndefined()
    expect(h.types()).toContain('SANDBOX_DESTROYED')
  })
  test('withdrawing the opt-in stops a running issue even though it no longer matches the query', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.linear.patch('FOR-1', { delegated: false })
    await h.sup.tick()
    expect(h.sup.runs.get(run.id)?.state).toBe('stopped')
    expect(h.executor.ops('stop')).toEqual([run.id])
  })

  test('an issue that is not opted in is never dispatched', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-30', delegated: false, labels: ['ai-stage:implementation'] }))
    await h.sup.start()
    await h.sup.tick()
    expect(h.executor.ops('start')).toEqual([])
  })
})
