import { existsSync, readFileSync } from 'node:fs'
import {
  type Config,
  createTokenProvider,
  LinearIssueReader,
  linearRequest,
  SecretResolver,
  validateIssue,
  withCredentials,
} from '@nightshift/core'
import { CliError, type Ctx, EXIT, parseArgs, printJson } from './cli'

export type IssueReader = { issue(identifier: string): Promise<{ description: string } | null> }

export type IssueCheckDeps = { issueReader?: (config: Config) => IssueReader }

export const ISSUE_USAGE = 'usage: ns issue check <file|id> [--allow-no-design] [--json]'

const IDENTIFIER = /^[A-Z]+-[0-9]+$/

function defaultReader(config: Config): IssueReader {
  const secrets = new SecretResolver({
    env: withCredentials(process.env),
    rbwProfile: config.secrets.rbw_profile,
  })
  const auth = createTokenProvider(config.linear.auth, (ref) => secrets.resolve(ref))
  return new LinearIssueReader(linearRequest({ auth }))
}

async function description(ctx: Ctx, target: string, deps: IssueCheckDeps): Promise<string> {
  if (IDENTIFIER.test(target)) {
    const issue = await (deps.issueReader ?? defaultReader)(ctx.config()).issue(target)
    if (!issue) throw new CliError(EXIT.notFound, `no issue ${target}`)
    return issue.description
  }
  if (!existsSync(target)) throw new CliError(EXIT.notFound, `no file ${target}`)
  return readFileSync(target, 'utf8')
}

export async function issue(ctx: Ctx, args: string[], deps: IssueCheckDeps = {}): Promise<number> {
  const { positionals, bools } = parseArgs(args, { bools: ['--allow-no-design', '--json'] }, ISSUE_USAGE)
  const [sub, target, ...extra] = positionals
  if (sub !== 'check' || target === undefined || target === '' || extra.length > 0)
    throw new CliError(EXIT.usage, ISSUE_USAGE)
  const json = ctx.flags.json || bools.has('--json')
  const result = validateIssue(await description(ctx, target, deps), {
    allowNoDesign: bools.has('--allow-no-design'),
  })
  if (result.ok) {
    if (json) printJson(ctx, result.issue)
    else ctx.io.out('ok')
    return EXIT.ok
  }
  if (json) printJson(ctx, { ok: false, errors: result.errors })
  else {
    const prefix = IDENTIFIER.test(target) ? `${target}: ` : ''
    for (const e of result.errors) ctx.io.out(`${prefix}${e.message}`)
  }
  return EXIT.error
}
