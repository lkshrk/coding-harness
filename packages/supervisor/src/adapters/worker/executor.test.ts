import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Config } from '@nightshift/core'
import type { BuiltContext, HarnessEvent, WorkerDriver, WorkerSession, WorkerStart } from '../../ports'
import { git, gitFixture } from '../../stages/gates/testing'
import type { Run } from '../../state/runs'
import { snapshot, testConfig } from '../../testing/testing'
import { runRef } from '../git/host'
import { Channel } from './channel'
import {
  GRACE_MESSAGE,
  parseDuration,
  parseTokens,
  shellJoin,
  type WorkerCallbacks,
  WorkerExecutor,
} from './executor'
import { FakeSandboxDriver } from './testing'

type Repo = Config['repositories'][string]

class FakeWorker implements WorkerDriver {
  readonly harness = 'opencode' as const
  readonly starts: WorkerStart[] = []
  readonly sent: string[] = []
  readonly stopped: string[] = []
  stream = new Channel<HarnessEvent>()

  async start(w: WorkerStart): Promise<WorkerSession> {
    this.starts.push(w)
    return { id: 'ses_1', attach: ['docker', 'exec', '-it', 'ctr', 'sh', '-c', 'opencode attach'] }
  }

  events(): AsyncIterable<HarnessEvent> {
    return this.stream
  }

  async send(_s: WorkerSession, message: string): Promise<void> {
    this.sent.push(message)
  }

  async stop(_s: WorkerSession, reason: string): Promise<void> {
    this.stopped.push(reason)
  }

  async alive(): Promise<boolean> {
    return true
  }
}

class Callbacks implements WorkerCallbacks {
  readonly calls: [string, ...unknown[]][] = []

  async sandboxCreated(runId: string, info: unknown) {
    this.calls.push(['sandbox', runId, info])
  }
  async workerStarted(runId: string, info: unknown) {
    this.calls.push(['started', runId, info])
  }
  async workerStalled(runId: string, signal: string, detail?: string) {
    this.calls.push(['stalled', runId, signal, detail])
  }
  async workerFinished(runId: string, payload: unknown) {
    this.calls.push(['finished', runId, payload])
  }
  async workerFailed(runId: string, reason: string, detail?: string) {
    this.calls.push(['failed', runId, reason, detail])
  }
  async workerProgress(runId: string, progress: unknown) {
    this.calls.push(['progress', runId, progress])
  }
  async wipCommitted(runId: string, info: unknown) {
    this.calls.push(['wip', runId, info])
  }

  of(kind: string) {
    return this.calls.filter((c) => c[0] === kind)
  }
}

const fixer: AgentDef = {
  name: 'fixer',
  file: 'agents/fixer.md',
  kind: 'worker',
  role: 'worker',
  description: 'Fixes one bug.',
  body: 'Fixes one reported bug.',
  skills: [],
  reasoning: 'json_only',
  budget: { promptWords: 600, inputTokens: 16_000 },
  graceTurns: 1,
  opencode: { steps: 80, permission: { '*': 'allow' } },
}

const run: Run = {
  id: '01JRUN0000000000000000000A',
  issue: 'FOR-1',
  agent: 'fixer',
  profile: 'default',
  model: 'ns/worker',
  repository: 'omni',
  baseSha: 'base1',
  attempt: 1,
  state: 'starting',
  sandbox: null,
  session: null,
  headSha: null,
  finish: null,
  failure: null,
  startedAt: new Date(0).toISOString(),
  endedAt: null,
  tokensIn: 0,
  tokensOut: 0,
}

const built: BuiltContext = {
  message: '--- BEGIN ISSUE ---\nfix\n--- END ISSUE ---',
  tokens: 12,
  sections: [{ name: 'ISSUE', tokens: 3, sources: ['FOR-1'], truncated: false }],
}

let config: Config
let state: string
let sandbox: FakeSandboxDriver
let worker: FakeWorker
let cb: Callbacks
let clock: number
let steps: Run[]

function executor(over: Partial<ConstructorParameters<typeof WorkerExecutor>[0]> = {}) {
  const ex = new WorkerExecutor({
    config,
    sandbox,
    worker,
    agents: new Map([['fixer', fixer]]),
    finishPlugin: 'export default {}',
    image: async () => ({
      image: 'nightshift/omni:1',
      lsp: { typescript: { command: ['typescript-language-server', '--stdio'], extensions: ['.ts'] } },
      egress: ['registry.npmjs.org'],
      stacks: ['node'],
    }),
    taskMessage: async () => built,
    gatewayKey: async () => 'sk-run',
    runStep: async (r) => {
      steps.push(r)
    },
    home: '/home/me',
    tickMs: 5,
    now: () => clock,
    ...over,
  })
  ex.bind(cb)
  return ex
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) await Bun.sleep(2)
  expect(pred()).toBe(true)
}

const step: HarnessEvent = { kind: 'step', step: 1, tokensIn: 10, tokensOut: 1 }
const read: HarnessEvent = { kind: 'tool_call', tool: 'read', argsDigest: 'a' }

async function started(over: Parameters<typeof executor>[0] = {}) {
  const ex = executor(over)
  await ex.start({ run, issue: snapshot({ identifier: 'FOR-1' }), files: ['src/a.ts'] })
  return ex
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'ns-executor-'))
  config = testConfig()
  config = { ...config, paths: { ...config.paths, state } }
  sandbox = new FakeSandboxDriver()
  worker = new FakeWorker()
  cb = new Callbacks()
  clock = 0
  steps = []
})

afterEach(() => {
  rmSync(state, { recursive: true, force: true })
})

describe('WorkerExecutor.start', () => {
  test('copies supplied raw sources after clone without shell interpolation and skips ingest graph', async () => {
    const ingest = { ...run, agent: 'ingester' }
    let graphs = 0
    const ex = executor({
      agents: new Map([['ingester', { ...fixer, name: 'ingester' }]]),
      codeGraph: async () => {
        graphs++
        return '/index'
      },
    })
    const content = 'untrusted $(touch /tmp/injected) `echo secret`\n'
    await ex.start({
      run: ingest,
      issue: snapshot({ identifier: 'FOR-1' }),
      files: ['raw/linear/source.md'],
      sourceFiles: [{ path: 'raw/linear/source.md', content }],
    })
    expect(graphs).toBe(0)
    expect(sandbox.created[0]?.env).toEqual({})
    expect(sandbox.files.get('/work/omni/raw/linear/source.md')).toBe(content)
    expect(sandbox.execs[0]?.cmd[2]).toContain('git clone')
    expect(sandbox.execs[1]?.cmd.join(' ')).not.toContain(content)
  })

  test('an ingest run mounts the source repository git dir read-only for the vault path lint', async () => {
    const ex = executor({ agents: new Map([['ingester', { ...fixer, name: 'ingester' }]]) })
    await ex.start({
      run: { ...run, agent: 'ingester' },
      issue: snapshot({ identifier: 'FOR-1' }),
      files: [],
      knowledgeRepo: 'omni',
    })
    expect(sandbox.created[0]?.mounts).toContainEqual({
      hostPath: '/tmp/omni/.git',
      guestPath: '/mnt/knowledge-source.git',
      readOnly: true,
    })
    expect(sandbox.created[0]?.env).toEqual({ KNOWLEDGE_REPOS: '/tmp/knowledge-repos' })
    const pin = sandbox.execs.find((e) => e.cmd[2]?.includes('--bare --shared'))
    expect(pin?.cmd.slice(4)).toEqual([
      '/mnt/knowledge-source.git',
      '/tmp/knowledge-repos/omni',
      `refs/remotes/${config.repositories.omni?.remote}/${config.repositories.omni?.base}`,
    ])
  })

  test("sends the context builder's message as the task message and stores its section summary", async () => {
    const budgets: unknown[] = []
    await started({
      taskMessage: async (s, budget) => {
        budgets.push([s.issue.identifier, s.files, budget])
        return built
      },
    })
    expect(budgets).toEqual([
      ['FOR-1', ['src/a.ts'], { inputTokens: fixer.budget.inputTokens, model: 'ns/worker' }],
    ])
    expect(worker.starts[0]?.taskMessage).toBe(built.message)
    expect(JSON.parse(readFileSync(join(state, 'artifacts', run.id, 'context.json'), 'utf8'))).toEqual({
      tokens: 12,
      sections: built.sections,
    })
  })

  test('a context build failure creates no sandbox', async () => {
    const ex = executor({
      taskMessage: async () => {
        throw new Error("issue too large for the agent's budget")
      },
    })
    await expect(ex.start({ run, issue: snapshot({ identifier: 'FOR-1' }), files: [] })).rejects.toThrow(
      'issue too large',
    )
    expect(sandbox.created).toEqual([])
    expect(worker.starts).toEqual([])
  })

  test('creates the sandbox, clones the workspace, renders the agent and starts the worker', async () => {
    await started()
    expect(sandbox.created).toEqual([
      {
        name: run.id,
        image: 'nightshift/omni:1',
        resources: { cpus: 4, memoryMb: 8192 },
        outbox: `/tmp/ns/cache/outbox/${run.id}`,
        mounts: [{ hostPath: '/tmp/omni/.git', guestPath: '/mnt/repo.git', readOnly: true }],
        env: {},
        egress: { allow: ['gateway.test', 'registry.npmjs.org'] },
        workdir: '/work',
        labels: { nightshift: '1', run: run.id, issue: 'FOR-1' },
      },
    ])
    const prepare = sandbox.execs[0]?.cmd ?? []
    expect(prepare[2]).toContain('clone --quiet --shared')
    expect(prepare.slice(4)).toEqual(['/mnt/repo.git', '/work/omni', 'ns/FOR-1-1', 'base1'])
    const [w] = worker.starts
    expect(w?.agent.files.map((f) => f.path)).toEqual([
      'agent/fixer.md',
      'plugins/nightshift-finish/package.json',
      'plugins/nightshift-finish/index.js',
      'opencode.json',
    ])
    expect(w?.agent.files[0]?.content).toContain('model: litellm/ns/worker')
    expect(JSON.parse(w?.agent.files[3]?.content ?? '{}')).toEqual({
      plugins: [
        { package: '/tmp/nightshift/config/opencode/plugins/nightshift-finish', options: { outputs: {} } },
      ],
      lsp: { typescript: { command: ['typescript-language-server', '--stdio'], extensions: ['.ts'] } },
    })
    expect(w).toMatchObject({
      model: 'ns/worker',
      taskMessage: '--- BEGIN ISSUE ---\nfix\n--- END ISSUE ---',
      gateway: { baseUrl: 'http://gateway.test', apiKey: 'sk-run', sessionId: run.id },
      limits: { steps: 200, wallClockMs: 2_700_000, tokens: 2_000_000, graceTurns: 1 },
      workdir: '/work/omni',
    })
    expect(cb.of('started')).toEqual([
      [
        'started',
        run.id,
        { sandbox: `ctr-${run.id}`, session: 'ses_1', attach: "docker exec -it ctr sh -c 'opencode attach'" },
      ],
    ])
    expect(cb.of('sandbox')).toEqual([
      ['sandbox', run.id, { driver: 'docker', id: `ctr-${run.id}`, image: 'nightshift/omni:1' }],
    ])
  })

  test("ships the agent's skills into the config dir and points OpenCode at them", async () => {
    await started({
      agents: new Map([['fixer', { ...fixer, skills: ['surgical-patch'] }]]),
      skillFiles: (s) => [
        { path: 'SKILL.md', content: `# ${s}` },
        { path: 'ref/notes.md', content: 'n' },
      ],
    })
    const files = worker.starts[0]?.agent.files ?? []
    expect(files.filter((f) => f.path.startsWith('skills/'))).toEqual([
      { path: 'skills/surgical-patch/SKILL.md', content: '# surgical-patch' },
      { path: 'skills/surgical-patch/ref/notes.md', content: 'n' },
    ])
    const config = JSON.parse(files.find((f) => f.path === 'opencode.json')?.content ?? '{}')
    expect(config.skills).toEqual({ paths: ['/tmp/nightshift/config/opencode/skills'] })
  })

  test("a repair attempt continues on the failed attempt's commit fetched from the host repository", async () => {
    sandbox.onExec = (cmd) =>
      cmd[2]?.includes('refs/nightshift/previous') ? { stdoutTail: 'head1\n' } : undefined
    const ex = executor()
    await ex.start({
      run: { ...run, attempt: 2, agent: 'fixer' },
      issue: snapshot({ identifier: 'FOR-1' }),
      files: [],
      repairFrom: { run: '01JPREV', headSha: 'head1' },
    })
    const cont = sandbox.execs.find((e) => e.cmd[2]?.includes('refs/nightshift/previous'))?.cmd ?? []
    expect(cont.slice(4)).toEqual(['/work/omni', '/mnt/repo.git', 'refs/nightshift/01JPREV', 'ns/FOR-1-2'])
    expect(worker.starts).toHaveLength(1)
  })

  test('a repair start whose checkout does not land on the failed commit destroys the sandbox', async () => {
    sandbox.onExec = (cmd) =>
      cmd[2]?.includes('refs/nightshift/previous') ? { stdoutTail: 'other\n' } : undefined
    await expect(
      executor().start({
        run: { ...run, attempt: 2 },
        issue: snapshot({ identifier: 'FOR-1' }),
        files: [],
        repairFrom: { run: '01JPREV', headSha: 'head1' },
      }),
    ).rejects.toThrow('continuing from head1 failed')
    expect(worker.starts).toEqual([])
    expect(sandbox.destroyed).toHaveLength(1)
  })

  test('mounts the code-graph index read-only and links it into a writable cbm cache', async () => {
    await started({ codeGraph: async () => '/cache/index/omni/base1' })
    const created = sandbox.created[0]
    expect(created?.mounts).toContainEqual({
      hostPath: '/cache/index/omni/base1',
      guestPath: '/mnt/index',
      readOnly: true,
    })
    expect(created?.env).toEqual({ CBM_CACHE_DIR: '/tmp/nightshift/cbm', NS_GRAPH_PROJECT: 'omni' })
    expect(sandbox.execs[1]?.cmd.slice(4)).toEqual(['/tmp/nightshift/cbm', '/mnt/index/omni.db'])
  })

  test('a code-graph failure starts the worker without an index', async () => {
    await started({
      codeGraph: async () => {
        throw new Error('docker down')
      },
    })
    expect(sandbox.created[0]?.env).toEqual({})
    expect(worker.starts).toHaveLength(1)
  })

  test('mounts the gateway CA bundle read-only when configured', async () => {
    config = { ...config, gateway: { ...config.gateway, ca_bundle: '~/ca.pem' } }
    await started()
    expect(sandbox.created[0]?.mounts[1]).toEqual({
      hostPath: '/home/me/ca.pem',
      guestPath: '/etc/nightshift/ca.pem',
      readOnly: true,
    })
  })

  test('fails before starting the worker when the workspace cannot be prepared', async () => {
    sandbox.onExec = () => ({ exitCode: 128, stderrTail: 'fatal: bad object base1' })
    await expect(started()).rejects.toThrow('workspace setup failed: fatal: bad object base1')
    expect(worker.starts).toEqual([])
    expect(sandbox.destroyed).toEqual([`ctr-${run.id}`])
  })

  test('the workspace clone trusts the read-only mount through the global git config', async () => {
    await started()
    expect(sandbox.execs[0]?.cmd[2]).toContain('git config --global --add safe.directory "*" && git clone')
  })
})

describe('WorkerExecutor watching', () => {
  test('a finish ends the session and reports the payload', async () => {
    await started()
    worker.stream.push(read)
    worker.stream.push({ kind: 'finish', payload: { status: 'DONE' } })
    await until(() => cb.of('finished').length === 1)
    expect(cb.of('finished')[0]).toEqual(['finished', run.id, { status: 'DONE' }])
    expect(worker.stopped).toEqual(['finished'])
  })

  test('three steps without a tool call report a stall', async () => {
    await started()
    for (let i = 0; i < 3; i++) worker.stream.push(step)
    await until(() => cb.of('stalled').length === 1)
    expect(cb.of('stalled')[0]?.[2]).toBe('no_tool_calls')
  })

  test('the same tool call four times in a row reports a stall', async () => {
    await started()
    for (let i = 0; i < 4; i++) worker.stream.push(read)
    await until(() => cb.of('stalled').length === 1)
    expect(cb.of('stalled')[0]?.[2]).toBe('repeated_tool_call')
  })

  test('an invalid finish gets one correction, the second failure ends the run', async () => {
    await started()
    worker.stream.push({ kind: 'tool_result', tool: 'finish', ok: false })
    await Bun.sleep(10)
    expect(cb.of('failed')).toEqual([])
    worker.stream.push({ kind: 'tool_result', tool: 'finish', ok: false })
    await until(() => cb.of('failed').length === 1)
    expect(cb.of('failed')[0]).toEqual([
      'failed',
      run.id,
      'no_finish',
      'finish payload invalid after one correction',
    ])
    expect(worker.stopped).toEqual(['no_finish'])
  })

  test('a turn that ends without finish gets a grace turn, then the run fails with no_finish', async () => {
    await started()
    worker.stream.push(read)
    worker.stream.push({ kind: 'idle', sinceMs: 0 })
    await until(() => worker.sent.length === 1)
    expect(worker.sent).toEqual([GRACE_MESSAGE])
    worker.stream.push({ kind: 'idle', sinceMs: 30_000 })
    worker.stream.push({ kind: 'idle', sinceMs: 0 })
    await until(() => cb.of('failed').length === 1)
    expect(cb.of('failed')[0]?.[2]).toBe('no_finish')
  })

  test('the step cap sends the grace message and fails with step_cap when the grace turn ends', async () => {
    config = { ...config, limits: { ...config.limits, worker: { ...config.limits.worker, steps: 2 } } }
    await started()
    worker.stream.push(read)
    worker.stream.push(step)
    worker.stream.push(step)
    await until(() => worker.sent.length === 1)
    expect(worker.sent).toEqual([GRACE_MESSAGE])
    worker.stream.push({ kind: 'idle', sinceMs: 0 })
    await until(() => cb.of('failed').length === 1)
    expect(cb.of('failed')[0]?.[2]).toBe('step_cap')
  })

  test('the wall-clock cap fails the run once the grace period is over', async () => {
    await started({ graceMs: 1_000 })
    clock = 2_700_000
    await until(() => worker.sent.length === 1)
    clock = 2_701_000
    await until(() => cb.of('failed').length === 1)
    expect(cb.of('failed')[0]?.[2]).toBe('time_cap')
  })

  test('a fatal harness error fails the run with a classified reason', async () => {
    await started()
    worker.stream.push({ kind: 'error', message: 'HTTP 502 from provider', fatal: true })
    await until(() => cb.of('failed').length === 1)
    expect(cb.of('failed')[0]).toEqual(['failed', run.id, 'gateway_error', 'HTTP 502 from provider'])
  })

  test('a stream that ends without finish fails the run', async () => {
    await started()
    worker.stream.close()
    await until(() => cb.of('failed').length === 1)
    expect(cb.of('failed')[0]?.[2]).toBe('crash')
  })

  test('a failure after detach is dropped instead of reaching the callbacks', async () => {
    const ex = await started()
    ex.detach()
    worker.stream.close()
    await until(() => worker.stopped.length === 1)
    await Bun.sleep(10)
    expect(cb.of('failed')).toEqual([])
  })

  test('progress carries the diff size against the base commit', async () => {
    await started({ thresholds: { progressSteps: 2 } })
    sandbox.onExec = (cmd) =>
      cmd[2]?.includes('numstat') ? { stdoutTail: '3\t1\tsrc/a.ts\n2\t0\tb.ts\n' } : undefined
    worker.stream.push(read)
    worker.stream.push(step)
    worker.stream.push(step)
    await until(() => cb.of('progress').length === 1)
    expect(cb.of('progress')[0]?.[2]).toEqual({
      steps: 2,
      tool_calls: 1,
      tokens: 22,
      diff_lines: 6,
      last_tool: 'read',
    })
    expect(sandbox.execs.at(-1)?.cmd.at(-1)).toBe('base1')
  })

  test('stop ends the session and silences later events; nudge and runStep delegate', async () => {
    const ex = await started()
    await ex.nudge({ ...run, session: 'ses_1' }, 'keep going')
    expect(worker.sent).toEqual(['keep going'])
    await ex.stop(run, 'issue changed in Linear')
    expect(worker.stopped).toEqual(['issue changed in Linear'])
    worker.stream.push({ kind: 'finish', payload: {} })
    await Bun.sleep(10)
    expect(cb.calls.map((c) => c[0])).toEqual(['sandbox', 'started'])
    await ex.runStep({ ...run, state: 'gating' })
    expect(steps.map((r) => r.state)).toEqual(['gating'])
  })

  test('reattach watches the existing session', async () => {
    const ex = executor()
    await ex.reattach({ ...run, state: 'running', sandbox: 'ctr-1', session: 'ses_1' })
    worker.stream.push({ kind: 'finish', payload: { status: 'DONE' } })
    await until(() => cb.of('finished').length === 1)
    expect(worker.starts).toEqual([])
  })
})

describe('WorkerExecutor.captureHead', () => {
  function withCommit() {
    const fx = gitFixture(join(state, 'git'))
    config = {
      ...config,
      repositories: {
        ...config.repositories,
        omni: { ...(config.repositories.omni as Repo), path: fx.checkout },
      },
    }
    sandbox.exportCommits = async () => fx.bundle(run.id)
    return fx
  }

  test('imports the commits of a stopped sandbox into refs/nightshift/<run>', async () => {
    const fx = withCommit()
    const head = await executor().captureHead({ ...run, baseSha: fx.base, sandbox: `ctr-${run.id}` })
    expect(head).toBe(git(fx.worker, 'rev-parse', fx.branch))
    expect(git(fx.checkout, 'rev-parse', runRef(run.id))).toBe(head ?? '')
  })

  test('a sandbox without commits ahead of base yields no head', async () => {
    const fx = withCommit()
    sandbox.exportCommits = async () => ({ bundle: '', headSha: fx.base })
    expect(
      await executor().captureHead({ ...run, baseSha: fx.base, sandbox: `ctr-${run.id}` }),
    ).toBeUndefined()
  })

  test('a run without a sandbox yields no head', async () => {
    expect(await executor().captureHead(run)).toBeUndefined()
  })

  test('a dirty worktree is committed as wip before export and reported', async () => {
    const fx = withCommit()
    const order: string[] = []
    sandbox.onExec = (cmd) => {
      if (!cmd.join(' ').includes('status --porcelain')) return undefined
      order.push('wip')
      return { stdoutTail: 'wip\n3\t1\tsrc/a.ts\n2\t0\tsrc/c.ts\n' }
    }
    sandbox.exportCommits = async () => {
      order.push('export')
      return fx.bundle(run.id)
    }
    const head = await executor().captureHead(
      { ...run, baseSha: fx.base, sandbox: `ctr-${run.id}` },
      'BLOCKED',
    )
    expect(order).toEqual(['wip', 'export'])
    const wip = sandbox.execs.find((e) => e.cmd.join(' ').includes('status --porcelain'))
    expect(wip?.cmd).toContain('wip: FOR-1 attempt 1 (BLOCKED)')
    expect(wip?.opts.cwd).toBe('/work/omni')
    expect(cb.of('wip')).toEqual([['wip', run.id, { sha: head, lines: 6 }]])
  })

  test('a clean worktree produces no wip commit and no report', async () => {
    const fx = withCommit()
    sandbox.onExec = (cmd) => (cmd.join(' ').includes('status --porcelain') ? { stdoutTail: '' } : undefined)
    await executor().captureHead({ ...run, baseSha: fx.base, sandbox: `ctr-${run.id}` }, 'step_cap')
    expect(cb.of('wip')).toEqual([])
  })
})

describe('helpers', () => {
  test('parse config durations and token counts', () => {
    expect(parseDuration('45m')).toBe(2_700_000)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseTokens('2M')).toBe(2_000_000)
    expect(parseTokens('500k')).toBe(500_000)
    expect(parseTokens('1200')).toBe(1_200)
    expect(() => parseDuration('soon')).toThrow("invalid duration 'soon'")
  })

  test('shellJoin quotes only what needs quoting', () => {
    expect(shellJoin(['docker', 'exec', '-it', 'c', 'sh', '-c', "echo 'x' $Y"])).toBe(
      `docker exec -it c sh -c 'echo '\\''x'\\'' $Y'`,
    )
  })
})
