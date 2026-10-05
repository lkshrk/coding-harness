import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Config, NIGHTSHIFT_VERSION, type RepoImage } from '@nightshift/core'
import {
  openState,
  type SandboxHandle,
  type SandboxSpec,
  setCovered,
  statePath,
} from '@nightshift/supervisor'
import type { ControlFn } from './client'
import { COMMAND_HELP } from './commands'
import { type CliDeps, run } from './run'

async function capture(args: string[], deps: CliDeps = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(args, { out: (s) => out.push(s), err: (s) => err.push(s) }, deps)
  return { code, out, err }
}

test('--version prints the version and exits 0', async () => {
  expect(await capture(['--version'])).toEqual({
    code: 0,
    out: [`nightshift ${NIGHTSHIFT_VERSION}`],
    err: [],
  })
})

test.each(['frobnicate', 'constructor', 'toString'])(
  'unknown command %s exits 2 with a usage error',
  async (command) => {
    const r = await capture([command])
    expect(r.code).toBe(2)
    expect(r.err).toEqual([`unknown command: ${command}`, 'run ns help'])
  },
)

describe('help', () => {
  const noWork: CliDeps = {
    load: () => {
      throw new Error('help must not load config')
    },
    exec: async () => {
      throw new Error('help must not execute commands')
    },
    control: async () => {
      throw new Error('help must not contact the supervisor')
    },
    env: { NS_HOST: 'remote' },
  }

  test.each(['--help', '-h', 'help'])('%s lists every command and a description', async (flag) => {
    const r = await capture([flag], noWork)
    expect(r.code).toBe(0)
    expect(r.err).toEqual([])
    for (const [command, entry] of Object.entries(COMMAND_HELP)) {
      expect(r.out).toContain(`  ${command.padEnd(12)} ${entry.description}`)
    }
  })

  test.each(Object.keys(COMMAND_HELP))('prints %s usage through both help forms', async (command) => {
    const usage = COMMAND_HELP[command]?.usage as string
    const expected = { code: 0, out: [usage.startsWith('usage: ') ? usage : `usage: ${usage}`], err: [] }
    expect(await capture(['help', command], noWork)).toEqual(expected)
    expect(await capture([command, '--help'], noWork)).toEqual(expected)
  })

  test('help takes precedence over remote routing and global flags', async () => {
    const r = await capture(['--host', 'example', '--json', '--config', '/missing', 'tail', '--help'], noWork)
    expect(r).toEqual({ code: 0, out: ['usage: ns tail <issue> [--follow-issue]'], err: [] })
  })

  test.each([
    ['help', 'missing'],
    ['missing', '--help'],
  ])('unknown help target %j exits 2', async (first, second) => {
    expect(await capture([first, second], noWork)).toEqual({
      code: 2,
      out: [],
      err: ['unknown command: missing', 'run ns help'],
    })
  })
})

describe('state commands', () => {
  const withState = async (fn: (dbPath: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-cli-'))
    try {
      await fn(join(dir, 'state.db'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('implement and release go through the control socket, never the database', async () => {
    const calls: unknown[][] = []
    const control = (async (path: string, method: string, route: string, body?: unknown) => {
      calls.push([path, method, route, body])
      return { ok: true }
    }) as ControlFn
    const deps: CliDeps = { socketPath: () => '/run/ns.sock', control, confirm: async () => true }
    expect((await capture(['implement', 'ROU-670'], deps)).code).toBe(0)
    const r = await capture(['release', 'ROU-670'], deps)
    expect(r).toMatchObject({ code: 0, out: ['ROU-670 is no longer covered'] })
    expect(calls).toEqual([
      ['/run/ns.sock', 'POST', '/cover', { issue: 'ROU-670', covered: true }],
      ['/run/ns.sock', 'POST', '/cover', { issue: 'ROU-670', covered: false }],
    ])
    const declined = await capture(['implement', 'ROU-671'], { ...deps, confirm: async () => false })
    expect(declined.code).toBe(1)
    expect(calls.length).toBe(2)
  })

  test('implement without an issue is a usage error', async () => {
    const r = await capture(['implement'])
    expect(r.code).toBe(2)
    expect(r.err).toEqual(['usage: ns implement <issue>'])
  })

  test('status with the supervisor down shows the last known state and exits 0', async () => {
    await withState(async (dbPath) => {
      const db = openState(dbPath)
      setCovered(db, 'ROU-670', true)
      db.close()
      const r = await capture(['status'], { statePath: () => dbPath, socketPath: () => `${dbPath}.sock` })
      expect(r.code).toBe(0)
      expect(r.out[0]).toBe('supervisor not running')
      expect(r.out).toContain('dispatch: running  gateway: unknown')
      expect(r.out).toContain('workers: none')
      expect(r.out).toContain('covered: ROU-670')
    })
  })

  test('status reads the state database the supervisor writes under paths.state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-cli-'))
    try {
      const config = { paths: { state: dir, cache: dir, vault: dir } } as Config
      const db = openState(statePath(config))
      setCovered(db, 'ROU-672', true)
      db.close()
      const r = await capture(['status'], { load: () => ({ ok: true, config, sources: [] }) })
      expect(r.code).toBe(0)
      expect(r.out).toContain('covered: ROU-672')
      expect(statePath(config)).toBe(join(dir, 'state.db'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('supervise reports config errors and exits 1', async () => {
  const r = await capture(['supervise'], {
    load: () => ({ ok: false, errors: [{ path: 'linear.auth', message: 'missing' }] }),
  })
  expect(r.code).toBe(1)
  expect(r.err).toEqual(['config: linear.auth: missing'])
})

describe('doctor', () => {
  test('is routed and reports config errors as findings', async () => {
    const r = await capture(['doctor'], {
      load: () => ({ ok: false, errors: [{ path: 'linear.auth', message: 'missing' }] }),
    })
    expect(r).toEqual({ code: 1, out: ['error: linear.auth: missing'], err: [] })
  })

  test.each(['--force', '--yes', '--apply extra'])('rejects %p with exit 2', async (flags) => {
    const r = await capture(['doctor', ...flags.split(' ')])
    expect(r.code).toBe(2)
    expect(r.err).toEqual(['usage: ns doctor [--apply] [--yes] [--json]'])
  })
})

describe('env', () => {
  const config = {
    paths: { state: '/s', cache: '/c', vault: '/v' },
    sandbox: { driver: 'docker', resources: { cpus: 2, memory: '4g' } },
    repositories: { web: { path: '/src/web', remote: 'origin', base: 'main', stacks: 'auto', checks: [] } },
  } as unknown as Config
  const image: RepoImage = {
    repo: 'web',
    tag: 'nightshift/env-web:0123456789ab',
    hash: '0123456789ab',
    imageId: 'sha256:x',
    stacks: ['node'],
    builtAt: '2026-10-04T00:00:00Z',
  }
  const builder = (current: RepoImage | undefined) => {
    const calls: string[] = []
    return {
      calls,
      deps: {
        load: () => ({ ok: true as const, config, sources: [] }),
        fetch: () => 'abcdef0123456789',
        gitAuth: async () => ({}),
        envBuilder: () => ({
          current: async () => current,
          build: async (_repo: string, o?: { log?: (l: string) => void }) => {
            calls.push('build')
            o?.log?.('building')
            return image
          },
          ensure: async () => {
            calls.push('ensure')
            return image
          },
        }),
      },
    }
  }

  test('build prints the tag and stacks', async () => {
    const b = builder(undefined)
    const r = await capture(['env', 'build', 'web'], b.deps)
    expect(r).toEqual({
      code: 0,
      out: ['nightshift/env-web:0123456789ab (stacks: node) built'],
      err: ['building'],
    })
  })

  test('build reuses an up-to-date image', async () => {
    const b = builder(image)
    const r = await capture(['env', 'build', 'web'], b.deps)
    expect(r.out).toEqual(['nightshift/env-web:0123456789ab (stacks: node) up to date'])
    expect(b.calls).toEqual([])
  })

  test('an unknown repository exits 4', async () => {
    const r = await capture(['env', 'build', 'nope'], builder(undefined).deps)
    expect(r).toEqual({ code: 4, out: [], err: ["unknown repository 'nope'"] })
  })

  test.each(['env', 'env build', 'env rebuild web', 'env build web x'])(
    '%p is a usage error',
    async (line) => {
      const r = await capture(line.split(' '), builder(undefined).deps)
      expect(r).toEqual({ code: 2, out: [], err: ['usage: ns env build|shell <repo>'] })
    },
  )

  test('a build failure exits 1', async () => {
    const b = builder(undefined)
    const deps = {
      ...b.deps,
      envBuilder: () => ({
        current: async () => undefined,
        build: async () => {
          throw new Error('image build failed for web: boom')
        },
        ensure: async () => image,
      }),
    }
    const r = await capture(['env', 'build', 'web'], deps)
    expect(r).toEqual({ code: 1, out: [], err: ['env build: image build failed for web: boom'] })
  })

  test('shell clones <remote>/<base> into a throwaway sandbox and destroys it', async () => {
    const b = builder(image)
    const sandbox = new FakeSandbox()
    const attached: string[][] = []
    const r = await capture(['env', 'shell', 'web'], {
      ...b.deps,
      home: '/home/me',
      sandbox: () => sandbox,
      attach: async (cmd) => {
        attached.push(cmd)
        return 0
      },
    })
    expect(r.code).toBe(0)
    expect(b.calls).toEqual(['ensure'])
    const spec = sandbox.specs[0] as SandboxSpec
    expect(spec.image).toBe(image.tag)
    expect(spec.mounts).toEqual([{ hostPath: '/src/web/.git', guestPath: '/mnt/repo.git', readOnly: true }])
    expect(sandbox.execs[0]?.slice(-3)).toEqual(['/mnt/repo.git', '/work/web', 'abcdef0123456789'])
    expect(attached[0]).toEqual(['attach', 'sh', '-c', 'cd /work/web && exec bash'])
    expect(sandbox.destroyed).toBe(1)
  })
})

class FakeSandbox {
  specs: SandboxSpec[] = []
  execs: string[][] = []
  destroyed = 0
  capabilities() {
    return { nestedDocker: false, egressPolicy: false, credentialInjection: false }
  }
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.specs.push(spec)
    return { driver: 'docker', id: 'c1', name: spec.name }
  }
  async status() {
    return 'running' as const
  }
  async exec(_h: SandboxHandle, cmd: string[]) {
    this.execs.push(cmd)
    return { exitCode: 0, durationMs: 1, stdoutTail: '', stderrTail: '', artifact: '', timedOut: false }
  }
  async spawn(h: SandboxHandle) {
    return { sandbox: h, pid: '1' }
  }
  async expose() {
    return { url: '' }
  }
  attachCommand(_h: SandboxHandle, shell: string[] = []) {
    return ['attach', ...shell]
  }
  async *logs() {}
  async exportCommits() {
    return { bundle: '', headSha: '' }
  }
  async list() {
    return []
  }
  async destroy() {
    this.destroyed++
  }
}
