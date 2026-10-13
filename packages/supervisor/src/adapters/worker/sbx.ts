import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
} from '../../ports'
import { type DockerCli, dockerCli, tail, writableCache, writeArtifact } from './docker'

export type SbxCli = DockerCli

export const SBX_LOG = '/tmp/nightshift.log'

const LABELS_FILE = '.labels.json'
const OUTBOX_INDEX = join(tmpdir(), 'nightshift-sbx-outboxes')
const LINK_SCRIPT =
  'mkdir -p "$1" && chmod 0777 "$1" || exit 1; shift; while [ $# -gt 0 ]; do mkdir -p "$(dirname "$2")" && rm -rf "$2" && ln -s "$1" "$2" || exit 1; shift 2; done'

type SbxEntry = { name: string; status?: string; workspaces?: string[] }
type SbxPort = { host_ip?: string; host_port?: number; sandbox_port?: number }

export type SbxSandboxOptions = { cli?: SbxCli; artifactsDir?: string; prefix?: string; publish?: number[] }

export class SbxSandbox implements SandboxDriver {
  private readonly cli: SbxCli
  private readonly prefix: string

  constructor(private readonly o: SbxSandboxOptions = {}) {
    this.cli = o.cli ?? dockerCli('sbx')
    this.prefix = o.prefix ?? 'nightshift-'
  }

  capabilities(): SandboxCapabilities {
    return { nestedDocker: true, egressPolicy: true, credentialInjection: true }
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (spec.mounts.some((m) => m.readOnly !== true && !('cache' in m && m.cache === true)))
      throw new Error('mounts must be read-only')
    const name = `${this.prefix}${spec.name}`
    const h: SandboxHandle = { driver: 'sbx', id: name, name: spec.name }
    if (await this.entry(name)) return h
    mkdirSync(spec.outbox, { recursive: true })
    mkdirSync(OUTBOX_INDEX, { recursive: true })
    writeFileSync(join(OUTBOX_INDEX, name), spec.outbox)
    writeFileSync(join(spec.outbox, LABELS_FILE), JSON.stringify({ ...spec.labels, nightshift: '1' }))
    const caches = spec.mounts.filter((m) => !m.readOnly)
    for (const m of caches) writableCache(m.hostPath)
    const res = await this.cli.run([
      'create',
      '-q',
      '--name',
      name,
      '--cpus',
      String(spec.resources.cpus),
      '-m',
      `${spec.resources.memoryMb}m`,
      '-t',
      spec.image,
      '--pull',
      'missing',
      ...Object.entries(spec.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ...(this.o.publish ?? []).flatMap((p) => ['-p', String(p)]),
      'shell',
      spec.outbox,
      ...caches.map((m) => m.hostPath),
      ...spec.mounts.filter((m) => m.readOnly).map((m) => `${m.hostPath}:ro`),
    ])
    if (res.exitCode !== 0) {
      rmSync(spec.outbox, { recursive: true, force: true })
      rmSync(join(OUTBOX_INDEX, name), { force: true })
      throw new Error(`sbx create failed: ${res.stderr.trim()}`)
    }
    const links = spec.mounts.filter((m) => m.guestPath !== m.hostPath)
    const linked = await this.cli.run([
      'exec',
      '-u',
      'root',
      name,
      'sh',
      '-c',
      LINK_SCRIPT,
      'sh',
      spec.workdir,
      ...links.flatMap((m) => [m.hostPath, m.guestPath]),
    ])
    if (linked.exitCode !== 0) {
      await this.destroy(h)
      throw new Error(`preparing workdir and guest paths failed: ${linked.stderr.trim()}`)
    }
    if (spec.egress.allow.length > 0) {
      const policy = await this.cli.run([
        'policy',
        'allow',
        'network',
        '--sandbox',
        name,
        spec.egress.allow.join(','),
      ])
      if (policy.exitCode !== 0) {
        await this.destroy(h)
        throw new Error(`sbx policy allow failed: ${policy.stderr.trim()}`)
      }
    }
    return h
  }

  async status(h: SandboxHandle): Promise<SandboxStatus> {
    const e = await this.entry(h.id)
    if (!e) return 'gone'
    return e.status === 'running' ? 'running' : 'stopped'
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
        ...(opts.stdin === undefined ? [] : ['-i']),
        ...(opts.cwd ? ['-w', opts.cwd] : []),
        ...Object.keys(opts.env ?? {}).flatMap((k) => ['-e', k]),
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
      artifact: writeArtifact(this.o.artifactsDir, h, res),
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
      ['sh', '-c', `nohup "$@" >>${SBX_LOG} 2>&1 </dev/null & echo $!`, 'sh', ...cmd],
      opts,
    )
    if (res.exitCode !== 0) throw new Error(`spawn ${cmd[0]} failed: ${res.stderrTail.trim()}`)
    return { sandbox: h, pid: res.stdoutTail.trim() }
  }

  async expose(h: SandboxHandle, guestPort: number): Promise<{ url: string }> {
    const res = await this.cli.run(['ports', h.id, '--json'])
    let ports: SbxPort[] = []
    try {
      ports = res.exitCode === 0 ? (JSON.parse(res.stdout) as SbxPort[]) : []
    } catch {}
    const p = ports.find((x) => x.host_ip === '127.0.0.1' && x.sandbox_port === guestPort && x.host_port)
    if (!p) throw new Error(`port ${guestPort} is not published for ${h.id}`)
    return { url: `http://127.0.0.1:${p.host_port}` }
  }

  attachCommand(h: SandboxHandle, shell: string[] = ['bash']): string[] {
    return ['sbx', 'exec', '-it', h.id, ...shell]
  }

  logs(h: SandboxHandle, opts: { follow?: boolean } = {}): AsyncIterable<string> {
    return this.cli.lines(['exec', h.id, 'tail', '-n', '+1', ...(opts.follow ? ['-F'] : []), SBX_LOG])
  }

  async exportCommits(
    h: SandboxHandle,
    repoPath: string,
    ref: string,
    message?: string,
  ): Promise<{ bundle: string; headSha: string }> {
    const outbox = (await this.entry(h.id))?.workspaces?.[0]
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
    return (await this.entries())
      .filter((e) => e.name.startsWith(this.prefix))
      .filter((e) => {
        const own = readLabels(e.workspaces?.[0])
        return own !== undefined && Object.entries(labels).every(([k, v]) => own[k] === v)
      })
      .map((e) => ({ driver: 'sbx', id: e.name, name: e.name.slice(this.prefix.length) }))
  }

  async destroy(h: SandboxHandle): Promise<void> {
    const indexed = join(OUTBOX_INDEX, h.id)
    const listed = await this.entry(h.id).catch(() => undefined)
    const outbox =
      listed?.workspaces?.[0] ?? (existsSync(indexed) ? readFileSync(indexed, 'utf8').trim() : undefined)
    const res = await this.cli.run(['rm', '--force', h.id])
    if (res.exitCode !== 0 && !/not found/i.test(res.stderr))
      throw new Error(`sbx rm failed: ${res.stderr.trim()}`)
    if (outbox) rmSync(outbox, { recursive: true, force: true })
    rmSync(indexed, { force: true })
  }

  private async entries(): Promise<SbxEntry[]> {
    const res = await this.cli.run(['ls', '--json'])
    if (res.exitCode !== 0) throw new Error(`sbx ls failed: ${res.stderr.trim()}`)
    return (JSON.parse(res.stdout || '{}') as { sandboxes?: SbxEntry[] }).sandboxes ?? []
  }

  private async entry(name: string): Promise<SbxEntry | undefined> {
    return (await this.entries()).find((e) => e.name === name)
  }
}

function readLabels(outbox: string | undefined): Record<string, string> | undefined {
  if (!outbox) return undefined
  const path = join(outbox, LABELS_FILE)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
  } catch {
    return undefined
  }
}
