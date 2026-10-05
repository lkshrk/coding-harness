import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ExecResult,
  Ms,
  ProcessHandle,
  SandboxCapabilities,
  SandboxDriver,
  SandboxHandle,
  SandboxSpec,
  SandboxStatus,
} from '../interfaces'

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: Ms
  timedOut: boolean
}

export type CommandOptions = { env?: Record<string, string>; stdin?: string; timeoutMs?: Ms }

export interface DockerCli {
  run(args: string[], opts?: CommandOptions): Promise<CommandResult>
  lines(args: string[]): AsyncIterable<string>
}

export function dockerCli(bin = 'docker'): DockerCli {
  return {
    async run(args, opts = {}) {
      const started = Date.now()
      const proc = Bun.spawn([bin, ...args], {
        env: { ...process.env, ...opts.env },
        stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      let timedOut = false
      const timer =
        opts.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              proc.kill('SIGKILL')
            }, opts.timeoutMs)
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      clearTimeout(timer)
      return { exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut }
    },
    async *lines(args) {
      const proc = Bun.spawn([bin, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for await (const chunk of proc.stdout) {
          buffer += decoder.decode(chunk, { stream: true })
          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''
          yield* parts
        }
        if (buffer) yield buffer
      } finally {
        proc.kill()
      }
    },
  }
}

const OUTPUT_LIMIT = 64 * 1024
const TAIL_LINES = 200
const OUTBOX_LABEL = 'nightshift.outbox'

function tail(text: string): string {
  return text.split('\n').slice(-TAIL_LINES).join('\n')
}

export function memoryMb(memory: string | undefined, fallback = 8192): number {
  const m = memory?.match(/^([1-9][0-9]*)([mg])$/)
  if (!m) return fallback
  return Number(m[1]) * (m[2] === 'g' ? 1024 : 1)
}

export type DockerSandboxOptions = {
  cli?: DockerCli
  publish?: number[]
  artifactsDir?: string
  prefix?: string
}

export class DockerSandbox implements SandboxDriver {
  private readonly cli: DockerCli
  private readonly prefix: string

  constructor(private readonly o: DockerSandboxOptions = {}) {
    this.cli = o.cli ?? dockerCli()
    this.prefix = o.prefix ?? 'nightshift-'
  }

  capabilities(): SandboxCapabilities {
    return { nestedDocker: false, egressPolicy: false, credentialInjection: false }
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (spec.mounts.some((m) => m.readOnly !== true)) throw new Error('mounts must be read-only')
    const name = `${this.prefix}${spec.name}`
    const existing = await this.cli.run(['inspect', '--format', '{{.Id}}', name])
    if (existing.exitCode === 0) return this.handle(existing.stdout, spec.name)
    mkdirSync(spec.outbox, { recursive: true })
    const labels = { ...spec.labels, nightshift: '1', [OUTBOX_LABEL]: spec.outbox }
    const args = [
      'run',
      '--detach',
      '--name',
      name,
      ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      '--cpus',
      String(spec.resources.cpus),
      '--memory',
      `${spec.resources.memoryMb}m`,
      '--volume',
      `${spec.outbox}:${spec.outbox}`,
      ...spec.mounts.flatMap((m) => ['--volume', `${m.hostPath}:${m.guestPath}:ro`]),
      ...Object.entries(spec.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
      '--workdir',
      spec.workdir,
      ...(this.o.publish ?? []).flatMap((p) => ['--publish', `127.0.0.1::${p}`]),
      spec.image,
      'sleep',
      'infinity',
    ]
    const res = await this.cli.run(args)
    if (res.exitCode !== 0) throw new Error(`docker run failed: ${res.stderr.trim()}`)
    return this.handle(res.stdout, spec.name)
  }

  async status(h: SandboxHandle): Promise<SandboxStatus> {
    const res = await this.cli.run(['inspect', '--format', '{{.State.Status}}', h.id])
    if (res.exitCode !== 0) return 'gone'
    return res.stdout.trim() === 'running' ? 'running' : 'stopped'
  }

  async exec(
    h: SandboxHandle,
    cmd: string[],
    opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: Ms; stdin?: string } = {},
  ): Promise<ExecResult> {
    const inner =
      opts.timeoutMs === undefined
        ? cmd
        : ['timeout', '-k', '5', `${Math.ceil(opts.timeoutMs / 1000)}s`, ...cmd]
    const res = await this.cli.run(
      [
        'exec',
        ...(opts.stdin === undefined ? [] : ['--interactive']),
        ...(opts.cwd ? ['--workdir', opts.cwd] : []),
        ...Object.keys(opts.env ?? {}).flatMap((k) => ['--env', k]),
        h.id,
        ...inner,
      ],
      {
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs + 15_000 }),
      },
    )
    const timedOut = res.timedOut || (opts.timeoutMs !== undefined && res.exitCode === 124)
    return {
      exitCode: timedOut ? 124 : res.exitCode,
      durationMs: res.durationMs,
      stdoutTail: tail(res.stdout),
      stderrTail: tail(res.stderr),
      artifact: this.artifact(h, res),
      timedOut,
    }
  }

  async spawn(
    h: SandboxHandle,
    cmd: string[],
    opts: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<ProcessHandle> {
    const res = await this.exec(
      h,
      ['sh', '-c', 'nohup "$@" >/proc/1/fd/1 2>/proc/1/fd/2 </dev/null & echo $!', 'sh', ...cmd],
      opts,
    )
    if (res.exitCode !== 0) throw new Error(`spawn ${cmd[0]} failed: ${res.stderrTail.trim()}`)
    return { sandbox: h, pid: res.stdoutTail.trim() }
  }

  async expose(h: SandboxHandle, guestPort: number): Promise<{ url: string }> {
    const res = await this.cli.run(['port', h.id, `${guestPort}/tcp`])
    const binding = res.stdout.split('\n').find((l) => l.startsWith('127.0.0.1:'))
    if (res.exitCode !== 0 || !binding) throw new Error(`port ${guestPort} is not published for ${h.id}`)
    return { url: `http://${binding.trim()}` }
  }

  attachCommand(h: SandboxHandle, shell: string[] = ['bash']): string[] {
    return ['docker', 'exec', '-it', h.id, ...shell]
  }

  logs(h: SandboxHandle, opts: { follow?: boolean } = {}): AsyncIterable<string> {
    return this.cli.lines(['logs', ...(opts.follow ? ['--follow'] : []), h.id])
  }

  async exportCommits(
    h: SandboxHandle,
    repoPath: string,
    ref: string,
    message?: string,
  ): Promise<{ bundle: string; headSha: string }> {
    const outbox = await this.outbox(h.id)
    if (!outbox) throw new Error(`sandbox ${h.id} has no outbox`)
    const bundle = join(outbox, `${h.name}.bundle`)
    if (message) {
      const commit = await this.exec(h, [
        'sh',
        '-c',
        'test -z "$(git -C "$1" status --porcelain)" || { git -C "$1" add -A && git -C "$1" commit --quiet -m "$2"; }',
        'sh',
        repoPath,
        message,
      ])
      if (commit.exitCode !== 0)
        throw new Error(`committing worker changes failed: ${commit.stderrTail.trim()}`)
    }
    const created = await this.exec(h, ['git', '-C', repoPath, 'bundle', 'create', bundle, ref])
    if (created.exitCode !== 0) throw new Error(`git bundle failed: ${created.stderrTail.trim()}`)
    const head = await this.exec(h, ['git', '-C', repoPath, 'rev-parse', ref])
    if (head.exitCode !== 0) throw new Error(`git rev-parse ${ref} failed: ${head.stderrTail.trim()}`)
    return { bundle, headSha: head.stdoutTail.trim() }
  }

  async list(labels: Record<string, string>): Promise<SandboxHandle[]> {
    const res = await this.cli.run([
      'ps',
      '--all',
      ...Object.entries(labels).flatMap(([k, v]) => ['--filter', `label=${k}=${v}`]),
      '--format',
      '{{.ID}}\t{{.Label "run"}}',
    ])
    if (res.exitCode !== 0) throw new Error(`docker ps failed: ${res.stderr.trim()}`)
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id = '', name = ''] = line.split('\t')
        return { driver: 'docker', id, name }
      })
  }

  async destroy(h: SandboxHandle): Promise<void> {
    const outbox = await this.outbox(h.id)
    const res = await this.cli.run(['rm', '--force', '--volumes', h.id])
    if (res.exitCode !== 0 && !/no such container/i.test(res.stderr)) {
      throw new Error(`docker rm failed: ${res.stderr.trim()}`)
    }
    if (outbox) rmSync(outbox, { recursive: true, force: true })
  }

  private handle(id: string, name: string): SandboxHandle {
    return { driver: 'docker', id: id.trim().slice(0, 12), name }
  }

  private async outbox(id: string): Promise<string | undefined> {
    const res = await this.cli.run(['inspect', '--format', `{{index .Config.Labels "${OUTBOX_LABEL}"}}`, id])
    return res.exitCode === 0 && res.stdout.trim() ? res.stdout.trim() : undefined
  }

  private artifact(h: SandboxHandle, res: CommandResult): string {
    if (res.stdout.length <= OUTPUT_LIMIT && res.stderr.length <= OUTPUT_LIMIT) return ''
    const dir = join(this.o.artifactsDir ?? join(tmpdir(), 'nightshift-artifacts'), h.name)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `exec-${Date.now()}.log`)
    writeFileSync(path, `--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`)
    return path
  }
}
