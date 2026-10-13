import { type Profile, profileEntries } from '@nightshift/core'
import { openStateReadOnly, type ProfileResponse, readStatus } from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, parseArgs, printJson, requireArg } from '../cli'
import { call, table } from './shared'

export const PROFILE_USAGE = 'ns profile list | show [<name>] | use <name>'

const PHASES = ['planning', 'implementation'] as const

function activeName(ctx: Ctx): string {
  const db = openStateReadOnly(ctx.statePath())
  if (db) {
    try {
      const active = readStatus(db).activeProfile
      if (active) return active
    } finally {
      db.close()
    }
  }
  return ctx.config().profiles.active
}

function roleRows(profile: Profile): { role: string; alias: string; model: string; family: string }[] {
  return Object.entries(profile.roles).map(([role, alias]) => {
    const m = profile.models[alias]
    return { role, alias, model: m?.model ?? '?', family: m?.family ?? '?' }
  })
}

// Same sum as the config memory rule: each distinct model counted once per phase.
function residentGb(profile: Profile, phase: string): number {
  const sizes = new Map<string, number>()
  for (const m of Object.values(profile.models))
    if (m.phases.some((p) => p === phase)) sizes.set(m.model, m.size_gb)
  return [...sizes.values()].reduce((a, b) => a + b, 0)
}

function list(ctx: Ctx): number {
  const active = activeName(ctx)
  const entries = profileEntries(ctx.config().profiles)
  if (ctx.flags.json) {
    printJson(
      ctx,
      entries.map(([name, p]) => ({ name, active: name === active, roles: p.roles })),
    )
    return EXIT.ok
  }
  const rows = entries.map(([name, p]) => {
    const families = [...new Set(Object.values(p.models).map((m) => m.family))]
    return [
      `${name === active ? '*' : ' '} ${name}`,
      Object.entries(p.roles)
        .map(([role, alias]) => `${role}=${alias}`)
        .join(','),
      families.join(','),
    ]
  })
  for (const line of table(rows)) ctx.io.out(line)
  return EXIT.ok
}

function show(ctx: Ctx, name: string | undefined): number {
  const active = activeName(ctx)
  const profiles = ctx.config().profiles
  const target = name ?? active
  const profile = profileEntries(profiles).find(([n]) => n === target)?.[1]
  if (!profile) throw new CliError(EXIT.notFound, `no profile '${target}'`)
  const roles = roleRows(profile)
  const memory = {
    planning: residentGb(profile, 'planning'),
    implementation: residentGb(profile, 'implementation'),
    budget: profiles.memory_budget_gb,
  }
  if (ctx.flags.json) {
    printJson(ctx, { name: target, active: target === active, roles, memory })
    return EXIT.ok
  }
  ctx.io.out(`profile: ${target}${target === active ? ' (active)' : ''}`)
  for (const line of table(roles.map((r) => [r.role, r.alias, r.model, r.family]))) ctx.io.out(line)
  ctx.io.out(`memory: ${PHASES.map((p) => `${p} ${memory[p]} GB`).join(', ')} (budget ${memory.budget} GB)`)
  return EXIT.ok
}

async function use(ctx: Ctx, name: string): Promise<number> {
  const res = await call<ProfileResponse>(ctx, 'POST', '/profile', { use: name })
  if (ctx.flags.json) printJson(ctx, res)
  else ctx.io.out(`active profile: ${res.active} (was ${res.previous}); applies to new dispatches`)
  return EXIT.ok
}

export async function profile(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals } = parseArgs(args, {}, PROFILE_USAGE)
  const [sub, name, ...rest] = positionals
  const usage = new CliError(EXIT.usage, `usage: ${PROFILE_USAGE}`)
  if (rest.length > 0) throw usage
  if (sub === 'list' && name === undefined) return list(ctx)
  if (sub === 'show') return show(ctx, name)
  if (sub === 'use') return use(ctx, requireArg(name, PROFILE_USAGE))
  throw usage
}
