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

describe('dependents', () => {
  const blocked = (identifier: string, ...by: string[]) =>
    snapshot({
      identifier,
      delegated: false,
      blockedBy: by.map((b) => ({ identifier: b, team: 'FOR', status: 'Todo' })),
    })

  test('lists the issue and every issue it blocks, transitively, within its project and without cycles', async () => {
    const h = harness()
    const web = { id: 'p-web', name: 'Web', initiatives: [], labels: [] }
    h.linear.put(
      blocked('FOR-1', 'FOR-3'),
      blocked('FOR-2', 'FOR-1'),
      blocked('FOR-3', 'FOR-2'),
      blocked('FOR-4', 'FOR-3'),
      blocked('FOR-5'),
      { ...blocked('FOR-6', 'FOR-1'), project: web },
      { ...blocked('FOR-7', 'FOR-2'), status: 'Done' },
      blocked('FOR-8', 'FOR-6'),
      { ...blocked('FOR-9', 'FOR-8'), team: 'CIV' },
    )
    expect(await h.sup.dependents('FOR-1')).toEqual({
      issues: ['FOR-1', 'FOR-2', 'FOR-3', 'FOR-8', 'FOR-4'],
      other: [
        { issue: 'FOR-6', reason: 'other project' },
        { issue: 'FOR-9', reason: 'other team' },
      ],
    })
    expect(await h.sup.dependents('FOR-5')).toEqual({ issues: ['FOR-5'], other: [] })
    await expect(h.sup.dependents('FOR-99')).rejects.toThrow('unknown issue FOR-99')
  })

  test('a covered dependent starts once its blocker is done', async () => {
    const h = harness()
    const sup = h.make({
      config: { ...h.config, linear: { ...h.config.linear, act_on: { delegated: false, labels: [] } } },
    })
    h.linear.put({ ...blocked('FOR-1'), status: 'In Review' }, blocked('FOR-2', 'FOR-1'))
    await sup.start()
    for (const issue of (await sup.dependents('FOR-1')).issues) sup.cover(issue)
    expect(sup.covered()).toEqual(['FOR-1', 'FOR-2'])
    expect((await sup.tick()).dispatched).toEqual([])
    h.linear.patch('FOR-1', { status: 'Done' })
    await sup.tick()
    expect(h.executor.ops('start').length).toBe(1)
    expect(sup.runs.active().map((r) => r.issue)).toEqual(['FOR-2'])
  })
})

describe('escalated holds', () => {
  test('releasing an escalated issue clears its hold', async () => {
    const h = harness()
    h.linear.put(snapshot({ identifier: 'FOR-1', status: 'Blocked', labels: ['ai-stage:implementation'] }))
    await h.sup.start()
    h.sup.cover('FOR-1')
    await h.sup.holdStage('FOR-1', 'implementation', 'architectural_conflict', 'conflict')
    expect(h.sup.awaiting('FOR-1')).toMatchObject({ kind: 'escalated' })
    h.sup.uncover('FOR-1', 'cli')
    expect(h.sup.awaiting('FOR-1')).toBeNull()
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
