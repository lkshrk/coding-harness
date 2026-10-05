import { join } from 'node:path'
import {
  type Config,
  DevcontainerEnvironmentBuilder,
  expandHome,
  NIGHTSHIFT_ROOT,
  type RepoImage,
  SecretResolver,
  UnknownRepositoryError,
  withCredentials,
} from '@nightshift/core'
import {
  DockerSandbox,
  GitHubTokens,
  gitAuthEnv,
  ingestConfig,
  memoryMb,
  REPO_MOUNT,
  type SandboxDriver,
} from '@nightshift/supervisor'

export type Io = { out: (line: string) => void; err: (line: string) => void }

export type EnvBuilder = {
  current(repo: string): Promise<RepoImage | undefined>
  build(repo: string, opts?: { log?: (line: string) => void }): Promise<RepoImage>
  ensure(repo: string, opts?: { log?: (line: string) => void }): Promise<RepoImage>
}

export type EnvDeps = {
  envBuilder?: (config: Config) => EnvBuilder
  fetch?: (checkout: string, remote: string, base: string, env?: Record<string, string>) => string
  gitAuth?: (config: Config, repo: string) => Promise<Record<string, string>>
  sandbox?: () => SandboxDriver
  attach?: (cmd: string[]) => Promise<number>
  home?: string
}

export const ENV_USAGE = 'usage: ns env build|shell <repo>'

function git(checkout: string, args: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(['git', '-C', checkout, ...args], {
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${checkout}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString().trim()
}

function fetchBase(checkout: string, remote: string, base: string, env: Record<string, string> = {}): string {
  git(checkout, ['fetch', '--quiet', remote, base], env)
  return git(checkout, ['rev-parse', `${remote}/${base}`])
}

async function attach(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  return proc.exited
}

function describe(image: RepoImage): string {
  return `${image.tag} (stacks: ${image.stacks.join(', ')})`
}

async function build(config: Config, repo: string, deps: EnvDeps, io: Io): Promise<number> {
  const builder = (deps.envBuilder ?? defaultBuilder(deps))(config)
  const current = await builder.current(repo)
  if (current) {
    io.out(`${describe(current)} up to date`)
    return 0
  }
  const image = await builder.build(repo, { log: io.err })
  io.out(`${describe(image)} built`)
  return 0
}

async function shell(config: Config, repo: string, sha: string, deps: EnvDeps, io: Io): Promise<number> {
  const home = deps.home ?? process.env.HOME ?? ''
  const r = config.repositories[repo] as Config['repositories'][string]
  const builder = (deps.envBuilder ?? defaultBuilder(deps))(config)
  const image = await builder.ensure(repo, { log: io.err })
  const name = `shell-${repo}-${Date.now().toString(36)}`
  const sandbox = deps.sandbox?.() ?? new DockerSandbox()
  const handle = await sandbox.create({
    name,
    image: image.tag,
    resources: {
      cpus: config.sandbox.resources.cpus ?? 4,
      memoryMb: memoryMb(config.sandbox.resources.memory),
    },
    outbox: join(expandHome(config.paths.cache, home), 'outbox', name),
    mounts: [{ hostPath: join(expandHome(r.path, home), '.git'), guestPath: REPO_MOUNT, readOnly: true }],
    env: {},
    egress: { allow: [] },
    workdir: '/work',
    labels: { nightshift: '1', shell: repo },
  })
  try {
    const workdir = `/work/${repo}`
    const cloned = await sandbox.exec(handle, [
      'sh',
      '-c',
      'git config --global --add safe.directory "*" && git clone --quiet --shared "$1" "$2" && git -C "$2" checkout --quiet --detach "$3"',
      'sh',
      REPO_MOUNT,
      workdir,
      sha,
    ])
    if (cloned.exitCode !== 0) throw new Error(`workspace setup failed: ${cloned.stderrTail.trim()}`)
    io.err(`${describe(image)}: ${workdir} at ${r.remote}/${r.base} (${sha.slice(0, 12)}); exit to destroy`)
    return await (deps.attach ?? attach)(
      sandbox.attachCommand(handle, ['sh', '-c', `cd ${workdir} && exec bash`]),
    )
  } finally {
    await sandbox.destroy(handle)
  }
}

function defaultBuilder(deps: EnvDeps): (config: Config) => EnvBuilder {
  return (config) =>
    new DevcontainerEnvironmentBuilder({
      config: () => config,
      root: NIGHTSHIFT_ROOT,
      ...(deps.home ? { home: deps.home } : {}),
    })
}

export async function env(args: string[], userConfig: Config, deps: EnvDeps, io: Io): Promise<number> {
  const config = ingestConfig(userConfig)
  const [sub, repo, ...rest] = args
  if ((sub !== 'build' && sub !== 'shell') || !repo || rest.length > 0) {
    io.err(ENV_USAGE)
    return 2
  }
  const r = Object.hasOwn(config.repositories, repo) ? config.repositories[repo] : undefined
  if (!r) {
    io.err(`unknown repository '${repo}'`)
    return 4
  }
  try {
    const home = deps.home ?? process.env.HOME ?? ''
    const auth = await (deps.gitAuth ?? defaultGitAuth)(config, repo)
    const sha = (deps.fetch ?? fetchBase)(expandHome(r.path, home), r.remote, r.base, auth)
    return sub === 'build' ? await build(config, repo, deps, io) : await shell(config, repo, sha, deps, io)
  } catch (e) {
    if (e instanceof UnknownRepositoryError) {
      io.err(e.message)
      return 4
    }
    io.err(`env ${sub}: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

async function defaultGitAuth(config: Config, repo: string): Promise<Record<string, string>> {
  const secrets = new SecretResolver({
    env: withCredentials(process.env),
    rbwProfile: config.secrets.rbw_profile,
  })
  const tokens = new GitHubTokens({ config: () => config, resolve: (ref) => secrets.resolve(ref) })
  return gitAuthEnv(await tokens.token(repo))
}
