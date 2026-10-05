import { describe, expect, test } from 'bun:test'
import type { AgentDef, LoadResult } from '@nightshift/core'
import { agentResolver, runSupervisor } from './loop'
import { testConfig } from './testing'

function fakeSupervisor() {
  const calls: string[] = []
  let release: () => void = () => {}
  let slow = false
  return {
    calls,
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
      stop: (reason?: string) => {
        calls.push(`stop:${reason}`)
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
    expect(f.calls.slice(-4)).toEqual(['reload:false', 'cleared', 'unwatched', 'stop:signal'])
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
