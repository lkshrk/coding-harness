import type { RunResponse } from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, parseArgs, printJson, requireArg } from '../cli'
import { call } from './shared'

const ISSUE = /^[A-Z][A-Z0-9]{1,6}-[1-9][0-9]*$/

export const CONTROL_USAGE = {
  pause: 'ns pause [<issue>]',
  resume: 'ns resume [<issue>]',
  implement: 'ns implement <issue>',
  release: 'ns release <issue>',
  send: 'ns send <target> <message>',
  answer: 'ns answer <issue> <text>',
  stop: 'ns stop <target> [--reason R] [--yes]',
  retry: 'ns retry <target> [--agent A] [--profile P] [--continue]',
}

function issueArg(value: string | undefined, usage: string): string {
  const issue = requireArg(value, usage)
  if (!ISSUE.test(issue)) throw new CliError(EXIT.usage, `not a Linear identifier: ${issue}\nusage: ${usage}`)
  return issue
}

function done(ctx: Ctx, value: unknown, line: string): number {
  if (ctx.flags.json) printJson(ctx, value)
  else ctx.io.out(line)
  return EXIT.ok
}

export async function pause(ctx: Ctx, args: string[], on: boolean): Promise<number> {
  const usage = CONTROL_USAGE[on ? 'pause' : 'resume']
  const { positionals } = parseArgs(args, {}, usage)
  if (positionals.length > 1) throw new CliError(EXIT.usage, `usage: ${usage}`)
  const issue = positionals[0] === undefined ? undefined : issueArg(positionals[0], usage)
  const res = await call(ctx, 'POST', on ? '/pause' : '/resume', issue ? { issue } : {})
  const what = issue ?? 'dispatch'
  return done(ctx, res, on ? `${what} paused` : `${what} resumed`)
}

export async function cover(ctx: Ctx, args: string[], on: boolean): Promise<number> {
  const usage = CONTROL_USAGE[on ? 'implement' : 'release']
  const issue = issueArg(parseArgs(args, {}, usage).positionals[0], usage)
  if (on && !(await ctx.confirm(`Let nightshift implement ${issue}? This changes its Linear state.`))) {
    ctx.io.err('aborted')
    return EXIT.error
  }
  const res = await call(ctx, 'POST', '/cover', { issue, covered: on })
  return done(
    ctx,
    res,
    on ? `${issue} is covered; the supervisor picks it up on its next tick` : `${issue} is no longer covered`,
  )
}

export async function send(ctx: Ctx, args: string[]): Promise<number> {
  const usage = CONTROL_USAGE.send
  const { positionals } = parseArgs(args, {}, usage)
  const target = requireArg(positionals[0], usage)
  const message = requireArg(positionals.slice(1).join(' '), usage)
  const res = await call(ctx, 'POST', '/send', { target, message })
  return done(ctx, res, `sent to ${target}`)
}

export async function answer(ctx: Ctx, args: string[]): Promise<number> {
  const usage = CONTROL_USAGE.answer
  const { positionals } = parseArgs(args, {}, usage)
  const issue = issueArg(positionals[0], usage)
  const text = requireArg(positionals.slice(1).join(' '), usage)
  const res = await call(ctx, 'POST', '/answer', { issue, text })
  return done(ctx, res, `answered the open question on ${issue}`)
}

export async function stop(ctx: Ctx, args: string[]): Promise<number> {
  const usage = CONTROL_USAGE.stop
  const { positionals, values } = parseArgs(args, { values: ['--reason'] }, usage)
  const target = requireArg(positionals[0], usage)
  if (!(await ctx.confirm(`Stop ${target}, destroy its sandbox and hold the issue for you?`))) {
    ctx.io.err('aborted')
    return EXIT.error
  }
  const reason = values['--reason']
  const res = await call<RunResponse>(ctx, 'POST', '/stop', { target, ...(reason ? { reason } : {}) })
  return done(ctx, res, `stopped run ${res.run}; ${target} is blocked awaiting you`)
}

export async function retry(ctx: Ctx, args: string[]): Promise<number> {
  const usage = CONTROL_USAGE.retry
  const { positionals, values, bools } = parseArgs(
    args,
    { values: ['--agent', '--profile'], bools: ['--continue'] },
    usage,
  )
  const target = requireArg(positionals[0], usage)
  const agent = values['--agent']
  const profile = values['--profile']
  const res = await call<RunResponse>(ctx, 'POST', '/retry', {
    target,
    ...(agent ? { agent } : {}),
    ...(profile ? { profile } : {}),
    ...(bools.has('--continue') ? { continue: true } : {}),
  })
  return done(ctx, res, `dispatched run ${res.run} for ${target}`)
}
