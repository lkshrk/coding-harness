import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxSpec } from '../../ports/interfaces'
import { type CommandOptions, type CommandResult, type DockerCli, DockerSandbox, memoryMb } from './docker'

class FakeCli implements DockerCli {
  readonly calls: { args: string[]; opts: CommandOptions }[] = []
  replies: ((args: string[]) => Partial<CommandResult> | undefined)[] = []

  async run(args: string[], opts: CommandOptions = {}): Promise<CommandResult> {
    this.calls.push({ args, opts })
    const reply = this.replies.map((r) => r(args)).find(Boolean)
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, ...reply }
  }

  async *lines(args: string[]): AsyncIterable<string> {
    this.calls.push({ args, opts: {} })
    yield 'line 1'
  }

  last(cmd: string): string[] {
    return this.calls.filter((c) => c.args[0] === cmd).at(-1)?.args ?? []
  }
}

let dir: string
let cli: FakeCli
let docker: DockerSandbox
const h = { driver: 'docker' as const, id: 'abc123', name: '01RUN' }

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    name: '01RUN',
    image: 'nightshift/omni:1',
    resources: { cpus: 2, memoryMb: 4096 },
    outbox: join(dir, 'outbox', '01RUN'),
    mounts: [{ hostPath: '/src/omni/.git', guestPath: '/mnt/repo.git', readOnly: true }],
    env: { LANG: 'C.UTF-8' },
    egress: { allow: ['gw.test'] },
    workdir: '/work',
    labels: { nightshift: '1', run: '01RUN', issue: 'FOR-1' },
    ...over,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ns-docker-'))
  cli = new FakeCli()
  docker = new DockerSandbox({ cli, publish: [4096], artifactsDir: join(dir, 'artifacts') })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('DockerSandbox', () => {
  test('create runs a labelled container with read-only mounts, a writable outbox and a published port', async () => {
    cli.replies.push((a) => (a[0] === 'inspect' ? { exitCode: 1 } : undefined))
    cli.replies.push((a) => (a[0] === 'run' ? { stdout: 'abc123def4567890\n' } : undefined))
    const handle = await docker.create(spec())
    expect(handle).toEqual({ driver: 'docker', id: 'abc123def456', name: '01RUN' })
    const outbox = join(dir, 'outbox', '01RUN')
    expect(existsSync(outbox)).toBe(true)
    expect(cli.last('run')).toEqual([
      'run',
      '--detach',
      '--name',
      'nightshift-01RUN',
      '--label',
      'nightshift=1',
      '--label',
      'run=01RUN',
      '--label',
      'issue=FOR-1',
      '--label',
      `nightshift.outbox=${outbox}`,
      '--cpus',
      '2',
      '--memory',
      '4096m',
      '--volume',
      `${outbox}:${outbox}`,
      '--volume',
      '/src/omni/.git:/mnt/repo.git:ro',
      '--env',
      'LANG=C.UTF-8',
      '--workdir',
      '/work',
      '--publish',
      '127.0.0.1::4096',
      'nightshift/omni:1',
      'sleep',
      'infinity',
    ])
  })

  test('create is idempotent by name and rejects writable mounts', async () => {
    cli.replies.push((a) => (a[0] === 'inspect' ? { stdout: 'feedfacecafe1234\n' } : undefined))
    expect(await docker.create(spec())).toEqual({ driver: 'docker', id: 'feedfacecafe', name: '01RUN' })
    expect(cli.last('run')).toEqual([])
    const writable = {
      hostPath: '/x',
      guestPath: '/x',
      readOnly: false,
    } as unknown as SandboxSpec['mounts'][0]
    await expect(docker.create(spec({ mounts: [writable] }))).rejects.toThrow('mounts must be read-only')
  })

  test('exec passes env by name only, feeds stdin and reports a timeout as 124', async () => {
    cli.replies.push(() => ({ exitCode: 124, stdout: 'partial' }))
    const res = await docker.exec(h, ['make', 'test'], {
      cwd: '/work/omni',
      env: { SECRET: 'v' },
      stdin: 'in',
      timeoutMs: 1_500,
    })
    expect(cli.last('exec')).toEqual([
      'exec',
      '--interactive',
      '--workdir',
      '/work/omni',
      '--env',
      'SECRET',
      'abc123',
      'timeout',
      '-k',
      '5',
      '2s',
      'make',
      'test',
    ])
    expect(cli.calls.at(-1)?.opts).toMatchObject({ env: { SECRET: 'v' }, stdin: 'in', timeoutMs: 16_500 })
    expect(res).toMatchObject({ exitCode: 124, timedOut: true, stdoutTail: 'partial', artifact: '' })
  })

  test('exec keeps the last 200 lines and writes large output to an artifact', async () => {
    const big = Array.from({ length: 5_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
    cli.replies.push(() => ({ stdout: big }))
    const res = await docker.exec(h, ['cat', 'log'])
    expect(res.stdoutTail.split('\n')).toHaveLength(200)
    expect(res.stdoutTail.endsWith('line 4999 xxxxxxxxxxxxxxxxxxxx')).toBe(true)
    expect(res.artifact.startsWith(join(dir, 'artifacts', '01RUN'))).toBe(true)
  })

  test('spawn detaches with closed stdin and returns the pid', async () => {
    cli.replies.push(() => ({ stdout: '77\n' }))
    expect(await docker.spawn(h, ['opencode-worker', 'serve'], { env: { K: 'v' } })).toEqual({
      sandbox: h,
      pid: '77',
    })
    const args = cli.last('exec')
    expect(args.slice(0, 4)).toEqual(['exec', '--env', 'K', 'abc123'])
    expect(args[6]).toContain('</dev/null &')
    expect(args.slice(-2)).toEqual(['opencode-worker', 'serve'])
  })

  test('expose returns the loopback URL of a published port', async () => {
    cli.replies.push(() => ({ stdout: '127.0.0.1:55001\n' }))
    expect(await docker.expose(h, 4096)).toEqual({ url: 'http://127.0.0.1:55001' })
    cli.replies.unshift(() => ({ exitCode: 1, stderr: 'no public port' }))
    await expect(docker.expose(h, 9999)).rejects.toThrow('port 9999 is not published')
  })

  test('status, list, logs and attach', async () => {
    cli.replies.push((a) => (a[0] === 'inspect' ? { stdout: 'exited\n' } : undefined))
    cli.replies.push((a) => (a[0] === 'ps' ? { stdout: 'abc123\t01RUN\ndef456\t01OTHER\n' } : undefined))
    expect(await docker.status(h)).toBe('stopped')
    expect(await docker.list({ nightshift: '1' })).toEqual([
      { driver: 'docker', id: 'abc123', name: '01RUN' },
      { driver: 'docker', id: 'def456', name: '01OTHER' },
    ])
    expect(cli.last('ps')).toContain('label=nightshift=1')
    const lines: string[] = []
    for await (const l of docker.logs(h, { follow: true })) lines.push(l)
    expect(lines).toEqual(['line 1'])
    expect(cli.calls.at(-1)?.args).toEqual(['logs', '--follow', 'abc123'])
    expect(docker.attachCommand(h)).toEqual(['docker', 'exec', '-it', 'abc123', 'bash'])
    cli.replies.unshift((a) => (a[0] === 'inspect' ? { exitCode: 1 } : undefined))
    expect(await docker.status(h)).toBe('gone')
  })

  test('exportCommits bundles into the outbox', async () => {
    const outbox = join(dir, 'outbox', '01RUN')
    cli.replies.push((a) => (a[0] === 'inspect' ? { stdout: `${outbox}\n` } : undefined))
    cli.replies.push((a) => (a.includes('rev-parse') ? { stdout: 'c0ffee\n' } : undefined))
    expect(await docker.exportCommits(h, '/work/omni', 'ns/FOR-1-1')).toEqual({
      bundle: join(outbox, '01RUN.bundle'),
      headSha: 'c0ffee',
    })
    expect(cli.calls.some((c) => c.args.includes('commit'))).toBe(false)
  })

  test('exportCommits with a message commits a dirty worktree before bundling', async () => {
    const outbox = join(dir, 'outbox', '01RUN')
    cli.replies.push((a) => (a[0] === 'inspect' ? { stdout: `${outbox}\n` } : undefined))
    cli.replies.push((a) => (a.includes('rev-parse') ? { stdout: 'c0ffee\n' } : undefined))
    await docker.exportCommits(h, '/work/omni', 'ns/FOR-1-1', 'FOR-1: changes')
    const execs = cli.calls.filter((c) => c.args[0] === 'exec').map((c) => c.args.slice(2))
    expect(execs[0]).toEqual([
      'sh',
      '-c',
      'test -z "$(git -C "$1" status --porcelain)" || { git -C "$1" add -A && git -C "$1" commit --quiet -m "$2"; }',
      'sh',
      '/work/omni',
      'FOR-1: changes',
    ])
    expect(execs[1]?.slice(0, 4)).toEqual(['git', '-C', '/work/omni', 'bundle'])
  })

  test('destroy removes the container and its outbox and tolerates a missing container', async () => {
    const outbox = join(dir, 'outbox', '01RUN')
    cli.replies.push((a) => (a[0] === 'run' ? { stdout: 'abc123\n' } : undefined))
    cli.replies.push((a) =>
      a[0] === 'inspect' && a[2]?.includes('outbox') ? { stdout: `${outbox}\n` } : undefined,
    )
    cli.replies.push((a) => (a[0] === 'inspect' ? { exitCode: 1 } : undefined))
    await docker.create(spec())
    await docker.destroy(h)
    expect(cli.last('rm')).toEqual(['rm', '--force', '--volumes', 'abc123'])
    expect(existsSync(outbox)).toBe(false)
    cli.replies = [() => ({ exitCode: 1, stderr: 'Error: No such container: abc123' })]
    await docker.destroy(h)
  })

  test('memoryMb parses the config memory size', () => {
    expect(memoryMb('8g')).toBe(8192)
    expect(memoryMb('512m')).toBe(512)
    expect(memoryMb(undefined)).toBe(8192)
  })
})
