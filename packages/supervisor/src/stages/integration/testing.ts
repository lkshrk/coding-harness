import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import { importBundle } from '../../adapters/git/host'
import {
  GhGitHost,
  type HostCommandResult,
  type HostCommandRunner,
  spawnCommand,
} from '../../adapters/github/gh'
import { GitHubTokens } from '../../adapters/github/github-tokens'
import type { GateResult, IssueSnapshot } from '../../ports'
import { openState } from '../../state/db'
import type { EventType } from '../../state/event-schema'
import type { Run } from '../../state/runs'
import { Supervisor, type SupervisorDeps } from '../../supervisor/supervisor'
import {
  FakeExecutor,
  FakeLinear,
  FakeNotifier,
  FakeOutbox,
  FakeSandbox,
  FakeWorker,
  snapshot,
  testConfig,
} from '../../testing/testing'
import { git, gitFixture } from '../gates/testing'
import { IntegrationHandler } from './stage'

export type Call = { cmd: string[]; env: Record<string, string>; stdin?: string }

export type FakePr = {
  number: number
  url: string
  head: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  headSha?: string
}

const ROLLUP: Record<string, { status: string; conclusion: string }> = {
  pass: { status: 'COMPLETED', conclusion: 'SUCCESS' },
  fail: { status: 'COMPLETED', conclusion: 'FAILURE' },
  cancel: { status: 'COMPLETED', conclusion: 'CANCELLED' },
  pending: { status: 'IN_PROGRESS', conclusion: '' },
  skipping: { status: 'COMPLETED', conclusion: 'SKIPPED' },
}

export type FakeCheck = { name: string; bucket: string; run?: number; job?: number }

const rollupItem = (c: FakeCheck) => ({
  __typename: 'CheckRun',
  name: c.name,
  ...ROLLUP[c.bucket],
  ...(c.run
    ? { detailsUrl: `https://github.com/lkshrk/omni/actions/runs/${c.run}${c.job ? `/job/${c.job}` : ''}` }
    : {}),
})

export class FakeGh {
  readonly calls: Call[] = []
  readonly prs: FakePr[] = []
  checks: FakeCheck[] = []
  logs: Record<string, string | HostCommandResult> = {}
  failNext: HostCommandResult | undefined

  constructor(private readonly slug = 'lkshrk/omni') {}

  readonly run: HostCommandRunner = async (cmd, o) => {
    this.calls.push({ cmd, env: o.env, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}) })
    if (this.failNext) {
      const r = this.failNext
      this.failNext = undefined
      return r
    }
    if (cmd[0] !== 'gh') return spawnCommand(cmd, o)
    const ok = (stdout: string): HostCommandResult => ({ exitCode: 0, stdout, stderr: '' })
    const [, , verb] = cmd
    const arg = (flag: string) => cmd[cmd.indexOf(flag) + 1] ?? ''
    if (verb === 'list') {
      const open = this.prs.filter((p) => p.head === arg('--head') && p.state === 'OPEN')
      return ok(JSON.stringify(open.map(({ number, url }) => ({ number, url }))))
    }
    if (verb === 'create') {
      const number = this.prs.length + 1
      const url = `https://github.com/${this.slug}/pull/${number}`
      this.prs.push({ number, url, head: arg('--head'), state: 'OPEN' })
      return ok(`Creating pull request\n${url}\n`)
    }
    if (cmd[1] === 'run' && verb === 'view' && cmd.includes('--log-failed')) {
      const log = this.logs[cmd.includes('--job') ? `job ${arg('--job')}` : `run ${cmd[3]}`]
      if (log === undefined) return { exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' }
      return typeof log === 'string' ? ok(log) : log
    }
    if (cmd[1] === 'api' && cmd[3] === 'PATCH') return ok('{}')
    if (verb === 'edit') return ok('')
    if (verb === 'view' && arg('--json') === 'statusCheckRollup')
      return ok(JSON.stringify({ statusCheckRollup: this.checks.map(rollupItem) }))
    if (verb === 'view') {
      const pr = this.prs.find((p) => String(p.number) === cmd[3])
      return ok(
        JSON.stringify({
          state: pr?.state,
          mergeCommit: pr?.state === 'MERGED' ? { oid: 'm3rg3d' } : null,
          ...(pr?.headSha ? { headRefOid: pr.headSha } : {}),
        }),
      )
    }
    return { exitCode: 1, stdout: '', stderr: `unknown gh ${cmd.join(' ')}` }
  }

  gh(verb: string): Call[] {
    return this.calls.filter((c) => c.cmd[0] === 'gh' && c.cmd[2] === verb)
  }

  prUpdates(): Call[] {
    return this.calls.filter((c) => c.cmd[1] === 'api' && c.cmd[3] === 'PATCH')
  }

  logReads(): Call[] {
    return this.calls.filter((c) => c.cmd[1] === 'run' && c.cmd.includes('--log-failed'))
  }

  ciReads(): Call[] {
    return this.gh('view').filter((c) => c.cmd.includes('statusCheckRollup'))
  }
}

export const AGENT_TOKEN = 'ghs_agent_lkshrk'
export const PERSONAL_TOKEN = 'ghp_personal'

export function hostConfig(checkout: string, base: Config = testConfig()): Config {
  const omni = base.repositories.omni
  if (!omni) throw new Error('omni missing')
  return {
    ...base,
    github: {
      default: 'agent',
      accounts: {
        agent: {
          octo_sts: {
            url: 'http://octo-sts.test',
            token_url: 'http://auth.test/token',
            client_id: 'octo-sts',
            identity: 'nightshift-host',
            password: 'env:OCTO_STS_PASSWORD',
          },
        },
        personal: { token: 'env:GH_PERSONAL_TOKEN' },
      },
    },
    repositories: {
      ...base.repositories,
      omni: { ...omni, path: checkout, risk_paths: ['deploy/**'] },
      litellm: { ...omni, path: checkout, github: 'personal' },
    },
  }
}

export function fakeTokens(config: () => Config): GitHubTokens {
  return new GitHubTokens({
    config,
    resolve: async (ref) => (ref === 'env:GH_PERSONAL_TOKEN' ? PERSONAL_TOKEN : 'octo-password'),
    remoteUrl: async () => 'https://github.com/lkshrk/omni.git',
    fetch: async (url) =>
      url.startsWith('http://auth.test')
        ? Response.json({ access_token: 'jwt' })
        : Response.json({ token: `ghs_agent_${new URL(url).searchParams.get('scope')}` }),
  })
}

export function bareRemote(root: string): string {
  const remote = join(root, 'remote.git')
  mkdirSync(remote, { recursive: true })
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  return remote
}

export function fakeHost(config: () => Config, gh: FakeGh, remote: string): GhGitHost {
  return new GhGitHost({
    config,
    tokens: fakeTokens(config),
    run: gh.run,
    remoteUrl: async () => 'https://github.com/lkshrk/omni.git',
    pushUrl: () => remote,
  })
}

export const FINISH = {
  status: 'DONE',
  summary: 'Trimmed user names before saving.',
  evidence: [{ kind: 'test', ref: 'bun test', result: 'pass' }],
}

export const SUGGESTION = {
  severity: 'SUGGESTION' as const,
  file: 'src/b.ts',
  lines: '1',
  message: 'export a type',
  evidence: '+export const b = 2',
  confidence: 0.4,
}

export const gate = (check: string): GateResult => ({
  check,
  passed: true,
  result: { exitCode: 0, durationMs: 1500, stdoutTail: 'ok', stderrTail: '', artifact: '', timedOut: false },
})

export async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(5)
  if (!cond()) throw new Error(`timed out waiting for ${what}`)
}

export function integrationHarness(
  root: string,
  adjust: (c: Config) => Config = (c) => c,
  extra: Partial<SupervisorDeps> = {},
) {
  const fx = gitFixture(root)
  const base = hostConfig(fx.checkout)
  const config = adjust({
    ...base,
    projects: [
      ...base.projects,
      { match: { team: 'FOR', project: 'LiteLLM' }, repositories: ['litellm'], pipeline: 'bug' },
    ],
  })
  const now = () => new Date('2026-10-04T10:00:00.000Z')
  const linear = new FakeLinear(config, now)
  linear.workspaceValue = {
    ...linear.workspaceValue,
    projects: [
      ...linear.workspaceValue.projects,
      { id: 'p-litellm', name: 'LiteLLM', state: 'started', milestones: [] },
    ],
  }
  const gh = new FakeGh()
  const remote = bareRemote(root)
  const host = fakeHost(() => config, gh, remote)
  let sup: Supervisor | undefined
  const out: string[] = []
  const handler = new IntegrationHandler({
    config: () => config,
    host,
    callbacks: () => sup as Supervisor,
    out: (l) => out.push(l),
  })
  const db = openState(':memory:')
  const executor = new FakeExecutor()
  const make = (instanceId: string) => {
    sup = new Supervisor({
      config,
      db,
      linear,
      executor,
      sandbox: new FakeSandbox(),
      worker: new FakeWorker(),
      notifier: new FakeNotifier(),
      outbox: new FakeOutbox(),
      repos: { baseSha: async () => fx.base },
      agentKind: (a) => (a === 'reviewer' || a === 'intake' || a === 'acceptor' ? 'single_call' : 'worker'),
      modelFor: (a, p) => `${p}/${a}`,
      stageHandler: handler,
      gitHost: host,
      now,
      instanceId,
      ...extra,
    })
    return sup
  }
  const first = make('inst-1')
  const of = (type: EventType, s: Supervisor = sup as Supervisor) => s.log.since(null, { types: [type] })

  async function integrated(over: Partial<IssueSnapshot> = {}): Promise<Run> {
    linear.put(snapshot({ identifier: 'FOR-1', title: 'Trim names', ...over }))
    await first.start()
    await first.tick()
    const run = first.runs.forIssue('FOR-1').at(-1)
    if (!run) throw new Error('not dispatched')
    await first.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    await first.workerFinished(run.id, FINISH)
    await first.headImported(run.id, importBundle(fx.checkout, fx.bundle().bundle, fx.branch, run.id))
    await first.gatesFinished(run.id, [gate('lint'), gate('test')])
    await first.reviewFinished(run.id, {
      kind: 'verdict',
      review: { verdict: 'pass', findings: [SUGGESTION] },
      model: 'glm',
    })
    await first.tick()
    await until(() => linear.get('FOR-1').status === 'In Review', 'status In Review')
    return first.runs.get(run.id) as Run
  }

  return { fx, config, db, linear, gh, remote, handler, first, make, of, out, executor, integrated }
}
