import { describe, expect, test } from 'bun:test'
import { dispatchOne, harness } from './testing'

describe('leases', () => {
  test('an expired lease emits LEASE_EXPIRED and recovers that issue', async () => {
    const h = harness()
    const run = await dispatchOne(h)
    h.sandbox.add(run.id)
    await h.sup.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    h.db.query("UPDATE leases SET holder = 'dead', expires_at = '2026-10-04T09:00:00.000Z'").run()
    await h.sup.tick()
    expect(h.of('LEASE_EXPIRED')[0]).toMatchObject({ issue: 'FOR-1', data: { holder: 'dead' } })
    expect(h.sup.runs.get(run.id)?.state).toBe('failed')
  })

  test('leases of active runs are renewed on every tick', async () => {
    const h = harness()
    await dispatchOne(h)
    h.advance(150_000)
    await h.sup.tick()
    expect(h.sup.leases.get('FOR-1')?.expiresAt).toBe('2026-10-04T10:05:30.000Z')
  })
})

describe('vault sync', () => {
  test('every tick syncs the vault, even with no work to dispatch', async () => {
    let syncs = 0
    const h = harness({
      syncVault: async () => {
        syncs += 1
      },
    })
    await h.sup.tick()
    await h.sup.tick()
    expect(syncs).toBe(2)
  })
})
