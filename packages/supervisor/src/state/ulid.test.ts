import { describe, expect, test } from 'bun:test'
import { createUlid, ulidTime } from './ulid'

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('createUlid', () => {
  test('encodes the clock time in the first 10 characters', () => {
    const next = createUlid(() => 1_700_000_000_000)
    const id = next()
    expect(id).toMatch(ULID)
    expect(ulidTime(id)).toBe(1_700_000_000_000)
  })

  test('is strictly increasing within the same millisecond', () => {
    const next = createUlid(() => 5)
    const ids = Array.from({ length: 100 }, next)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(100)
  })

  test('stays increasing when the clock goes backwards', () => {
    let t = 1000
    const next = createUlid(() => t)
    const a = next()
    t = 900
    expect(next() > a).toBe(true)
  })
})
