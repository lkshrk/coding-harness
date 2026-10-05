import { isTerminal, runStore } from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, parseArgs } from '../cli'
import { LOCAL } from '../remote'
import { shellLine, Tmux } from '../tmux'
import { withDb } from './shared'

export const WATCH_USAGE = 'ns watch [<issue>…] [--all] [--max-panes N]'
const POLL_MS = 2_000
const MAX_PANES = 6

function ns(ctx: Ctx, ...args: string[]): string[] {
  return [...ctx.self, '--host', LOCAL, ...(ctx.flags.config ? ['--config', ctx.flags.config] : []), ...args]
}

export function syncPanes(ctx: Ctx, tmux: Tmux, o: { issues: string[]; maxPanes: number }): string[] {
  const panes = tmux.panes()
  const runs = withDb(ctx, (db) => {
    const store = runStore(db)
    const states = new Map(panes.filter((p) => p.run).map((p) => [p.run, store.get(p.run)?.state]))
    return { active: store.active(), states }
  })
  const known = new Set(panes.map((p) => p.run))
  const added: string[] = []
  for (const run of runs.active) {
    if (o.issues.length && !o.issues.includes(run.issue)) continue
    if (known.has(run.id)) continue
    tmux.addPane({ run: run.id, issue: run.issue, command: ns(ctx, 'tail', run.issue), maxPanes: o.maxPanes })
    added.push(run.issue)
  }
  for (const pane of panes) {
    if (!pane.run || pane.title.endsWith(']')) continue
    const state = runs.states.get(pane.run)
    if (state && !isTerminal(state)) continue
    tmux.title(pane.id, `${pane.issue} [${state === 'done' ? 'done' : 'failed'}]`)
  }
  return added
}

async function manage(ctx: Ctx, tmux: Tmux, issues: string[], maxPanes: number): Promise<number> {
  let first = true
  ctx.io.out(`watching ${issues.length ? issues.join(', ') : 'all workers'}; prefix+a in a pane attaches`)
  while (!ctx.signal?.aborted) {
    try {
      const added = syncPanes(ctx, tmux, { issues, maxPanes })
      if (first && added.length) {
        tmux.selectWorkers()
        first = false
      }
    } catch (e) {
      ctx.io.err((e as Error).message)
    }
    await ctx.sleep(POLL_MS)
  }
  return EXIT.ok
}

export async function watch(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals, bools, values } = parseArgs(
    args,
    { bools: ['--all', '--manage'], values: ['--max-panes', '--swap'] },
    WATCH_USAGE,
  )
  if (ctx.which('tmux') === null) {
    throw new CliError(EXIT.error, 'tmux is not installed; install it (brew install tmux, apt install tmux)')
  }
  const tmux = new Tmux((argv) => ctx.capture(argv))
  const maxPanes = Number(values['--max-panes'] ?? MAX_PANES)
  if (!Number.isInteger(maxPanes) || maxPanes < 1) throw new CliError(EXIT.usage, `usage: ${WATCH_USAGE}`)
  const swap = values['--swap']
  if (swap !== undefined) {
    const issue = tmux.issueOf(swap)
    if (!issue) throw new CliError(EXIT.notFound, `pane ${swap} shows no worker`)
    tmux.respawn(swap, [
      'sh',
      '-c',
      `${shellLine(ns(ctx, 'attach', issue))}; exec ${shellLine(ns(ctx, 'tail', issue))}`,
    ])
    return EXIT.ok
  }
  if (bools.has('--all') && positionals.length) throw new CliError(EXIT.usage, `usage: ${WATCH_USAGE}`)
  if (bools.has('--manage')) return manage(ctx, tmux, positionals, maxPanes)
  if (!tmux.hasSession()) {
    tmux.createSession(
      ns(ctx, 'watch', '--manage', '--max-panes', String(maxPanes), ...positionals),
      ns(ctx, 'watch', '--swap'),
    )
  }
  return ctx.exec(tmux.attachCommand(), { env: { TMUX: undefined } })
}
