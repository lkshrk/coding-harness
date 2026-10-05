import { expect, test } from 'bun:test'
import { NIGHTSHIFT_VERSION } from '@nightshift/core'
import { supervisorVersion } from './index'

test('reports the shared version', () => {
  expect(supervisorVersion()).toBe(NIGHTSHIFT_VERSION)
})
