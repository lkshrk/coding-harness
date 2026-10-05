import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeProfile, GatewayError, loadAgents, runSingleCall, WORKER_BLOCKS } from '@nightshift/core'
import { type CommandResult, type DockerCli, OpenCodeDriver } from '../adapters/worker'
import { FakeSandboxDriver } from '../adapters/worker/testing'
import type { HarnessEvent, WorkerDriver, WorkerStart } from '../ports'
import { coveredIssues, setCovered } from '../state/coverage'
import { openState, statePath } from '../state/db'
import { FakeLinear, snapshot, testConfig } from '../testing/testing'
import {
  composeSupervisor,
  gatewaySingleCall,
  gitRepos,
  hostSkills,
  logNotifier,
  outboxDirs,
  skillFiles,
} from './compose'

const ROOT = join(import.meta.dir, '..', '..', '..', '..')

describe('gateway single calls', () => {
  const { agents } = loadAgents(join(ROOT, 'agents'), {
    externalSkills: [...hostSkills(join(ROOT, 'agents')), 'wiki-ingest'],
  })
  const def = agents.get('context-selector')
  if (!def) throw new Error('selector missing')
  const options = {
    profile: { name: 'default', profile: { roles: { selector: 'ns/small' }, models: {} } },
    gateway: { baseUrl: 'http://gateway.test/v1', apiKey: 'host-key' },
  }

  test('failed gateway calls, invalid model output, and token-counter successes report reachability', async () => {
    const observed: boolean[] = []
    let mode = 'error'
    const call = gatewaySingleCall(runSingleCall, (ok) => observed.push(ok))
    const opts = {
      ...options,
      gateway: {
        ...options.gateway,
        fetch: async (url: string) => {
          if (mode === 'error') return new Response('offline', { status: 503 })
          if (url.includes('token_counter'))
            return Response.json({ total_tokens: mode === 'over-budget' ? 1e9 : 1 })
          return Response.json({
            choices: [{ message: { content: mode === 'invalid' ? 'not JSON' : '{"files":[],"pages":[]}' } }],
          })
        },
      },
    }
    expect((await call(def, 'input', opts)).ok).toBe(false)
    mode = 'invalid'
    expect((await call(def, 'input', opts)).ok).toBe(false)
    mode = 'over-budget'
    expect((await call(def, 'input', opts)).ok).toBe(false)
    mode = 'valid'
    expect((await call(def, 'input', opts)).ok).toBe(true)
    expect(observed).toEqual([false, true, true, true])
  })

  test('unrelated exceptions and local budget rejection do not change reachability', async () => {
    const observed: boolean[] = []
    const notify = (ok: boolean) => observed.push(ok)
    const local = gatewaySingleCall(
      async () => ({ ok: false, reason: 'input_over_budget', detail: 'local check' }),
      notify,
    )
    await local(def, 'input', options)
    for (const error of [new Error('configuration error'), new GatewayError('offline')]) {
      const call = gatewaySingleCall(async () => {
        throw error
      }, notify)
      await expect(call(def, 'input', options)).rejects.toThrow(error.message)
    }
    expect(observed).toEqual([false])
  })
})

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString().trim()
}

function originWithCheckout(root: string): string {
  const origin = join(root, 'origin')
  mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one')
  const checkout = join(root, 'checkout')
  git(root, 'clone', '-q', origin, checkout)
  return checkout
}

class RecordingWorker implements WorkerDriver {
  readonly harness = 'opencode' as const
  readonly starts: WorkerStart[] = []

  async start(w: WorkerStart) {
    this.starts.push(w)
    return { id: 'ses_1', attach: [] }
  }

  async *events(): AsyncIterable<HarnessEvent> {
    await new Promise(() => {})
  }

  async send() {}
  async stop() {}
  async alive() {
    return true
  }
}

class RecordingDocker implements DockerCli {
  readonly calls: string[][] = []

  async run(args: string[]): Promise<CommandResult> {
    this.calls.push(args)
    const reply =
      args[0] === 'inspect' ? { exitCode: 1 } : args[0] === 'run' ? { stdout: 'c0ffee00c0ffee\n' } : {}
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, ...reply }
  }

  async *lines(): AsyncIterable<string> {}
}

const testImages = async () => ({ image: 'registry.test/worker:7', lsp: {}, egress: [], stacks: ['bun'] })

describe('coverage', () => {
  test('covered issues round-trip through the state database', () => {
    const db = openState(':memory:')
    expect(coveredIssues(db)).toEqual([])
    setCovered(db, 'FOR-1', true)
    setCovered(db, 'FOR-2', true)
    setCovered(db, 'FOR-1', true)
    expect(coveredIssues(db)).toEqual(['FOR-1', 'FOR-2'])
    setCovered(db, 'FOR-1', false)
    expect(coveredIssues(db)).toEqual(['FOR-2'])
  })
})

describe('gitRepos', () => {
  test('baseSha fetches the remote and returns the tip of the configured base branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ns-repos-'))
    try {
      const checkout = originWithCheckout(root)
      const origin = join(root, 'origin')
      git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two')
      const tip = git(origin, 'rev-parse', 'HEAD')
      const base = testConfig()
      const config = {
        ...base,
        repositories: { omni: { ...base.repositories.omni, path: checkout, remote: 'origin', base: 'main' } },
      } as typeof base
      expect(await gitRepos(() => config).baseSha('omni')).toBe(tip)
      await expect(gitRepos(() => config).baseSha('nope')).rejects.toThrow("no repository 'nope'")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('outboxDirs', () => {
  test('lists run directories and removes one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-outbox-'))
    try {
      mkdirSync(join(dir, 'run-a'))
      mkdirSync(join(dir, 'run-b'))
      const outbox = outboxDirs(dir)
      expect(outbox.list().sort()).toEqual(['run-a', 'run-b'])
      outbox.remove('run-a')
      expect(existsSync(join(dir, 'run-a'))).toBe(false)
      expect(outboxDirs(join(dir, 'missing')).list()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('logNotifier', () => {
  test('writes the notification and reports no external channel', async () => {
    const lines: string[] = []
    expect(
      await logNotifier((l) => lines.push(l)).notify({ title: 'FOR-1 needs you', issue: 'FOR-1' }),
    ).toBeNull()
    expect(lines).toEqual(['notify: FOR-1 needs you (FOR-1)'])
  })
})

describe('composeSupervisor', () => {
  test('wires the classifier and records its class without fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-classify-'))
    const config = testConfig()
    config.paths.state = join(dir, 'state')
    config.paths.cache = join(dir, 'cache')
    activeProfile(config.profiles).profile.roles.classifier = 'ns/reviewer'
    const linear = new FakeLinear(config, () => new Date())
    linear.put(snapshot({ identifier: 'FOR-1', status: 'In Progress' }))
    const called: string[] = []
    const composed = await composeSupervisor({
      config,
      root: ROOT,
      linear,
      sandbox: new FakeSandboxDriver(),
      worker: new RecordingWorker(),
      finishPlugin: '// plugin',
      out: () => {},
      env: { NS_GATEWAY_KEY: 'host-key' },
      singleCall: (def, input, opts) => {
        called.push(def.name)
        expect(input).toContain('unexpected crash')
        return runSingleCall(def, input, {
          ...opts,
          gateway: {
            ...opts.gateway,
            fetch: async (url) =>
              Response.json(
                url.endsWith('/utils/token_counter')
                  ? { total_tokens: 100 }
                  : {
                      choices: [
                        {
                          message: {
                            content: JSON.stringify({
                              class: 'architectural_conflict',
                              evidence: 'contradictory interface',
                            }),
                          },
                        },
                      ],
                    },
              ),
          },
        })
      },
    })
    try {
      const run = composed.supervisor.runs.create({
        issue: 'FOR-1',
        agent: 'implementer',
        profile: 'default',
        model: 'worker',
        repository: 'omni',
        baseSha: 'base',
        attempt: 1,
      })
      await composed.supervisor.workerFailed(run.id, 'crash', 'unexpected crash')
      expect(called).toEqual(['classifier'])
      expect(composed.supervisor.log.since(null, { types: ['FAILURE_CLASSIFIED'] })[0]?.data).toEqual({
        class: 'architectural_conflict',
        evidence: 'contradictory interface',
        action: 'escalate_lead',
        fallback: false,
      })
    } finally {
      composed.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('wires a supervisor that starts, holds the state lock and releases it on close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-compose-'))
    try {
      const base = testConfig()
      const config = {
        ...base,
        paths: { ...base.paths, state: join(dir, 'state'), cache: join(dir, 'cache') },
      }
      const fakes = () => {
        const sandbox = new FakeSandboxDriver()
        return {
          linear: new FakeLinear(config, () => new Date()),
          sandbox,
          worker: new OpenCodeDriver({ sandbox }),
        }
      }
      const opts = {
        config,
        root: ROOT,
        finishPlugin: '// plugin',
        out: () => {},
        ...fakes(),
      }
      const first = await composeSupervisor(opts)
      await first.supervisor.start()
      expect(first.supervisor.config).toBe(config)
      await expect(composeSupervisor({ ...opts, ...fakes() })).rejects.toThrow(
        'another nightshift supervisor holds',
      )
      expect(existsSync(join(dir, 'state', 'state.db'))).toBe(true)
      expect(existsSync(join(dir, 'state', 'state.db.lock'))).toBe(true)
      first.close()
      expect(existsSync(join(dir, 'state', 'state.db.lock'))).toBe(false)
      const second = await composeSupervisor({ ...opts, ...fakes() })
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a dispatch creates a Docker container from the repository image with the OpenCode port published', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-compose-'))
    try {
      const base = testConfig()
      const config = {
        ...base,
        paths: { ...base.paths, state: join(dir, 'state'), cache: join(dir, 'cache') },
        repositories: { omni: { ...base.repositories.omni, path: originWithCheckout(dir) } },
      } as typeof base
      const linear = new FakeLinear(config, () => new Date())
      linear.put(snapshot({ identifier: 'FOR-1' }))
      const docker = new RecordingDocker()
      const composed = await composeSupervisor({
        config,
        root: ROOT,
        env: { NS_GATEWAY_KEY: 'test-key', NS_WORKER_KEY: 'worker-key' },
        finishPlugin: '// plugin',
        out: () => {},
        linear,
        docker,
        countTokens: async (text) => text.length,
        images: testImages,
        gitAuth: async () => ({}),
      })
      try {
        await composed.supervisor.start()
        expect((await composed.supervisor.tick()).dispatched).toEqual(['FOR-1'])
        const index = docker.calls.find((a) => a[0] === 'run' && a.includes('index_repository')) ?? []
        expect(index.slice(1, 5)).toEqual(['--rm', '--network', 'none', '--user'])
        expect(index).toContain('registry.test/worker:7')
        const run = docker.calls.find((a) => a[0] === 'run' && !a.includes('index_repository')) ?? []
        expect(run.join(' ')).toContain('--publish 127.0.0.1::4096')
        expect(run.slice(-3)).toEqual(['registry.test/worker:7', 'sleep', 'infinity'])
        const sent = docker.calls.map((a) => a.join(' ')).join('\n')
        expect(sent).not.toContain('test-key')
      } finally {
        composed.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a dispatched run's task message holds the seven context fences in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-compose-'))
    try {
      const base = testConfig()
      const config = {
        ...base,
        paths: { ...base.paths, state: join(dir, 'state'), cache: join(dir, 'cache') },
        repositories: { omni: { ...base.repositories.omni, path: originWithCheckout(dir) } },
      } as typeof base
      const linear = new FakeLinear(config, () => new Date())
      linear.put(snapshot({ identifier: 'FOR-1' }))
      const worker = new RecordingWorker()
      const sandbox = new FakeSandboxDriver()
      const counted: string[] = []
      const composed = await composeSupervisor({
        config,
        root: ROOT,
        env: { NS_GATEWAY_KEY: 'test-key', NS_WORKER_KEY: 'worker-key' },
        finishPlugin: '// plugin',
        out: () => {},
        linear,
        sandbox,
        worker,
        images: testImages,
        gitAuth: async () => ({}),
        countTokens: async (text, model) => {
          counted.push(model)
          return text.length
        },
      })
      try {
        await composed.supervisor.start()
        expect((await composed.supervisor.tick()).dispatched).toEqual(['FOR-1'])
        expect(worker.starts[0]?.gateway.apiKey).toBe('worker-key')
        expect(JSON.stringify(worker.starts)).not.toContain('test-key')
        expect(JSON.stringify(sandbox.created)).not.toContain('test-key')
        expect(JSON.stringify(sandbox.execs)).not.toContain('test-key')
        expect(JSON.stringify(sandbox.spawns)).not.toContain('test-key')
        expect(JSON.stringify([...sandbox.files])).not.toContain('test-key')
        const message = worker.starts[0]?.taskMessage ?? ''
        const fences = message.split('\n').filter((l) => /^--- (BEGIN|END) [A-Z]+ ---$/.test(l))
        expect(fences).toEqual(WORKER_BLOCKS.flatMap((n) => [`--- BEGIN ${n} ---`, `--- END ${n} ---`]))
        expect(message).toContain('FOR-1: issue FOR-1')
        expect(message).toContain('## src/a.ts\nNew file: not in the base commit.')
        expect(new Set(counted)).toEqual(new Set([worker.starts[0]?.model as string]))
        const run = composed.supervisor.runs.active()[0]
        const summary = JSON.parse(
          readFileSync(join(dir, 'state', 'artifacts', run?.id ?? '', 'context.json'), 'utf8'),
        )
        expect(summary.sections.map((x: { name: string }) => x.name)).toEqual([...WORKER_BLOCKS])
      } finally {
        composed.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('statePath', () => {
  test('is <paths.state>/state.db with ~ expanded', () => {
    const config = { paths: { ...testConfig().paths, state: '~/.local/state/nightshift' } }
    expect(statePath(config, '/home/u')).toBe('/home/u/.local/state/nightshift/state.db')
  })
})

describe('hostSkills', () => {
  test('lists the skills of interactive agents only', () => {
    const skills = hostSkills(join(ROOT, 'agents'))
    expect(skills).toContain('linear')
    expect(skills).not.toContain('lean-build')
  })
})

describe('skillFiles', () => {
  test("reads every file of the repository's skill folder with relative paths", () => {
    const files = skillFiles(join(import.meta.dir, '../../../../skills/surgical-patch'))
    expect(files.map((f) => f.path)).toContain('SKILL.md')
    expect(files.find((f) => f.path === 'SKILL.md')?.content).toContain('surgical')
    expect(skillFiles(join(import.meta.dir, 'no-such-skill'))).toEqual([])
  })
})
