import { describe, expect, test } from 'bun:test'
import { RetryQueue } from './retry'

describe('RetryQueue', () => {
  test('backs off exponentially per issue up to the cap', () => {
    const q = new RetryQueue({ baseMs: 1000, maxMs: 5000 })
    const t0 = 0
    expect(q.schedule('FOR-1', 'environment', t0).dueAt).toBe(1000)
    expect(q.schedule('FOR-1', 'environment', t0).dueAt).toBe(2000)
    expect(q.schedule('FOR-1', 'environment', t0).dueAt).toBe(4000)
    expect(q.schedule('FOR-1', 'environment', t0).dueAt).toBe(5000)
    expect(q.schedule('FOR-2', 'environment', t0).dueAt).toBe(1000)
  })

  test('due returns entries whose time has come, in due order; take removes them', () => {
    const q = new RetryQueue({ baseMs: 1000, maxMs: 60_000 })
    q.schedule('FOR-1', 'environment', 500)
    q.schedule('FOR-2', 'environment', 0)
    expect(q.due(999)).toEqual([])
    expect(q.due(1500).map((e) => e.issue)).toEqual(['FOR-2', 'FOR-1'])
    q.take('FOR-2')
    expect(q.due(1500).map((e) => e.issue)).toEqual(['FOR-1'])
    expect(q.has('FOR-2')).toBe(false)
  })

  test('reset forgets the backoff of an issue', () => {
    const q = new RetryQueue({ baseMs: 1000, maxMs: 60_000 })
    q.schedule('FOR-1', 'environment', 0)
    q.schedule('FOR-1', 'environment', 0)
    q.reset('FOR-1')
    expect(q.schedule('FOR-1', 'environment', 0).dueAt).toBe(1000)
  })
})
