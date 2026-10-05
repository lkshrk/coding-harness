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
