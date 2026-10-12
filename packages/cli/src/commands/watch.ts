import { isTerminal, runStore } from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, parseArgs } from '../cli'
import { LOCAL } from '../remote'
import { shellLine, Tmux } from '../tmux'
import { withDb } from './shared'

export const WATCH_USAGE = 'ns watch [<issue>…] [--all] [--max-panes N]'
const POLL_MS = 2_000
const MAX_PANES = 6
// One poll of lead plus one of slack keeps every close within 60 s of the run's end.
const CLOSE_AFTER_MS = 60_000 - 2 * POLL_MS

function ns(ctx: Ctx, ...args: string[]): string[] {
  return [...ctx.self, '--host', LOCAL, ...(ctx.flags.config ? ['--config', ctx.flags.config] : []), ...args]
}

// ctrl+c in a watch pane must not end its process and leave a dead pane; an ignored SIGINT survives exec.
function stream(ctx: Ctx, issue: string): string {
  return `trap '' INT; exec ${shellLine(ns(ctx, 'tail', '--no-footer', issue))}`
}

function closeEnded(ctx: Ctx, tmux: Tmux, o: { fresh?: boolean }) {
  const panes = tmux.panes()
  const workers = panes.filter((p) => p.run)
  const runs = withDb(ctx, (db) => {
    const store = runStore(db)
    return { active: store.active(), states: new Map(workers.map((p) => [p.run, store.get(p.run)])) }
  })
  const now = ctx.now().getTime()
  const open = panes.filter((pane) => {
    if (!pane.run) return true
    const run = runs.states.get(pane.run)
    if (run && !isTerminal(run.state)) return true
    const ended = run?.endedAt ? Date.parse(run.endedAt) : Number.NaN
    if (o.fresh || !(now - ended < CLOSE_AFTER_MS)) {
      tmux.close(pane)
      return false
    }
    if (!pane.title.endsWith(']'))
      tmux.title(pane.id, `${pane.issue} [${run?.state === 'done' ? 'done' : 'failed'}]`)
    return true
  })
  return { panes: open, active: runs.active }
}

export function syncPanes(
  ctx: Ctx,
  tmux: Tmux,
  o: { issues: string[]; maxPanes: number; fresh?: boolean },
): string[] {
  const { panes, active } = closeEnded(ctx, tmux, o)
  const known = new Set(panes.map((p) => p.run))
  const added: string[] = []
  for (const run of active) {
    if (o.issues.length && !o.issues.includes(run.issue)) continue
    if (known.has(run.id)) continue
    tmux.addPane({
      run: run.id,
      issue: run.issue,
      command: stream(ctx, run.issue),
      maxPanes: o.maxPanes,
    })
    added.push(run.issue)
  }
  return added
}

async function manage(ctx: Ctx, tmux: Tmux, issues: string[], maxPanes: number): Promise<number> {
  let first = true
  let fresh = true
  ctx.io.out(
    `watching ${issues.length ? issues.join(', ') : 'all workers'}; prefix a in a pane attaches, prefix d leaves`,
  )
  while (!ctx.signal?.aborted) {
    try {
      const added = syncPanes(ctx, tmux, { issues, maxPanes, fresh })
      fresh = false
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
    const id = tmux.runOf(swap)
    const state = withDb(ctx, (db) => runStore(db).get(id)?.state)
    if (!state || isTerminal(state)) {
      tmux.message(swap, `${issue} is not running`)
      return EXIT.ok
    }
    tmux.respawn(swap, `trap : INT; ${shellLine(ns(ctx, 'attach', issue))}; ${stream(ctx, issue)}`)
    return EXIT.ok
  }
  if (bools.has('--all') && positionals.length) throw new CliError(EXIT.usage, `usage: ${WATCH_USAGE}`)
  if (bools.has('--manage')) return manage(ctx, tmux, positionals, maxPanes)
  if (tmux.hasSession()) closeEnded(ctx, tmux, { fresh: true })
  else {
    const manager = ns(ctx, 'watch', '--manage', '--max-panes', String(maxPanes), ...positionals)
    tmux.createSession(manager, ns(ctx, 'watch', '--swap'))
  }
  return ctx.exec(tmux.attachCommand(), { env: { TMUX: undefined } })
}
