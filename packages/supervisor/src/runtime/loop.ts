import { type AgentDef, type Config, type LoadResult, profileEntries } from '@nightshift/core'
import type { AgentKind } from '../policy/stages'
import type { Supervisor } from '../supervisor/supervisor'
import { watchConfig } from './config-watch'

type Loopable = Pick<Supervisor, 'start' | 'tick' | 'reloadConfig' | 'stop' | 'idle'>

export type LoopOptions = {
  intervalMs: number
  stepGraceMs?: number
  setInterval?: (fn: () => void, ms: number) => () => void
  watch?: (onChange: (r: LoadResult) => void) => () => void
}

const report = (what: string) => (e: unknown) => console.error(`supervisor ${what}: ${(e as Error).message}`)

const STEP_GRACE_MS = 30_000

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
  let ticking: Promise<unknown> | undefined
  const tick = () => {
    if (ticking) return
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
