import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import { runRef } from '../../adapters/git/host'
import { type ExecCall, FakeSandboxDriver } from '../../adapters/worker/testing'
import type { ExecResult, ExecutorStart, GateRunner, RunExecutor, SandboxHandle } from '../../ports'
import { openState } from '../../state/db'
import type { EventType } from '../../state/event-schema'
import type { Run } from '../../state/runs'
import { Supervisor } from '../../supervisor/supervisor'
import {
  FakeLinear,
  FakeNotifier,
  FakeOutbox,
  FakeSandbox,
  FakeWorker,
  snapshot,
  testConfig,
} from '../../testing/testing'
import { SandboxGateRunner } from './runner'
import { gateStep } from './step'
import { type GitFixture, git, gitFixture } from './testing'

const FINISH = {
  status: 'DONE',
  summary: 'done',
  evidence: [{ kind: 'test', ref: 'make test', result: 'pass' }],
}

class ExportingSandbox extends FakeSandboxDriver {
  readonly exports: [SandboxHandle, string, string, string | undefined][] = []
  hang: Promise<void> | undefined
  constructor(private readonly fx: GitFixture) {
    super()
  }
  override async exec(h: SandboxHandle, cmd: string[], opts: ExecCall['opts'] = {}): Promise<ExecResult> {
    if (this.hang && cmd[2]?.startsWith('sh -c "$2"')) await this.hang
    return super.exec(h, cmd, opts)
  }
  override async exportCommits(h: SandboxHandle, repoPath: string, ref: string, message?: string) {
    this.exports.push([h, repoPath, ref, message])
    if (message && git(this.fx.worker, 'status', '--porcelain')) {
      git(this.fx.worker, 'add', '-A')
      git(this.fx.worker, 'commit', '-q', '-m', message)
    }
    return this.fx.bundle(h.name)
  }
}

class StepExecutor implements RunExecutor {
  readonly steps: [string, string][] = []
  constructor(public step: (run: Run, signal?: AbortSignal) => Promise<void>) {}
  async start(_s: ExecutorStart): Promise<void> {}
  async reattach(): Promise<void> {}
  async runStep(run: Run, signal?: AbortSignal): Promise<void> {
    this.steps.push([run.id, run.state])
    await this.step(run, signal)
  }
  async nudge(): Promise<void> {}
  async stop(): Promise<void> {}
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-step-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function harness(results: Record<string, Partial<ExecResult>> = {}, sub = 'a') {
  const dir = join(root, sub)
  const fx = gitFixture(dir)
  const base = testConfig()
  const omni = base.repositories.omni
  if (!omni) throw new Error('omni missing')
  const config: Config = {
    ...base,
    repositories: {
      ...base.repositories,
      omni: {
        ...omni,
        path: fx.checkout,
        checks: [
          { name: 'lint', run: 'make lint', timeout: '1m' },
          { name: 'test', run: 'make test', timeout: '15m' },
        ],
      },
    },
  }
  const now = () => new Date('2026-10-04T10:00:00.000Z')
  const db = openState(':memory:')
  const linear = new FakeLinear(config, now)
  const workerSandboxes = new FakeSandbox()
  const gateSandbox = new ExportingSandbox(fx)
  gateSandbox.onExec = (cmd) =>
    cmd[2]?.startsWith('sh -c "$2"') ? { stdoutTail: `ran ${cmd[5]}`, ...results[cmd[5] ?? ''] } : undefined
  const runner = new SandboxGateRunner({
    sandbox: gateSandbox,
    outbox: join(dir, 'gate-outbox'),
    artifacts: join(dir, 'artifacts'),
    resources: { cpus: 1, memoryMb: 1024 },
  })
  const out: string[] = []
  let sup: Supervisor | undefined
  const stepWith = (gates: GateRunner) =>
    gateStep({
      config: () => config,
      image: async () => 'nightshift/env-omni:test',
      sandbox: gateSandbox,
      gates,
      artifacts: join(dir, 'artifacts'),
      callbacks: () => sup as Supervisor,
      out: (l) => out.push(l),
    })
  const executor = new StepExecutor(stepWith(runner))
  const make = (instanceId: string) => {
    sup = new Supervisor({
      config,
      db,
      linear,
      executor,
      sandbox: workerSandboxes,
      worker: new FakeWorker(),
      notifier: new FakeNotifier(),
      outbox: new FakeOutbox(),
      repos: { baseSha: async () => fx.base },
      agentKind: () => 'worker',
      modelFor: (agent, profile) => `${profile}/${agent}`,
      now,
      instanceId,
    })
    return sup
  }
  const first = make('inst-1')
  const of = (type: EventType, s: Supervisor = sup as Supervisor) => s.log.since(null, { types: [type] })
  const gateEvents = (s: Supervisor = sup as Supervisor) =>
    s.log.since(null, { types: ['GATE_PASSED', 'GATE_FAILED'] }).map((e) => [e.type, e.data])

  async function finishedRun(): Promise<Run> {
    linear.put(snapshot({ identifier: 'FOR-1' }))
    await first.start()
    await first.tick()
    const run = first.runs.forIssue('FOR-1').at(-1)
    if (!run) throw new Error('not dispatched')
    workerSandboxes.add(run.id)
    await first.workerStarted(run.id, { sandbox: `sb-${run.id}`, session: 's-1' })
    return run
  }

  return {
    fx,
    config,
    linear,
    first,
    make,
    executor,
    stepWith,
    runner,
    gateSandbox,
    workerSandboxes,
    out,
    of,
    gateEvents,
    finishedRun,
  }
}

const gateRuns = (s: FakeSandboxDriver) => s.execs.filter((e) => e.cmd[2]?.startsWith('sh -c "$2"'))

describe('gate step', () => {
  test('a failing first check fails the run once, skips the rest, comments the tail, destroys the gate', async () => {
    const h = harness({ 'make lint': { exitCode: 2, stdoutTail: 'src/a.ts:1 unused import' } })
    const run = await h.finishedRun()
    await h.first.workerFinished(run.id, FINISH)
    await h.first.idle()

    const failed = h.of('GATE_FAILED')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.data).toMatchObject({
      check: 'lint',
      exit_code: 2,
      output_tail: 'src/a.ts:1 unused import',
    })
    expect(h.of('GATE_PASSED')).toHaveLength(0)
    expect(gateRuns(h.gateSandbox).map((e) => e.cmd[5])).toEqual(['make lint'])
    expect(h.first.runs.get(run.id)?.state).toBe('failed')
    expect(h.gateSandbox.destroyed).toEqual([`ctr-${run.id}-gate`])

    const marker = `<!-- nightshift:${failed[0]?.id} -->`
    const comments = (await h.linear.comments('FOR-1')).filter((c) => c.body.includes(marker))
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain('Gate `lint` failed: exit code 2')
    expect(comments[0]?.body).toContain('```text\nsrc/a.ts:1 unused import\n```')
    expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(1)
    expect(h.first.leases.get('FOR-1')).toBeUndefined()

    await h.first.gatesFinished(run.id, [])
    expect((await h.linear.comments('FOR-1')).filter((c) => c.body.includes(marker))).toHaveLength(1)
  })

  test('all checks passing logs one GATE_PASSED per check and moves the run to reviewing', async () => {
    const h = harness()
    const run = await h.finishedRun()
    await h.first.workerFinished(run.id, FINISH)
    await h.first.idle()

    expect(h.gateEvents().map(([type, data]) => [type, (data as { check: string }).check])).toEqual([
      ['GATE_PASSED', 'lint'],
      ['GATE_PASSED', 'test'],
    ])
    expect(h.first.runs.get(run.id)?.state).toBe('reviewing')
    expect(h.gateSandbox.created.map((c) => c.image)).toEqual(['nightshift/env-omni:test'])
    expect(h.executor.steps).toEqual([
      [run.id, 'gating'],
      [run.id, 'reviewing'],
    ])
    expect(h.out).toEqual([`FOR-1: review is not wired yet; run ${run.id} waits in reviewing`])
    expect(h.first.leases.get('FOR-1')?.run).toBe(run.id)
  })

  test('a check over its timeout records exit code 124 and fails the run', async () => {
    const h = harness({ 'make lint': { exitCode: 124, timedOut: true } })
    const run = await h.finishedRun()
    await h.first.workerFinished(run.id, FINISH)
    await h.first.idle()

    expect(h.of('GATE_FAILED')[0]?.data).toMatchObject({ check: 'lint', exit_code: 124 })
    expect(gateRuns(h.gateSandbox)[0]?.opts.timeoutMs).toBe(60_000)
    expect(h.first.runs.get(run.id)?.state).toBe('failed')
  })

  test('runs the configured command even though the worker rewrote the Makefile target', async () => {
    const h = harness()
    const run = await h.finishedRun()
    await h.first.workerFinished(run.id, FINISH)
    await h.first.idle()

    const headSha = h.first.runs.get(run.id)?.headSha ?? ''
    expect(git(h.fx.checkout, 'diff', h.fx.base, headSha, '--', 'Makefile')).toContain('+\ttrue')
    expect(gateRuns(h.gateSandbox).map((e) => e.cmd[5])).toEqual(['make lint', 'make test'])
  })

  test('imports the worker commit into refs/nightshift/<run> without touching the checkout', async () => {
    const h = harness()
    const before = h.fx.hostState()
    const run = await h.finishedRun()
    await h.first.workerFinished(run.id, FINISH)
    await h.first.idle()

    const stored = h.first.runs.get(run.id)
    expect(stored?.headSha).toBe(git(h.fx.worker, 'rev-parse', h.fx.branch))
    expect(git(h.fx.checkout, 'rev-parse', runRef(run.id))).toBe(stored?.headSha ?? '')
    expect(h.fx.hostState()).toBe(before)
    expect(h.gateSandbox.exports).toEqual([
      [
        { driver: 'docker', id: `sb-${run.id}`, name: run.id },
        '/work/omni',
        'ns/FOR-1-1',
        'FOR-1: implementer changes (uncommitted at finish)',
      ],
    ])
    expect(h.gateSandbox.execs[0]?.cmd[6]).toBe(stored?.headSha ?? '')
    expect(h.workerSandboxes.destroyed).toEqual([`sb-${run.id}`])
    expect(stored?.sandbox).toBeNull()
    const artifacts = join(root, 'a', 'artifacts', run.id)
    expect(readFileSync(join(artifacts, 'tests-touched.txt'), 'utf8')).toBe('src/a.test.ts\n')
    expect(existsSync(join(artifacts, 'diff.patch'))).toBe(true)
    expect(existsSync(join(artifacts, 'gate-lint.log'))).toBe(true)
  })

  test('after a restart in gating the gates re-run from head_sha and produce the same events', async () => {
    const h = harness({ 'make test': { exitCode: 1, stdoutTail: 'FAIL a.test.ts' } })
    const run = await h.finishedRun()
    const hung: GateRunner = { run: () => new Promise(() => {}) }
    h.executor.step = h.stepWith(hung)
    void h.first.workerFinished(run.id, FINISH)
    for (let i = 0; i < 100 && h.first.runs.get(run.id)?.headSha === null; i++) await Bun.sleep(5)
    const headSha = h.first.runs.get(run.id)?.headSha
    expect(headSha).toBeString()
    expect(h.first.runs.get(run.id)?.state).toBe('gating')
    expect(h.gateEvents()).toEqual([])

    h.executor.step = h.stepWith(h.runner)
    const restarted = h.make('inst-2')
    const report = await restarted.start()
    await restarted.idle()
    expect(report.resumed).toEqual([run.id])
    expect(h.gateSandbox.exports).toHaveLength(1)
    expect(h.gateSandbox.execs[0]?.cmd[6]).toBe(headSha ?? '')
    const events = h.gateEvents(restarted)
    expect(events.map(([type, data]) => [type, (data as { check: string }).check])).toEqual([
      ['GATE_PASSED', 'lint'],
      ['GATE_FAILED', 'test'],
    ])
    expect(restarted.runs.get(run.id)?.state).toBe('failed')

    const again = harness({ 'make test': { exitCode: 1, stdoutTail: 'FAIL a.test.ts' } }, 'b')
    const fresh = await again.finishedRun()
    await again.first.workerFinished(fresh.id, FINISH)
    await again.first.idle()
    const strip = (e: unknown[]) => [
      e[0],
      { ...(e[1] as object), artifact: undefined, duration_ms: undefined },
    ]
    expect(again.gateEvents().map(strip)).toEqual(events.map(strip))
  })

  test('uncommitted worker changes are committed before export and gated', async () => {
    const h = harness()
    git(h.fx.worker, 'reset', '-q', '--hard', h.fx.base)
    writeFileSync(join(h.fx.worker, 'src/c.ts'), 'export const c = 3\n')
    const run = await h.finishedRun()
    await h.first.workerFinished(run.id, FINISH)
    await h.first.idle()

    const head = h.first.runs.get(run.id)?.headSha ?? ''
    expect(head).not.toBe(h.fx.base)
    expect(git(h.fx.checkout, 'show', '--name-only', '--format=%s', head)).toBe(
      'FOR-1: implementer changes (uncommitted at finish)\n\nsrc/c.ts',
    )
    expect(h.gateEvents().map(([t]) => t)).toEqual(['GATE_PASSED', 'GATE_PASSED'])
  })

  test('a worker that finishes without changes fails instead of passing empty gates', async () => {
    const h = harness()
    git(h.fx.worker, 'reset', '-q', '--hard', h.fx.base)
    const run = await h.finishedRun()
    await h.first.workerFinished(run.id, FINISH)
    await h.first.idle()

    expect(h.of('WORKER_NO_FINISH')[0]?.data).toEqual({
      reason: 'no_finish',
      detail: 'worker finished without changes',
    })
    expect(h.first.runs.get(run.id)?.state).toBe('failed')
    expect(h.gateEvents()).toEqual([])
  })

  test('a gate infrastructure failure fails the run as a sandbox error', async () => {
    const h = harness()
    h.gateSandbox.onExec = (cmd) =>
      cmd[2]?.includes('clone') ? { exitCode: 128, stderrTail: 'no image' } : undefined
    const run = await h.finishedRun()
    await h.first.workerFinished(run.id, FINISH)
    await h.first.idle()

    expect(h.of('WORKER_FAILED')[0]?.data).toMatchObject({ reason: 'sandbox_error' })
    expect(String(h.of('WORKER_FAILED')[0]?.data.detail)).toContain('gate checkout')
    expect(h.first.runs.get(run.id)?.state).toBe('failed')
    expect(h.gateEvents()).toEqual([])
  })

  test('stopping the supervisor mid-gate destroys the gate sandbox and leaves the run gating for recovery', async () => {
    const h = harness()
    const run = await h.finishedRun()
    h.gateSandbox.hang = new Promise(() => {})
    await h.first.workerFinished(run.id, FINISH)
    for (let i = 0; i < 100 && gateRuns(h.gateSandbox).length === 0; i++) await Bun.sleep(5)
    expect(h.first.stepsRunning()).toEqual([`${run.id}:gating`])

    await h.first.stop('signal')
    expect(h.first.stepsRunning()).toEqual([])
    expect(h.gateSandbox.destroyed).toEqual([`ctr-${run.id}-gate`])
    expect(h.first.runs.get(run.id)?.state).toBe('gating')
    expect(h.gateEvents()).toEqual([])
    expect(h.of('WORKER_FAILED')).toHaveLength(0)

    h.gateSandbox.hang = undefined
    const restarted = h.make('inst-2')
    const report = await restarted.start()
    await restarted.idle()
    expect(report.resumed).toEqual([run.id])
    expect(h.gateEvents(restarted).map(([type]) => type)).toEqual(['GATE_PASSED', 'GATE_PASSED'])
    expect(restarted.runs.get(run.id)?.state).toBe('reviewing')
  })

  test('ns stop during a gate cancels the gate job, destroys its sandbox and leaves the run gating for recovery', async () => {
    const h = harness()
    const run = await h.finishedRun()
    h.gateSandbox.hang = new Promise(() => {})
    await h.first.workerFinished(run.id, FINISH)
    for (let i = 0; i < 100 && gateRuns(h.gateSandbox).length === 0; i++) await Bun.sleep(5)
    expect(h.first.stepsRunning()).toEqual([`${run.id}:gating`])

    const stopped = await h.first.stopForUser('FOR-1', undefined, 'cli')
    expect(stopped.state).toBe('gating')
    expect(h.first.stepsRunning()).toEqual([])
    expect(h.gateSandbox.destroyed).toEqual([`ctr-${run.id}-gate`])
    expect(h.first.runs.get(run.id)?.state).toBe('gating')
    expect(h.gateEvents()).toEqual([])
    expect(h.of('WORKER_FAILED')).toHaveLength(0)
    expect(h.first.leases.get('FOR-1')?.run).toBe(run.id)

    h.gateSandbox.hang = undefined
    await h.first.stop('signal')
    const restarted = h.make('inst-2')
    const report = await restarted.start()
    await restarted.idle()
    expect(report.resumed).toEqual([run.id])
    expect(h.gateEvents(restarted).map(([type]) => type)).toEqual(['GATE_PASSED', 'GATE_PASSED'])
    expect(restarted.runs.get(run.id)?.state).toBe('reviewing')
  })
})
