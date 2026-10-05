import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentDef, type Config, inputBlocks, parseAgent, type SingleCallResult } from '@nightshift/core'
import type { Classifier, ExecutorStart, FailureSignal, GateResult, RunExecutor } from '../../ports'
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
import { numberDiff, type ReviewOutput, reviewInput, reviewStep, type SingleCall, splitDiff } from './review'

const ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
const agent = (name: string): AgentDef => {
  const { def } = parseAgent(`${name}.md`, readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8'))
  if (!def) throw new Error(`agents/${name}.md does not parse`)
  return def
}
const AGENTS = new Map([
  ['reviewer', agent('reviewer')],
  ['implementer', agent('implementer')],
])

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' export const a = 1',
  '-export const b = 1',
  '+export const b = 2',
  'diff --git a/src/a.test.ts b/src/a.test.ts',
  '--- a/src/a.test.ts',
  '+++ b/src/a.test.ts',
  '@@ -3,1 +3,1 @@',
  '-expect(a).toBe(1)',
  '+expect(a).toBeDefined()',
  '',
].join('\n')

const FINISH = {
  status: 'DONE',
  summary: 'done',
  evidence: [{ kind: 'test', ref: 'make test', result: 'pass' }],
}

const BLOCKER = {
  severity: 'BLOCKER' as const,
  file: 'src/a.test.ts',
  lines: '3',
  message: 'assertion loosened',
  evidence: '+expect(a).toBeDefined()',
  confidence: 0.9,
}

const gate = (check: string): GateResult => ({
  check,
  passed: true,
  result: {
    exitCode: 0,
    durationMs: 2000,
    stdoutTail: `${check} ok`,
    stderrTail: '',
    artifact: '',
    timedOut: false,
  },
})

class StepExecutor implements RunExecutor {
  constructor(public step: (run: Run) => Promise<void>) {}
  async start(_s: ExecutorStart): Promise<void> {}
  async reattach(): Promise<void> {}
  async runStep(run: Run): Promise<void> {
    await this.step(run)
  }
  async nudge(): Promise<void> {}
  async stop(): Promise<void> {}
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ns-review-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function harness(results: SingleCallResult<ReviewOutput>[], config: Config = testConfig()) {
  const now = () => new Date('2026-10-04T10:00:00.000Z')
  const linear = new FakeLinear(config, now)
  const calls: { input: string; sessionId?: string; profile: string }[] = []
  const call = (async (_def, input, opts) => {
    calls.push({
      input,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      profile: opts.profile.name,
    })
    const next = results.shift()
    if (!next) throw new Error('unexpected reviewer call')
    return next
  }) as SingleCall
  const classified: FailureSignal[] = []
  const classifier: Classifier = {
    async classify(f) {
      classified.push(f)
      return { class: 'implementation_defect', action: 'retry_same' }
    },
  }
  let sup: Supervisor | undefined
  const review = reviewStep({
    config: () => (sup as Supervisor).config,
    agents: AGENTS,
    linear,
    artifacts: dir,
    gateway: async () => ({ baseUrl: 'http://gateway.test', apiKey: 'k' }),
    callbacks: () => sup as Supervisor,
    call,
  })
  const executor = new StepExecutor(async (run) => {
    if (run.state === 'reviewing') await review(run)
  })
  sup = new Supervisor({
    config,
    db: openState(':memory:'),
    linear,
    executor,
    sandbox: new FakeSandbox(),
    worker: new FakeWorker(),
    notifier: new FakeNotifier(),
    outbox: new FakeOutbox(),
    repos: { baseSha: async () => 'base1' },
    agentKind: (a) => AGENTS.get(a)?.kind ?? (a === 'fixer' ? 'worker' : undefined),
    modelFor: (a, p) => `${p}/${a}`,
    classifier,
    now,
    instanceId: 'inst-1',
  })
  const s = sup
  const of = (type: EventType) => s.log.since(null, { types: [type] })

  async function reviewed(): Promise<Run> {
    linear.put(snapshot({ identifier: 'FOR-1' }))
    await s.start()
    await s.tick()
    const run = s.runs.forIssue('FOR-1').at(-1)
    if (!run) throw new Error('not dispatched')
    mkdirSync(join(dir, run.id), { recursive: true })
    writeFileSync(join(dir, run.id, 'diff.patch'), PATCH)
    writeFileSync(join(dir, run.id, 'tests-touched.txt'), 'src/a.test.ts\n')
    await s.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    await s.workerFinished(run.id, FINISH)
    await s.idle()
    await s.headImported(run.id, 'c0ffee')
    await s.gatesFinished(run.id, [gate('lint'), gate('test')])
    await s.idle()
    return s.runs.get(run.id) as Run
  }

  return { sup: s, linear, calls, classified, of, reviewed }
}

const pass = (findings: ReviewOutput['findings'] = []): SingleCallResult<ReviewOutput> => ({
  ok: true,
  output: { verdict: 'pass', findings },
  trace: { sessionId: 's', calls: [] },
})

describe('review input', () => {
  test('uses exactly the blocks the reviewer declares, in order', () => {
    const input = reviewInput({
      issue: snapshot({ identifier: 'FOR-1' }),
      patch: PATCH,
      testsTouched: ['src/a.test.ts'],
      gates: [{ check: 'test', exit_code: 0, duration_ms: 1500, output_tail: '3 pass' }],
    })
    const fences = [...input.matchAll(/^--- BEGIN ([A-Z]+) ---$/gm)].map((m) => m[1])
    expect(fences).toEqual(inputBlocks((AGENTS.get('reviewer') as AgentDef).body))
    expect(input).toContain('## Acceptance criteria\n- it works')
    expect(input).toContain('Lens: acceptance\n1. it works')
    expect(input).toContain('test: pass (exit 0, 1.5s)\n3 pass')
  })

  test('numbers new-file lines and lists changes to existing tests apart', () => {
    const numbered = numberDiff(PATCH)
    expect(numbered).toContain(' 1 export const a = 1\n-2 export const b = 1\n+2 export const b = 2')
    const { diff, tests } = splitDiff(numbered, ['src/a.test.ts'])
    expect(diff).not.toContain('a.test.ts')
    expect(tests).toContain('+3 expect(a).toBeDefined()')
  })
})

describe('review step', () => {
  test('pass logs REVIEW_RECEIVED, finishes the run and moves the issue through verification to integration', async () => {
    const suggestion = { ...BLOCKER, severity: 'SUGGESTION' as const, message: 'name it better' }
    const h = harness([pass([suggestion])])
    const run = await h.reviewed()

    expect(run.state).toBe('done')
    const received = h.of('REVIEW_RECEIVED')
    expect(received.map((e) => e.data)).toEqual([{ verdict: 'pass', model: 'glm', findings: [suggestion] }])
    expect(h.calls).toEqual([expect.objectContaining({ sessionId: run.id, profile: 'default' })])
    expect(h.calls[0]?.input).toContain('lint: pass (exit 0, 2.0s)\nlint ok')
    expect(h.of('STAGE_ENTERED').map((e) => e.data)).toEqual([
      { stage: 'verification', from: 'implementation' },
      { stage: 'integration', from: 'verification' },
    ])
    expect(h.of('STAGE_COMPLETED').map((e) => e.data)).toEqual([
      { stage: 'implementation' },
      { stage: 'verification' },
    ])
    expect(h.linear.get('FOR-1').labels).toEqual(['ai-stage:integration'])
    const comments = (await h.linear.comments('FOR-1')).filter((c) =>
      c.body.includes(`<!-- nightshift:${received[0]?.id} -->`),
    )
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain('**SUGGESTION** `src/a.test.ts:3`')
    expect(h.sup.leases.get('FOR-1')).toBeUndefined()
    expect(h.sup.forcedManual('FOR-1')).toBeNull()
  })

  test('fail with a BLOCKER fails the run and remediates with review_failed and the findings', async () => {
    const h = harness([
      { ok: true, output: { verdict: 'fail', findings: [BLOCKER] }, trace: { sessionId: 's', calls: [] } },
    ])
    const run = await h.reviewed()

    expect(run.state).toBe('failed')
    expect(h.of('REVIEW_RECEIVED')[0]?.data).toMatchObject({ verdict: 'fail' })
    expect(h.classified).toEqual([])
    expect(h.of('FAILURE_CLASSIFIED')[0]?.data).toEqual({
      class: 'implementation_defect',
      action: 'retry_same',
      evidence: 'src/a.test.ts:3: assertion loosened',
      fallback: false,
    })
    expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(1)
    expect(h.of('STAGE_ENTERED').at(-1)?.data).toEqual({ stage: 'implementation', from: 'verification' })
    expect(h.linear.get('FOR-1')).toMatchObject({ status: 'Todo', labels: ['ai-stage:implementation'] })
  })

  test('invalid output after the correction retry is logged and the change goes on unreviewed, forced manual', async () => {
    const h = harness([
      {
        ok: false,
        reason: 'invalid_output',
        detail: 'verdict: must be equal to one of the allowed values',
        errors: ['verdict: must be equal to one of the allowed values'],
      },
    ])
    const run = await h.reviewed()

    expect(h.calls).toHaveLength(1)
    expect(h.of('SINGLE_CALL_INVALID').map((e) => e.data)).toEqual([
      {
        agent: 'reviewer',
        model: 'glm',
        errors: ['verdict: must be equal to one of the allowed values'],
      },
    ])
    expect(h.of('REVIEW_RECEIVED')).toEqual([])
    expect(run.state).toBe('done')
    expect(h.sup.forcedManual('FOR-1')).toBe('the reviewer returned invalid output twice')
    expect(h.linear.get('FOR-1').labels).toEqual(['ai-stage:integration'])
    const comments = await h.linear.comments('FOR-1')
    expect(comments.filter((c) => c.body.includes('unreviewed'))).toHaveLength(1)
    expect(comments.at(-1)?.body).toContain('forced to manual')
  })

  test('input over budget is logged and treated as unreviewed', async () => {
    const h = harness([
      {
        ok: false,
        reason: 'input_over_budget',
        detail: 'input has 30000 tokens, budget 24000',
        tokens: 30000,
      },
    ])
    const run = await h.reviewed()

    expect(h.of('INPUT_OVER_BUDGET').map((e) => e.data)).toEqual([
      { agent: 'reviewer', model: 'glm', tokens: 30000, budget: 24000 },
    ])
    expect(run.state).toBe('done')
    expect(h.sup.forcedManual('FOR-1')).toContain('over the reviewer budget')
  })

  test('a gateway error fails the run as an environment failure', async () => {
    const h = harness([{ ok: false, reason: 'gateway_error', detail: 'HTTP 502' }])
    const run = await h.reviewed()
    expect(run.state).toBe('failed')
    expect(h.of('WORKER_FAILED')[0]?.data).toEqual({ reason: 'gateway_error', detail: 'HTTP 502' })
  })

  test('reviewer and worker of the same family: the review is refused with the config error, not run', async () => {
    const base = testConfig()
    const profile = base.profiles.default as Exclude<Config['profiles'][string], string | number>
    const models = { ...profile.models }
    models['ns/reviewer'] = { ...(models['ns/reviewer'] as (typeof models)[string]), family: 'qwen' }
    const config = { ...base, profiles: { ...base.profiles, default: { ...profile, models } } }
    const h = harness([pass()], config)
    const run = await h.reviewed()

    expect(h.calls).toEqual([])
    expect(run.state).toBe('reviewing')
    expect(h.of('CONFIG_REJECTED').map((e) => e.data)).toEqual([
      { errors: ['profiles.default: reviewer family qwen equals worker family'] },
    ])
    expect(h.of('REVIEW_RECEIVED')).toEqual([])

    await h.sup.reloadConfig({ ok: true, config: testConfig(), sources: [] })
    await h.sup.idle()
    expect(h.sup.runs.get(run.id)?.state).toBe('done')
  })
})
