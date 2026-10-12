import { type AgentDef, type Config, type LoadResult, profileEntries } from '@nightshift/core'
import type { AgentKind } from '../policy/stages'
import type { Supervisor } from '../supervisor/supervisor'
import { watchConfig } from './config-watch'

type Loopable = Pick<Supervisor, 'start' | 'tick' | 'reloadConfig' | 'stop' | 'idle' | 'handOff'> & {
  log: Pick<Supervisor['log'], 'append'>
}

export type LoopOptions = {
  intervalMs: number
  stepGraceMs?: number
  stallMs?: number
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => () => void
  watch?: (onChange: (r: LoadResult) => void) => () => void
}

const report = (what: string) => (e: unknown) => console.error(`supervisor ${what}: ${(e as Error).message}`)

const STEP_GRACE_MS = 30_000
const STALL_MS = 5 * 60_000

export async function runSupervisor(
  sup: Loopable,
  opts: LoopOptions,
): Promise<(reason?: string) => Promise<void>> {
  const every =
    opts.setInterval ??
    ((fn, ms) => {
      const id = setInterval(fn, ms)
      return () => clearInterval(id)
    })
  const watch = opts.watch ?? ((onChange) => watchConfig(onChange))
  await sup.start()
  const now = opts.now ?? Date.now
  const stallMs = opts.stallMs ?? STALL_MS
  let ticking: Promise<unknown> | undefined
  let started = 0
  let stallReported = false
  const tick = () => {
    if (ticking) {
      const elapsed = now() - started
      if (!stallReported && elapsed > stallMs) {
        stallReported = true
        const seconds = Math.round(elapsed / 1000)
        console.error(`supervisor tick: still running after ${seconds} s`)
        try {
          sup.log.append({ type: 'TICK_STALLED', data: { elapsed_s: seconds } })
        } catch (e) {
          report('stall report')(e)
        }
      }
      return
    }
    started = now()
    stallReported = false
    ticking = sup
      .tick()
      .catch(report('tick'))
      .finally(() => {
        ticking = undefined
      })
  }
  tick()
  await ticking
  const clear = every(tick, opts.intervalMs)
  const unwatch = watch((r) => {
    sup.reloadConfig(r).catch(report('config reload'))
  })
  return async (reason = 'stopped') => {
    clear()
    unwatch()
    await ticking
    await sup.handOff(reason)
    await Promise.race([sup.idle(), new Promise((r) => setTimeout(r, opts.stepGraceMs ?? STEP_GRACE_MS))])
    await sup.stop(reason)
  }
}

export function agentResolver(agents: ReadonlyMap<string, Pick<AgentDef, 'kind' | 'role'>>): {
  agentKind: (agent: string) => AgentKind | undefined
  modelFor: (agent: string, profile: string, config: Config) => string
} {
  return {
    agentKind: (name) => agents.get(name)?.kind,
    modelFor: (name, profileName, config) => {
      const def = agents.get(name)
      if (!def) throw new Error(`no agent ${name}`)
      const profile = profileEntries(config.profiles).find(([n]) => n === profileName)?.[1]
      if (!profile) throw new Error(`no profile '${profileName}'`)
      const alias = profile.roles[def.role]
      if (!alias) throw new Error(`profile ${profileName} has no role ${def.role} (agent ${name})`)
      return profile.models[alias]?.model ?? alias
    },
  }
}
