import { expect, test } from 'bun:test'
import { NIGHTSHIFT_VERSION } from './index'

test('exposes a semver version', () => {
  expect(NIGHTSHIFT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
})
