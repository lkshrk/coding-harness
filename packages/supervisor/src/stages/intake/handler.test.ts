import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentDef, type IntakeOutput, parseAgent } from '@nightshift/core'
import type { StageWork } from '../../ports'
import { harness } from '../../supervisor/testing'
import { snapshot } from '../../testing/testing'
import type { SingleCall } from '../gates'
import { integrationHarness } from '../integration/testing'
import { IntakeHandler, StageRouter } from './handler'

const root = join(import.meta.dir, '../../../../..')
const agents = new Map(
  ['duplicate-judge', 'intake'].map((name) => {
    const { def } = parseAgent(`${name}.md`, readFileSync(join(root, 'agents', `${name}.md`), 'utf8'))
    return [
      name,
      { ...def, output: JSON.parse(readFileSync(join(root, 'schemas', `${name}.json`), 'utf8')) } as AgentDef,
    ]
  }),
)

const accepted: IntakeOutput = {
  decision: 'accept',
  type: 'bug',
  project: null,
  priority: 3,
  duplicate_of: null,
  group_with: [],
  missing_info: [],
}

function intakeHarness(output: IntakeOutput) {
  const calls: string[] = []
  const call = (async (def) => {
    calls.push(def.name)
    if (def.name === 'duplicate-judge')
      return {
        ok: true,
        output: { verdict: 'duplicate', confidence: 1, shared_outcome: 'Export invoice PDF' },
        trace: { sessionId: 's', calls: [] },
      }
    return { ok: true, output, trace: { sessionId: 's', calls: [] } }
  }) as SingleCall
  let h: ReturnType<typeof harness> | undefined
  const intake = new IntakeHandler({
    config: () => (h as ReturnType<typeof harness>).config,
    agents,
    linear: { candidates: (q) => (h as ReturnType<typeof harness>).linear.candidates(q) },
    gateway: async () => ({ baseUrl: 'http://gateway.test', apiKey: 'test' }),
    now: () => new Date('2026-10-04T10:00:00Z'),
    call,
    callbacks: () => (h as ReturnType<typeof harness>).sup,
    out: () => {},
  })
  h = harness({ stageHandler: new StageRouter({ intake }) })
  h.config.stages.intake = {
    automatic: true,
    human_checkpoint: 'none',
    duplicate: { judge: 'llm', threshold: 0.9, max_candidates: 5, closed_within_days: 90 },
  }
  const issue = snapshot({
    identifier: 'FOR-1',
    title: 'Export invoice PDF',
    status: 'Backlog',
    delegated: false,
    project: null,
    labels: ['bug', 'repo:omni'],
  })
  h.linear.put(issue)
  h.sup.cover('FOR-1')
  return { h, calls, issue }
}

async function ticks(h: ReturnType<typeof harness>, n: number) {
  for (let i = 0; i < n; i++) {
    await h.sup.tick()
    await Bun.sleep(5)
  }
}

describe('intake stage handler', () => {
  test('a covered Backlog issue runs intake once and accept enters the next stage', async () => {
    const { h, calls } = intakeHarness(accepted)
    await h.sup.start()
    await h.sup.tick()
    expect(h.linear.get('FOR-1').labels).toContain('ai-stage:intake')
    await ticks(h, 1)
    expect(calls).toEqual(['intake'])
    expect(h.of('STAGE_COMPLETED').map((e) => e.data)).toEqual([{ stage: 'intake' }])
    expect(h.of('STAGE_ENTERED').at(-1)?.data).toEqual({ stage: 'implementation', from: 'intake' })
    expect(h.linear.get('FOR-1').labels).toContain('ai-stage:implementation')
    await ticks(h, 2)
    expect(calls).toEqual(['intake'])
    expect(h.sup.runs.forIssue('FOR-1').length).toBe(1)
  })

  test('duplicate holds the issue for you with one comment and does not loop', async () => {
    const { h, calls, issue } = intakeHarness({ ...accepted, decision: 'duplicate', duplicate_of: 'FOR-2' })
    h.linear.put(snapshot({ ...issue, id: 'id-FOR-2', identifier: 'FOR-2', status: 'Todo' }))
    await h.sup.start()
    await ticks(h, 5)
    expect(calls).toEqual(['duplicate-judge', 'intake'])
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'intake', reason: 'duplicate' })
    expect(h.linear.get('FOR-1')).toMatchObject({ status: 'Blocked' })
    expect(h.linear.get('FOR-1').labels).toContain('ai-stage:intake')
    const comments = h.linear.threads.get('FOR-1') ?? []
    expect(comments.length).toBe(1)
    expect(comments[0]?.body).toContain('duplicate of FOR-2')
    expect(h.notifier.sent.filter((n) => n.issue === 'FOR-1').length).toBe(1)
    expect(h.of('STAGE_COMPLETED')).toEqual([])
  })

  test('needs_info holds the issue for you with the questions in one comment', async () => {
    const { h, calls } = intakeHarness({
      ...accepted,
      decision: 'needs_info',
      missing_info: ['Which invoices?'],
    })
    await h.sup.start()
    await ticks(h, 5)
    expect(calls).toEqual(['intake'])
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'intake', reason: 'needs_info' })
    const comments = h.linear.threads.get('FOR-1') ?? []
    expect(comments.length).toBe(1)
    expect(comments[0]?.body).toContain('- Which invoices?')
  })
})

describe('stage router', () => {
  test('routes each stage to its own handler and reports which stages it handles', async () => {
    const seen: string[] = []
    const record = (name: string) => ({
      run: async (w: StageWork) => {
        seen.push(`${name}:${w.stage}`)
      },
    })
    const router = new StageRouter({ intake: record('intake'), integration: record('integration') })
    const work = (stage: string): StageWork => ({
      issue: snapshot({ identifier: 'FOR-1' }),
      stage,
      agent: undefined,
    })
    await router.run(work('integration'))
    await router.run(work('intake'))
    expect(seen).toEqual(['integration:integration', 'intake:intake'])
    expect(router.handles('verification')).toBe(false)
    await expect(router.run(work('verification'))).rejects.toThrow('no handler for stage verification')
  })
})

describe('integration through the stage router', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ns-intake-router-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('an integration-stage issue still opens its PR through IntegrationHandler', async () => {
    let h: ReturnType<typeof integrationHarness> | undefined
    h = integrationHarness(dir, (c) => c, {
      stageHandler: new StageRouter({
        integration: { run: (w) => (h as ReturnType<typeof integrationHarness>).handler.run(w) },
      }),
    })
    await h.integrated()
    expect(h.gh.gh('create').length).toBe(1)
    expect(h.of('PR_CREATED').map((e) => e.issue)).toEqual(['FOR-1'])
  })
})
