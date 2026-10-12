import { describe, expect, test } from 'bun:test'
import { snapshot } from '../testing/testing'
import { harness } from './testing'

function probed(results: (boolean | 'throw')[]) {
  const queue = [...results]
  const h = harness({
    gatewayProbe: async () => {
      const next = queue.shift() ?? true
      if (next === 'throw') throw new Error('connect refused')
      return { ok: next, reason: next ? 'ok' : 'http 502' }
    },
  })
  return h
}

describe('gateway probe', () => {
  test('one failed probe logs nothing and dispatch keeps running', async () => {
    const h = probed([false])
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
    expect(h.of('GATEWAY_UNAVAILABLE')).toEqual([])
    expect(h.of('DISPATCH_PAUSED')).toEqual([])
    expect(h.sup.gateway()).toBe('ok')
  })

  test('two consecutive failures mark the gateway unavailable and pause dispatch', async () => {
    const h = probed([false, 'throw', false])
    await h.sup.start()
    await h.sup.tick()
    await h.sup.tick()
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    expect((await h.sup.tick()).dispatched).toEqual([])
    expect(h.of('GATEWAY_UNAVAILABLE')).toHaveLength(1)
    expect(h.of('DISPATCH_PAUSED').map((e) => e.data)).toEqual([
      { reason: 'gateway unavailable', by: 'supervisor' },
    ])
    expect(h.sup.gateway()).toBe('unavailable')
    expect(h.sup.status().dispatch).toBe('paused')
  })

  test('the first success afterwards recovers the gateway and resumes dispatch', async () => {
    const h = probed([false, false, true])
    await h.sup.start()
    await h.sup.tick()
    await h.sup.tick()
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    expect((await h.sup.tick()).dispatched).toEqual(['FOR-1'])
    expect(h.of('GATEWAY_RECOVERED')).toHaveLength(1)
    expect(h.of('DISPATCH_RESUMED').map((e) => e.data)).toEqual([
      { reason: 'gateway recovered', by: 'supervisor' },
    ])
    expect(h.sup.gateway()).toBe('ok')
  })

  test('recovery does not lift a pause set for another reason', async () => {
    const h = probed([false, false, true])
    await h.sup.start()
    h.sup.pause('ns pause')
    await h.sup.tick()
    await h.sup.tick()
    await h.sup.tick()
    expect(h.of('GATEWAY_UNAVAILABLE')).toHaveLength(1)
    expect(h.of('GATEWAY_RECOVERED')).toHaveLength(1)
    expect(h.of('DISPATCH_RESUMED')).toEqual([])
    expect(h.sup.status().dispatch).toBe('paused')
  })

  test('a failure, a success, then a failure does not pause', async () => {
    const h = probed([false, true, false])
    await h.sup.start()
    for (let i = 0; i < 3; i++) await h.sup.tick()
    expect(h.of('GATEWAY_UNAVAILABLE')).toEqual([])
    expect(h.of('DISPATCH_PAUSED')).toEqual([])
  })

  test('running workers are not stopped by the pause', async () => {
    const h = probed([true, false, false])
    h.linear.put(snapshot({ identifier: 'FOR-1' }))
    await h.sup.start()
    await h.sup.tick()
    await h.sup.tick()
    await h.sup.tick()
    expect(h.sup.gateway()).toBe('unavailable')
    expect(h.sup.runs.active().map((r) => r.issue)).toEqual(['FOR-1'])
    expect(h.executor.ops('stop')).toEqual([])
  })
})
