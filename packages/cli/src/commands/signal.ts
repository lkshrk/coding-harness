import { homedir, hostname } from 'node:os'
import { dirname } from 'node:path'
import { SecretResolver, withCredentials } from '@nightshift/core'
import {
  openStateReadOnly,
  PAIRING_TTL_MS,
  resolveTarget,
  SignalApiError,
  type SignalSettings,
  signalApi,
  startPairing,
} from '@nightshift/supervisor'
import { CliError, type Ctx, EXIT, parseArgs, printJson } from '../cli'

export const SIGNAL_USAGE = 'ns signal test | ns signal pair [--no-wait]'
const PAIR_POLL_MS = 2_000

function settings(ctx: Ctx): SignalSettings {
  const s = ctx.config().notifications.signal
  if (!s) throw new CliError(EXIT.error, 'notifications.signal is not configured')
  return s
}

function failure(e: unknown): CliError {
  if (e instanceof SignalApiError && e.unauthorized) {
    return new CliError(EXIT.error, 'signal: the API key was rejected (check notifications.signal.api_key)')
  }
  return new CliError(EXIT.error, (e as Error).message)
}

async function test(ctx: Ctx): Promise<number> {
  const s = settings(ctx)
  const config = ctx.config()
  const resolver = new SecretResolver({
    env: withCredentials(ctx.env),
    rbwProfile: config.secrets.rbw_profile,
  })
  const api = signalApi(s, (ref) => resolver.resolve(ref), { home: homedir(), fetch: ctx.fetch })
  try {
    const target = await resolveTarget(api, s.group)
    const timestamp = await api.send(
      target.number,
      target.recipient,
      `nightshift test message from ${hostname()}`,
    )
    if (ctx.flags.json) printJson(ctx, { group: target.groupName, timestamp })
    else ctx.io.out(`sent a test message to '${target.groupName}' (timestamp ${timestamp})`)
    return EXIT.ok
  } catch (e) {
    throw failure(e)
  }
}

function pairedUser(path: string): string | undefined {
  const db = openStateReadOnly(path)
  if (!db) return undefined
  try {
    return db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get('signal_user')
      ?.value
  } finally {
    db.close()
  }
}

async function pair(ctx: Ctx, wait: boolean): Promise<number> {
  const s = settings(ctx)
  if (s.user) {
    ctx.io.out(`notifications.signal.user is set (${s.user}); remove it to pair another account`)
    return EXIT.ok
  }
  const path = ctx.statePath()
  const before = pairedUser(path)
  const { code } = startPairing(dirname(path), ctx.now())
  ctx.io.out(`send this in the Signal group '${s.group}' within ${PAIRING_TTL_MS / 60_000} minutes:`)
  ctx.io.out(`ns pair ${code}`)
  if (!wait) return EXIT.ok
  const deadline = ctx.now().getTime() + PAIRING_TTL_MS
  while (ctx.now().getTime() < deadline && !ctx.signal?.aborted) {
    await ctx.sleep(PAIR_POLL_MS)
    const user = pairedUser(path)
    if (user && user !== before) {
      ctx.io.out(`paired with ${user}`)
      return EXIT.ok
    }
  }
  ctx.io.err('no pairing message arrived; is the supervisor running?')
  return EXIT.error
}

export async function signal(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals, bools } = parseArgs(args, { bools: ['--no-wait'] }, SIGNAL_USAGE)
  if (positionals.length !== 1) throw new CliError(EXIT.usage, `usage: ${SIGNAL_USAGE}`)
  if (positionals[0] === 'test') return test(ctx)
  if (positionals[0] === 'pair') return pair(ctx, !bools.has('--no-wait'))
  throw new CliError(EXIT.usage, `usage: ${SIGNAL_USAGE}`)
}
