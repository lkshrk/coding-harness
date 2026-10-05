import {
  type Config,
  formatError,
  type LoadResult,
  loadConfig,
  NIGHTSHIFT_ROOT,
  NIGHTSHIFT_VERSION,
} from '@nightshift/core'
import { composeSupervisor, runSupervisor, serveControl, socketPath, statePath } from '@nightshift/supervisor'
import { CliError, type CommandDeps, createCtx, EXIT, type Io, parseGlobal, withoutValueFlags } from './cli'
import { COMMAND_HELP, COMMANDS } from './commands'
import { DOCTOR_USAGE, type DoctorDeps, doctor, parseDoctorFlags } from './doctor'
import { type EnvDeps, env } from './env'
import { type IssueCheckDeps, issue } from './issue-check'
import { remoteHost, runRemote } from './remote'
import { down, type ServiceDeps, up } from './service'

export type { Io }

export type CliDeps = DoctorDeps &
  EnvDeps &
  IssueCheckDeps &
  CommandDeps & {
    load?: () => LoadResult
    statePath?: () => string
    waitForSignal?: () => Promise<string>
    service?: ServiceDeps
  }

const DEFAULT_INTERVAL_MS = 30_000

function loaded(deps: CliDeps, io: Io): Config | null {
  const result = (deps.load ?? (() => loadConfig()))()
  if (result.ok) return result.config
  for (const e of result.errors) io.err(`config: ${formatError(e)}`)
  return null
}

function waitForSignal(): Promise<string> {
  return new Promise((resolve) => {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => resolve(sig))
  })
}

async function supervise(deps: CliDeps, io: Io): Promise<number> {
  const config = loaded(deps, io)
  if (!config) return 1
  const { supervisor, attach, close, signal } = await composeSupervisor({
    config,
    root: NIGHTSHIFT_ROOT,
    out: io.err,
  })
  try {
    const stop = await runSupervisor(supervisor, { intervalMs: DEFAULT_INTERVAL_MS })
    const server = serveControl(supervisor, socketPath(config), { attach })
    signal?.start()
    io.err(`nightshift supervising (state ${statePath(config)}, control ${server.path})`)
    const received = await (deps.waitForSignal ?? waitForSignal)()
    server.close()
    await signal?.stop()
    await stop(received)
    return 0
  } finally {
    close()
  }
}

export async function run(argv: string[], io: Io, given: CliDeps = {}): Promise<number> {
  let parsed: ReturnType<typeof parseGlobal>
  try {
    parsed = parseGlobal(argv)
  } catch (e) {
    io.err((e as Error).message)
    return EXIT.usage
  }
  const { flags, rest } = parsed
  const commandName = rest[0]
  const options = rest.slice(1, rest.indexOf('--') < 0 ? undefined : rest.indexOf('--'))
  const help = commandName === 'help' || commandName === '--help' || commandName === '-h'
  if (help || options.includes('--help') || options.includes('-h')) {
    const target =
      commandName === 'help' && (rest[1] === '--help' || rest[1] === '-h')
        ? 'help'
        : help
          ? rest[1]
          : commandName
    if (target === undefined) {
      io.out('usage: ns <command> [options]\n\nCommands:')
      for (const [name, entry] of Object.entries(COMMAND_HELP))
        io.out(`  ${name.padEnd(12)} ${entry.description}`)
      io.out('\nrun ns help <command> for command usage')
      return EXIT.ok
    }
    if (Object.hasOwn(COMMAND_HELP, target)) {
      const usage = COMMAND_HELP[target]?.usage as string
      io.out(usage.startsWith('usage: ') ? usage : `usage: ${usage}`)
      return EXIT.ok
    }
    io.err(`unknown command: ${target}`)
    io.err('run ns help')
    return EXIT.usage
  }
  const args =
    rest[0] === 'issue' || (rest[0] !== undefined && Object.hasOwn(COMMANDS, rest[0]))
      ? rest
      : withoutValueFlags(argv)
  const user = flags.config
  const deps: CliDeps = user && !given.load ? { ...given, load: () => loadConfig({ user }) } : given
  const remote = remoteHost(flags, deps, args[0])
  if (remote) return runRemote(remote, argv, deps, io)
  const [command] = args
  if (command === '--version' || command === '-v') {
    io.out(`nightshift ${NIGHTSHIFT_VERSION}`)
    return 0
  }
  if (command === 'supervise') return supervise(deps, io)
  if (command === 'up') return up({ ...(deps.load ? { load: deps.load } : {}), ...deps.service }, io)
  if (command === 'down') return down({ ...deps.service }, io)
  const handler = command && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined
  if (handler) {
    const ctx = createCtx(io, flags, deps)
    try {
      return await handler(ctx, args.slice(1))
    } catch (e) {
      if (!(e instanceof CliError)) throw e
      io.err(e.message)
      return e.exit
    }
  }
  if (command === 'env') {
    const config = loaded(deps, io)
    return config ? env(args.slice(1), config, deps, io) : 1
  }
  if (command === 'issue') {
    try {
      return await issue(createCtx(io, flags, deps), args.slice(1), deps)
    } catch (e) {
      if (!(e instanceof CliError)) throw e
      io.err(e.message)
      return e.exit
    }
  }
  if (command === 'doctor') {
    const flags = parseDoctorFlags(args.slice(1))
    if (flags) return doctor(flags, deps, io)
    io.err(DOCTOR_USAGE)
    return 2
  }
  io.err(`unknown command: ${args.join(' ') || '(none)'}`)
  io.err('run ns help')
  return 2
}
