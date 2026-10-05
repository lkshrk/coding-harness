import { describe, expect, test } from 'bun:test'
import { snapshot } from '../testing/testing'
import { harness } from './testing'

describe('explicit coverage', () => {
  const manual = (h: ReturnType<typeof harness>) =>
    h.make({
      config: { ...h.config, linear: { ...h.config.linear, act_on: { delegated: false, labels: [] } } },
    })

  for (const status of ['Done', 'Canceled']) {
    test(`sync removes coverage when an issue is manually ${status}`, async () => {
      const h = harness()
      const sup = manual(h)
      h.linear.put(snapshot({ identifier: 'FOR-40', delegated: false }))
      await sup.start()
      sup.cover('FOR-40')
      h.linear.patch('FOR-40', { status })
      await sup.tick()
      await sup.tick()
      expect(sup.covered()).toEqual([])
      expect(h.of('COVERAGE_CHANGED', sup).map((e) => e.data)).toEqual([
        { covered: true, by: 'supervisor' },
        { covered: false, by: 'supervisor' },
      ])
    })

    test(`restart drops ${status} coverage and retains nonterminal issues`, async () => {
      const h = harness()
      h.linear.put(
        snapshot({ identifier: 'FOR-40', status, delegated: false }),
        snapshot({ identifier: 'FOR-41', status: 'In Review', delegated: false }),
      )
      h.sup.cover('FOR-40')
      h.sup.cover('FOR-41')
      const restarted = manual(h)
      await restarted.start()
      expect(restarted.covered()).toEqual(['FOR-41'])
    })
  }

  test('in manual mode only issues you cover are dispatched, and coverage survives a restart', async () => {
    const h = harness()
    const sup = manual(h)
    h.linear.put(snapshot({ identifier: 'FOR-40', delegated: false }))
    h.linear.put(snapshot({ identifier: 'FOR-41', delegated: false }))
    await sup.start()
    await sup.tick()
    expect(h.executor.ops('start')).toEqual([])
    sup.cover('FOR-40')
    await sup.tick()
    expect(h.executor.ops('start').length).toBe(1)
    expect(manual(h).covered()).toEqual(['FOR-40'])
  })

  test('uncovering a running issue stops it', async () => {
    const h = harness()
    const sup = manual(h)
    h.linear.put(snapshot({ identifier: 'FOR-42', delegated: false }))
    await sup.start()
    sup.cover('FOR-42')
    await sup.tick()
    const run = sup.runs.active()[0]
    if (!run) throw new Error('not dispatched')
    h.sandbox.add(run.id)
    await sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    sup.uncover('FOR-42')
    await sup.tick()
    expect(sup.runs.get(run.id)?.state).toBe('stopped')
  })
})

describe('holds', () => {
  test('a held issue is skipped', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    h.sup.hold('FOR-1')
    expect((await h.sup.tick()).dispatched).toEqual([])
    h.sup.unhold('FOR-1')
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
  })
})
