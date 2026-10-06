import { loadConfig } from '@nightshift/core'
import { type CommandDeps, defaultExec, type GlobalFlags, type Io } from './cli'

export const LOCAL = 'local'

const REMOTE_BY_DEFAULT = new Set([
  'status',
  'tasks',
  'workers',
  'logs',
  'questions',
  'diff',
  'tests',
  'send',
  'answer',
  'stop',
  'retry',
  'ingest',
  'pause',
  'resume',
  'implement',
  'release',
  'attach',
  'tail',
  'watch',
  'signal',
])

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

export function withoutHost(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') {
      out.push(...argv.slice(i))
      break
    }
    if (a === '--host') {
      i++
      continue
    }
    if (a.startsWith('--host=')) continue
    out.push(a)
  }
  return out
}

export function sshCommand(
  host: string,
  argv: string[],
  o: { tty: boolean; env: Record<string, string | undefined> },
): string[] {
  // `--host local` on the far side stops a configured default host from bouncing the command again.
  const remote = ['ns', '--host', LOCAL, ...withoutHost(argv)].map(shellQuote)
  const env = o.env.NO_COLOR !== undefined ? ['env', 'NO_COLOR=1'] : []
  return ['ssh', o.tty ? '-t' : '-T', host, '--', [...env, ...remote].join(' ')]
}

export function remoteHost(
  flags: GlobalFlags,
  deps: Pick<CommandDeps, 'load'>,
  command: string | undefined,
): string | null {
  if (flags.host !== undefined) return flags.host === LOCAL ? null : flags.host
  if (!command || !REMOTE_BY_DEFAULT.has(command)) return null
  const result = (deps.load ?? loadConfig)(flags.config ? { user: flags.config } : {})
  const host = result.ok ? result.config.cli?.host : undefined
  return host && host !== LOCAL ? host : null
}

export async function runRemote(host: string, argv: string[], deps: CommandDeps, io: Io): Promise<number> {
  const exec = deps.exec ?? defaultExec()
  const tty = deps.stdoutIsTTY ?? Boolean(process.stdout.isTTY)
  const code = await exec(sshCommand(host, argv, { tty, env: deps.env ?? process.env }))
  if (code === 255) io.err(`ssh to ${host} failed`)
  return code
}
