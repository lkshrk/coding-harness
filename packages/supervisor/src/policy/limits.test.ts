import { describe, expect, test } from 'bun:test'
import type { Config, Profile } from '@nightshift/core'
import { testConfig } from '../testing/testing'
import { effectiveLimits } from './limits'

function withLimits(limits: Profile['limits']): Config {
  const config = testConfig()
  const base = config.profiles.default as Profile
  return {
    ...config,
    profiles: { ...config.profiles, local: { ...base, ...(limits ? { limits } : {}) } },
  }
}

describe('effectiveLimits', () => {
  test('overlays the profile limits on limits.worker', () => {
    const config = withLimits({
      wall_clock: '20m',
      tokens: '500k',
      steps: 80,
      no_diff_steps: 10,
      no_diff_tokens: '60k',
      max_estimate: 2,
      max_files: 4,
    })
    expect(effectiveLimits(config, 'local')).toEqual({
      wall_clock: '20m',
      tokens: '500k',
      steps: 80,
      no_diff_steps: 10,
      no_diff_tokens: '60k',
      max_estimate: 2,
      max_files: 4,
    })
  })

  test('a profile without limits uses limits.worker unchanged', () => {
    const config = withLimits(undefined)
    expect(effectiveLimits(config, 'local')).toEqual(config.limits.worker)
    expect(effectiveLimits(config, 'default')).toEqual(config.limits.worker)
  })

  test('a partial overlay keeps the global values it does not set', () => {
    const config = withLimits({ steps: 60, max_files: 3 })
    expect(effectiveLimits(config, 'local')).toEqual({ ...config.limits.worker, steps: 60, max_files: 3 })
  })

  test('defaults to the active profile', () => {
    const config = withLimits({ tokens: '300k' })
    const active = { ...config, profiles: { ...config.profiles, active: 'local' } }
    expect(effectiveLimits(active).tokens).toBe('300k')
  })
})
