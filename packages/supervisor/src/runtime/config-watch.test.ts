import { describe, expect, test } from 'bun:test'
import type { LoadResult } from '@nightshift/core'
import { testConfig } from '../testing/testing'
import { changedPaths, restartRequired, watchConfig } from './config-watch'

describe('changedPaths', () => {
  test('lists leaf paths that differ; lists compare as a whole', () => {
    const a = testConfig()
    const b = testConfig()
    b.limits.concurrency = 5
    b.pipelines.bug = ['implementation']
    b.notifications.ntfy = 'https://ntfy.test'
    expect(changedPaths(a, b)).toEqual(['limits.concurrency', 'notifications.ntfy', 'pipelines.bug'])
    expect(changedPaths(a, testConfig())).toEqual([])
  })

  test('added and removed keys count as changed', () => {
    const a = testConfig()
    const b = testConfig()
    delete (b.repositories as Record<string, unknown>).web
    expect(changedPaths(a, b)).toEqual(['repositories.web'])
  })

  test('paths.* and sandbox.driver require a restart', () => {
    expect(restartRequired(['limits.concurrency'])).toBe(false)
    expect(restartRequired(['paths.state'])).toBe(true)
    expect(restartRequired(['sandbox.driver'])).toBe(true)
    expect(restartRequired(['sandbox.resources.cpus'])).toBe(false)
  })
})

describe('watchConfig', () => {
  test('reloads after a debounced file change and stops on dispose', () => {
    const listeners: (() => void)[] = []
    const timers: (() => void)[] = []
    const results: LoadResult[] = []
    let loads = 0
    const stop = watchConfig((r) => results.push(r), {
      files: ['/cfg/config.yaml'],
      load: () => {
        loads += 1
        return { ok: true, config: testConfig(), sources: [] }
      },
      watch: (_file, onEvent) => {
        listeners.push(onEvent)
        return () => listeners.splice(0)
      },
      schedule: (fn) => {
        timers.push(fn)
        return () => timers.splice(timers.indexOf(fn), 1)
      },
    })
    listeners[0]?.()
    listeners[0]?.()
    expect(timers.length).toBe(1)
    timers.shift()?.()
    expect(loads).toBe(1)
    expect(results.length).toBe(1)
    stop()
    expect(listeners).toEqual([])
  })
})
