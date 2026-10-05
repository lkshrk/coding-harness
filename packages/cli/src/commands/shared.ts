import { type Db, openStateReadOnly, type Run, resolveRun, runStore } from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT } from '../cli'
import { ControlFailure } from '../client'

export function withDb<T>(ctx: Ctx, fn: (db: Db) => T): T {
  const path = ctx.statePath()
  const db = openStateReadOnly(path)
  if (!db) throw new CliError(EXIT.error, `no state database at ${path}; has the supervisor run yet?`)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

export async function call<T>(ctx: Ctx, method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  try {
    return await ctx.control<T>(ctx.socketPath(), method, route, body)
  } catch (e) {
    if (e instanceof ControlFailure) throw new CliError(e.exit, e.message)
    throw e
  }
}

export async function health<T>(ctx: Ctx): Promise<T | null> {
  let path: string
  try {
    path = ctx.socketPath()
  } catch (e) {
    if (e instanceof CliError) return null
    throw e
  }
  try {
    return await ctx.control<T>(path, 'GET', '/health')
  } catch (e) {
    if (e instanceof ControlFailure && e.exit === EXIT.down) return null
    throw e
  }
}

export function targetRun(db: Db, target: string): Run {
  const run = resolveRun(runStore(db), target)
  if (!run) throw new CliError(EXIT.notFound, `no run for ${target}`)
  return run
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function table(rows: string[][]): string[] {
  const widths = rows.reduce<number[]>((w, row) => row.map((cell, i) => Math.max(w[i] ?? 0, cell.length)), [])
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}
