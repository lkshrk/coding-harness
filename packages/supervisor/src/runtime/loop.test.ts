import { describe, expect, test } from 'bun:test'
import type { AgentDef, LoadResult } from '@nightshift/core'
import { testConfig } from '../testing/testing'
import { agentResolver, runSupervisor } from './loop'

function fakeSupervisor() {
  const calls: string[] = []
  const appended: unknown[] = []
  let release: () => void = () => {}
  let slow = false
  return {
    calls,
    appended,
    slowNextTick: () => {
      slow = true
    },
    finishTick: () => release(),
    sup: {
      start: async () => {
        calls.push('start')
        return {} as never
      },
      tick: async () => {
        calls.push('tick')
        if (slow) {
          slow = false
          await new Promise<void>((r) => {
            release = r
          })
        }
        return { dispatched: [], unblocked: [], stopped: [], waiting: [] }
      },
      reloadConfig: async (r: LoadResult) => {
        calls.push(`reload:${r.ok}`)
      },
      idle: async () => {},
      handOff: async (reason?: string) => {
        calls.push(`handOff:${reason}`)
      },
      stop: async (reason?: string) => {
        calls.push(`stop:${reason}`)
      },
      log: {
        append: (e: unknown) => {
          appended.push(e)
          return {} as never
        },
      },
    },
  }
}

describe('runSupervisor', () => {
  test('starts, ticks on the interval without overlap, reloads config, and stops cleanly', async () => {
    const f = fakeSupervisor()
    let fire: () => void = () => {}
    let onConfig: (r: LoadResult) => void = () => {}
    const stop = await runSupervisor(f.sup, {
      intervalMs: 30_000,
      setInterval: (fn) => {
        fire = fn
        return () => f.calls.push('cleared')
      },
      watch: (cb) => {
        onConfig = cb
        return () => f.calls.push('unwatched')
      },
    })
    expect(f.calls).toEqual(['start', 'tick'])
    f.slowNextTick()
    fire()
    fire()
    expect(f.calls.filter((c) => c === 'tick').length).toBe(2)
    f.finishTick()
    await Bun.sleep(0)
    fire()
    await Bun.sleep(0)
    expect(f.calls.filter((c) => c === 'tick').length).toBe(3)
    onConfig({ ok: false, errors: [] })
    await Bun.sleep(0)
    await stop('signal')
    expect(f.calls.slice(-5)).toEqual([
      'reload:false',
      'cleared',
      'unwatched',
      'handOff:signal',
      'stop:signal',
    ])
  })
})

describe('runSupervisor stalled tick', () => {
  test('a tick past the stall limit is reported once and the next tick runs after it settles', async () => {
    const f = fakeSupervisor()
    const errors: string[] = []
    const original = console.error
    console.error = (msg: string) => errors.push(msg)
    let fire: () => void = () => {}
    let clock = 0
    try {
      const stop = await runSupervisor(f.sup, {
        intervalMs: 30_000,
        stallMs: 300_000,
        now: () => clock,
        setInterval: (fn) => {
          fire = fn
          return () => {}
        },
        watch: () => () => {},
      })
      f.slowNextTick()
      fire()
      clock = 200_000
      fire()
      clock = 301_000
      fire()
      clock = 400_000
      fire()
      expect(f.calls.filter((c) => c === 'tick').length).toBe(2)
      expect(f.appended).toEqual([{ type: 'TICK_STALLED', data: { elapsed_s: 301 } }])
      expect(errors).toEqual(['supervisor tick: still running after 301 s'])
      f.finishTick()
      await Bun.sleep(0)
      fire()
      await Bun.sleep(0)
      expect(f.calls.filter((c) => c === 'tick').length).toBe(3)
      expect(f.appended).toHaveLength(1)
      await stop('signal')
    } finally {
      console.error = original
    }
  })
})

describe('agentResolver', () => {
  const agent = (name: string, kind: AgentDef['kind'], role: string) => ({ name, kind, role }) as AgentDef

  test('resolves agent kind and the concrete model through the profile', () => {
    const agents = new Map([
      ['implementer', agent('implementer', 'worker', 'worker')],
      ['reviewer', agent('reviewer', 'single_call', 'reviewer')],
    ])
    const r = agentResolver(agents)
    const config = testConfig()
    expect(r.agentKind('implementer')).toBe('worker')
    expect(r.agentKind('nope')).toBeUndefined()
    expect(r.modelFor('implementer', 'default', config)).toBe('qwen-coder')
    expect(r.modelFor('reviewer', 'default', config)).toBe('glm')
    expect(() => r.modelFor('nope', 'default', config)).toThrow('no agent nope')
    expect(() => r.modelFor('implementer', 'fast', config)).toThrow("no profile 'fast'")
  })
})
