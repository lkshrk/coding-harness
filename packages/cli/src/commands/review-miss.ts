import type { ReviewMissResponse } from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, parseArgs, printJson, requireArg } from '../cli'
import { call } from './shared'

export const REVIEW_MISS_USAGE =
  'ns review-miss <pr-url-or-number> <file>:<lines> <description> [--repo <name>]'

const PR = /^([1-9][0-9]*|https?:\/\/\S+)$/
const LOCATION = /^(.+):([1-9][0-9]*(?:-[1-9][0-9]*)?)$/

export async function reviewMiss(ctx: Ctx, args: string[]): Promise<number> {
  const usage = REVIEW_MISS_USAGE
  const { positionals, values } = parseArgs(args, { values: ['--repo'] }, usage)
  const pr = requireArg(positionals[0], usage).replace(/^#/, '')
  if (!PR.test(pr)) throw new CliError(EXIT.usage, `not a PR URL or number: ${pr}\nusage: ${usage}`)
  const where = requireArg(positionals[1], usage)
  const location = LOCATION.exec(where)
  if (!location) throw new CliError(EXIT.usage, `expected <file>:<lines>, got ${where}\nusage: ${usage}`)
  const [, file, lines] = location as unknown as [string, string, string]
  const description = requireArg(positionals.slice(2).join(' '), usage)
  const repository = values['--repo']
  const res = await call<ReviewMissResponse>(ctx, 'POST', '/review-miss', {
    pr,
    file,
    lines,
    description,
    ...(repository ? { repository } : {}),
  })
  if (ctx.flags.json) printJson(ctx, res)
  else ctx.io.out(res.path)
  return EXIT.ok
}
