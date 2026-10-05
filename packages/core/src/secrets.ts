export class SecretError extends Error {
  override name = 'SecretError'
}

export class SecretLockedError extends SecretError {
  override name = 'SecretLockedError'
  readonly profile: string

  constructor(profile: string) {
    super(`rbw profile ${profile} is locked: run \`RBW_PROFILE=${profile} rbw unlock\``)
    this.profile = profile
  }
}

export type SecretRef =
  | { kind: 'env'; name: string }
  | { kind: 'rbw'; item: string; folder?: string; field?: string }

export type CommandResult = { exitCode: number; stdout: string; stderr: string }

export type CommandRunner = (cmd: string[], env: Record<string, string>) => Promise<CommandResult>

const ENV_REF = /^env:([A-Z_][A-Z0-9_]*)$/
const RBW_REF = /^rbw:(?:([^/#]+)\/)?([^/#]+)(?:#([^#]+))?$/

export function parseSecretRef(ref: string): SecretRef {
  const env = ENV_REF.exec(ref)
  if (env?.[1]) return { kind: 'env', name: env[1] }
  const rbw = RBW_REF.exec(ref)
  if (rbw?.[2]) {
    const [, folder, item, field] = rbw
    return { kind: 'rbw', item, ...(folder ? { folder } : {}), ...(field ? { field } : {}) }
  }
  throw new SecretError(`${ref}: not a secret reference (env:NAME or rbw:[folder/]item[#field])`)
}

export const bunRunner: CommandRunner = async (cmd, env) => {
  const proc = Bun.spawn(cmd, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

export class SecretResolver {
  private readonly env: Record<string, string | undefined>
  private readonly run: CommandRunner
  private readonly profile: string
  private readonly cache = new Map<string, string>()

  constructor(opts: { env: Record<string, string | undefined>; run?: CommandRunner; rbwProfile?: string }) {
    this.env = opts.env
    this.run = opts.run ?? bunRunner
    this.profile = opts.rbwProfile ?? 'nightshift'
    if (!this.profile) throw new SecretError('rbw profile must not be empty')
  }

  async resolve(ref: string): Promise<string> {
    const cached = this.cache.get(ref)
    if (cached !== undefined) return cached
    const parsed = parseSecretRef(ref)
    const value = parsed.kind === 'env' ? this.fromEnv(parsed.name) : await this.fromRbw(ref, parsed)
    this.cache.set(ref, value)
    return value
  }

  async locked(): Promise<boolean> {
    return (await this.run(['rbw', 'unlocked'], this.rbwEnv())).exitCode !== 0
  }

  clear(): void {
    this.cache.clear()
  }

  private fromEnv(name: string): string {
    const value = this.env[name]
    if (value === undefined || value === '') throw new SecretError(`environment variable ${name} is not set`)
    return value
  }

  private rbwEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const key of ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) {
      const v = this.env[key]
      if (v) env[key] = v
    }
    env.RBW_PROFILE = this.profile
    return env
  }

  private async fromRbw(ref: string, r: Extract<SecretRef, { kind: 'rbw' }>): Promise<string> {
    const env = this.rbwEnv()
    if (await this.locked()) throw new SecretLockedError(this.profile)
    const cmd = ['rbw', 'get']
    if (r.folder) cmd.push('--folder', r.folder)
    if (r.field) cmd.push('--field', r.field)
    cmd.push(r.item)
    const res = await this.run(cmd, env)
    if (res.exitCode !== 0) throw new SecretError(`${ref}: entry not found`)
    const value = res.stdout.replace(/\r?\n$/, '')
    if (!value) throw new SecretError(`${ref}: entry is empty`)
    return value
  }
}
