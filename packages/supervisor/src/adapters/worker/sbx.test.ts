import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxSpec } from '../../ports'
import type { CommandOptions, CommandResult } from './docker'
import { SBX_LOG, type SbxCli, SbxSandbox } from './sbx'

class FakeCli implements SbxCli {
  readonly calls: { args: string[]; opts: CommandOptions }[] = []
  replies: ((args: string[]) => Partial<CommandResult> | undefined)[] = []
  sandboxes: { name: string; status: string; workspaces: string[] }[] = []

  async run(args: string[], opts: CommandOptions = {}): Promise<CommandResult> {
    this.calls.push({ args, opts })
    const reply = this.replies.map((r) => r(args)).find(Boolean)
    if (!reply && args[0] === 'ls')
      return this.result({
        stdout: JSON.stringify({ sandboxes: this.sandboxes.map((s) => ({ ...s, ports: [] })) }),
      })
    if (!reply && args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1] ?? ''
      const shell = args.indexOf('shell')
      this.sandboxes.push({ name, status: 'running', workspaces: args.slice(shell + 1) })
    }
    return this.result(reply)
  }

  private result(reply: Partial<CommandResult> | undefined): CommandResult {
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, ...reply }
  }

  async *lines(args: string[]): AsyncIterable<string> {
    this.calls.push({ args, opts: {} })
    yield 'line 1'
  }

  all(cmd: string): string[][] {
    return this.calls.filter((c) => c.args[0] === cmd).map((c) => c.args)
  }

  last(cmd: string): string[] {
    return this.all(cmd).at(-1) ?? []
  }
}

let dir: string
let cli: FakeCli
let sbx: SbxSandbox
const h = { driver: 'sbx' as const, id: 'nightshift-01RUN', name: '01RUN' }

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    name: '01RUN',
    image: 'nightshift/omni:1',
    resources: { cpus: 2, memoryMb: 4096 },
    outbox: join(dir, 'outbox', '01RUN'),
    mounts: [{ hostPath: '/src/omni/.git', guestPath: '/mnt/repo.git', readOnly: true }],
    env: { LANG: 'C.UTF-8' },
    egress: { allow: ['gw.test', 'otel.test:4318'] },
    workdir: '/work',
    labels: { run: '01RUN', issue: 'FOR-1' },
    ...over,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ns-sbx-'))
  cli = new FakeCli()
  sbx = new SbxSandbox({ cli, publish: [4096], artifactsDir: join(dir, 'artifacts') })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('SbxSandbox', () => {
  test('capabilities are all true', () => {
    expect(sbx.capabilities()).toEqual({ nestedDocker: true, egressPolicy: true, credentialInjection: true })
  })

  test('create builds the sbx create argv, writes labels, links guest paths and allows egress', async () => {
    const cache = join(dir, 'deps')
    const outbox = join(dir, 'outbox', '01RUN')
    const mounts: SandboxSpec['mounts'] = [
      { hostPath: '/src/omni/.git', guestPath: '/mnt/repo.git', readOnly: true },
      { hostPath: '/etc/ns-ca', guestPath: '/etc/ns-ca', readOnly: true },
      { hostPath: cache, guestPath: '/var/cache/nightshift-deps', readOnly: false, cache: true },
    ]
    expect(await sbx.create(spec({ mounts }))).toEqual(h)
    expect(cli.last('create')).toEqual([
      'create',
      '-q',
      '--name',
      'nightshift-01RUN',
      '--cpus',
      '2',
      '-m',
      '4096m',
      '-t',
      'nightshift/omni:1',
      '--pull',
      'missing',
      '-e',
      'LANG=C.UTF-8',
      '-p',
      '4096',
      'shell',
      outbox,
      cache,
      '/src/omni/.git:ro',
      '/etc/ns-ca:ro',
    ])
    expect(JSON.parse(readFileSync(join(outbox, '.labels.json'), 'utf8'))).toEqual({
      run: '01RUN',
      issue: 'FOR-1',
      nightshift: '1',
    })
    const link = cli.last('exec')
    expect(link.slice(0, 6)).toEqual(['exec', '-u', 'root', 'nightshift-01RUN', 'sh', '-c'])
    expect(link[6]).toContain('rm -rf')
    expect(link.slice(7)).toEqual([
      'sh',
      '/src/omni/.git',
      '/mnt/repo.git',
      cache,
      '/var/cache/nightshift-deps',
    ])
    expect(cli.last('policy')).toEqual([
      'policy',
      'allow',
      'network',
      '--sandbox',
      'nightshift-01RUN',
      'gw.test,otel.test:4318',
    ])
    expect(cli.calls.map((c) => c.args[0])).toEqual(['ls', 'create', 'exec', 'policy'])
  })

  test('create with no egress and matching guest paths adds no rule and no link script', async () => {
    await sbx.create(
      spec({
        egress: { allow: [] },
        mounts: [{ hostPath: '/etc/ns-ca', guestPath: '/etc/ns-ca', readOnly: true }],
      }),
    )
    expect(cli.all('policy')).toEqual([])
    expect(cli.all('exec')).toEqual([])
  })

  test('create is idempotent by name and rejects writable mounts', async () => {
    await sbx.create(spec())
    expect(await sbx.create(spec())).toEqual(h)
    expect(cli.all('create')).toHaveLength(1)
    const writable = {
      hostPath: '/x',
      guestPath: '/x',
      readOnly: false,
    } as unknown as SandboxSpec['mounts'][0]
    await expect(sbx.create(spec({ name: '01NEW', mounts: [writable] }))).rejects.toThrow(
      'mounts must be read-only',
    )
  })

  test('create reports a failed sbx create', async () => {
    cli.replies.push((a) => (a[0] === 'create' ? { exitCode: 1, stderr: 'boom\n' } : undefined))
    await expect(sbx.create(spec())).rejects.toThrow('sbx create failed: boom')
  })

  test('a failing egress rule destroys the sandbox and throws', async () => {
    cli.replies.push((a) => (a[0] === 'policy' ? { exitCode: 1, stderr: 'bad host' } : undefined))
    await expect(sbx.create(spec())).rejects.toThrow('bad host')
    expect(cli.last('rm')).toEqual(['rm', '--force', 'nightshift-01RUN'])
    expect(existsSync(join(dir, 'outbox', '01RUN'))).toBe(false)
  })

  test('exec wraps a timeout, passes env by name and maps 124 to timedOut', async () => {
    cli.replies.push(() => ({ exitCode: 124, stdout: 'partial' }))
    const res = await sbx.exec(h, ['make', 'test'], {
      cwd: '/work/omni',
      env: { SECRET: 'v' },
      stdin: 'in',
      timeoutMs: 1_500,
    })
    expect(cli.last('exec')).toEqual([
      'exec',
      '-i',
      '-w',
      '/work/omni',
      '-e',
      'SECRET',
      'nightshift-01RUN',
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

  test('exec writes output over 64 KB to an artifact', async () => {
    const big = Array.from({ length: 5_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
    cli.replies.push(() => ({ stdout: big }))
    const res = await sbx.exec(h, ['cat', 'log'])
    expect(res.stdoutTail.split('\n')).toHaveLength(200)
    expect(res.artifact.startsWith(join(dir, 'artifacts', '01RUN'))).toBe(true)
  })

  test('exec measures the artifact threshold in bytes', async () => {
    cli.replies.push(() => ({ stdout: 'ä'.repeat(40_000) }))
    const res = await sbx.exec(h, ['cat', 'log'])
    expect(res.artifact.startsWith(join(dir, 'artifacts', '01RUN'))).toBe(true)
  })

  test('spawn detaches into the log file and logs tails it', async () => {
    cli.replies.push((a) => (a[0] === 'exec' ? { stdout: '77\n' } : undefined))
    expect(await sbx.spawn(h, ['opencode-worker', 'serve'], { env: { K: 'v' } })).toEqual({
      sandbox: h,
      pid: '77',
    })
    const args = cli.last('exec')
    expect(args.slice(0, 4)).toEqual(['exec', '-e', 'K', 'nightshift-01RUN'])
    expect(args[6]).toBe(`nohup "$@" >>${SBX_LOG} 2>&1 </dev/null & echo $!`)
    expect(args.slice(-2)).toEqual(['opencode-worker', 'serve'])
    const lines: string[] = []
    for await (const l of sbx.logs(h, { follow: true })) lines.push(l)
    expect(lines).toEqual(['line 1'])
    expect(cli.calls.at(-1)?.args).toEqual(['exec', 'nightshift-01RUN', 'tail', '-n', '+1', '-F', SBX_LOG])
    for await (const _ of sbx.logs(h)) break
    expect(cli.calls.at(-1)?.args).toEqual(['exec', 'nightshift-01RUN', 'tail', '-n', '+1', SBX_LOG])
  })

  test('expose returns the loopback URL of a published port', async () => {
    cli.replies.push((a) =>
      a[0] === 'ports'
        ? {
            stdout: JSON.stringify([
              { host_ip: '127.0.0.1', host_port: 49154, sandbox_port: 4096, protocol: 'tcp4' },
            ]),
          }
        : undefined,
    )
    expect(await sbx.expose(h, 4096)).toEqual({ url: 'http://127.0.0.1:49154' })
    expect(cli.last('ports')).toEqual(['ports', 'nightshift-01RUN', '--json'])
    await expect(sbx.expose(h, 9999)).rejects.toThrow('port 9999 is not published for nightshift-01RUN')
  })

  test('attachCommand', () => {
    expect(sbx.attachCommand(h)).toEqual(['sbx', 'exec', '-it', 'nightshift-01RUN', 'bash'])
    expect(sbx.attachCommand(h, ['sh'])).toEqual(['sbx', 'exec', '-it', 'nightshift-01RUN', 'sh'])
  })

  test('exportCommits bundles into the outbox', async () => {
    const outbox = join(dir, 'outbox', '01RUN')
    cli.sandboxes.push({ name: 'nightshift-01RUN', status: 'running', workspaces: [outbox] })
    cli.replies.push((a) => (a.includes('rev-parse') ? { stdout: 'c0ffee\n' } : undefined))
    expect(await sbx.exportCommits(h, '/work/omni', 'ns/FOR-1-1', 'FOR-1: changes')).toEqual({
      bundle: join(outbox, '01RUN.bundle'),
      headSha: 'c0ffee',
    })
    const execs = cli.all('exec').map((a) => a.slice(2))
    expect(execs[0]?.slice(0, 2)).toEqual(['sh', '-c'])
    expect(execs[1]).toEqual([
      'git',
      '-C',
      '/work/omni',
      'bundle',
      'create',
      join(outbox, '01RUN.bundle'),
      'ns/FOR-1-1',
    ])
  })

  test('list filters prefixed sandboxes by their labels file; status reads ls', async () => {
    const box = (n: string, labels?: Record<string, string>) => {
      const p = join(dir, 'outbox', n)
      mkdirSync(p, { recursive: true })
      if (labels) writeFileSync(join(p, '.labels.json'), JSON.stringify(labels))
      return p
    }
    cli.sandboxes.push(
      { name: 'nightshift-A', status: 'running', workspaces: [box('A', { nightshift: '1', gate: 'g1' })] },
      { name: 'nightshift-B', status: 'stopped', workspaces: [box('B', { nightshift: '1', gate: 'g2' })] },
      { name: 'nightshift-C', status: 'running', workspaces: [box('C')] },
      { name: 'other-D', status: 'running', workspaces: [box('D', { nightshift: '1', gate: 'g1' })] },
    )
    expect(await sbx.list({ gate: 'g1' })).toEqual([{ driver: 'sbx', id: 'nightshift-A', name: 'A' }])
    expect((await sbx.list({ nightshift: '1' })).map((x) => x.name)).toEqual(['A', 'B'])
    expect(await sbx.status({ driver: 'sbx', id: 'nightshift-A', name: 'A' })).toBe('running')
    expect(await sbx.status({ driver: 'sbx', id: 'nightshift-B', name: 'B' })).toBe('stopped')
    expect(await sbx.status(h)).toBe('gone')
  })

  test('destroy forces removal, removes the outbox and treats not found as success', async () => {
    await sbx.create(spec())
    const outbox = join(dir, 'outbox', '01RUN')
    expect(existsSync(outbox)).toBe(true)
    await sbx.destroy(h)
    expect(cli.last('rm')).toEqual(['rm', '--force', 'nightshift-01RUN'])
    expect(existsSync(outbox)).toBe(false)
    cli.replies.push((a) =>
      a[0] === 'rm' ? { exitCode: 1, stderr: "error: sandbox 'nightshift-01RUN' not found" } : undefined,
    )
    await sbx.destroy(h)
    cli.replies = [(a) => (a[0] === 'rm' ? { exitCode: 1, stderr: 'daemon down' } : undefined)]
    await expect(sbx.destroy(h)).rejects.toThrow('sbx rm failed: daemon down')
  })

  test('destroy removes the outbox of a sandbox that is already gone, also after a restart', async () => {
    await sbx.create(spec())
    const outbox = join(dir, 'outbox', '01RUN')
    cli.sandboxes = []
    cli.replies.push((a) =>
      a[0] === 'rm' ? { exitCode: 1, stderr: "error: sandbox 'nightshift-01RUN' not found" } : undefined,
    )
    await new SbxSandbox({ cli, artifactsDir: join(dir, 'artifacts') }).destroy(h)
    expect(existsSync(outbox)).toBe(false)
  })
})
