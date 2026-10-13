import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AcceptorOutput, type AgentDef, parseAgent } from '@nightshift/core'
import type { IssueSnapshot } from '../../ports'
import type { Event } from '../../state/events'
import type { Run } from '../../state/runs'
import { harness } from '../../supervisor/testing'
import { snapshot } from '../../testing/testing'
import type { SingleCall } from '../gates'
import { StageRouter } from '../intake/handler'
import { type AcceptanceCallbacks, AcceptanceHandler } from './handler'

const root = join(import.meta.dir, '../../../../..')
const { def } = parseAgent('acceptor.md', readFileSync(join(root, 'agents', 'acceptor.md'), 'utf8'))
const agents = new Map([
  [
    'acceptor',
    { ...def, output: JSON.parse(readFileSync(join(root, 'schemas', 'acceptor.json'), 'utf8')) } as AgentDef,
  ],
])

const parentBody = [
  '## Goal',
  'Export invoices.',
  '## Acceptance criteria',
  '- invoices export as PDF',
  '- exports are logged',
  '',
].join('\n')

function run(id: string, issue: string, finish: unknown): Run {
  return { id, issue, finish } as Run
}

function gate(run: string, check: string, exit_code: number, output_tail: string): Event {
  return {
    id: `e-${run}-${check}`,
    ts: '2026-10-13T00:00:00Z',
    type: exit_code === 0 ? 'GATE_PASSED' : 'GATE_FAILED',
    run,
    data: { check, exit_code, duration_ms: 1, output_tail },
  }
}

function setup(output: AcceptorOutput | null, description = parentBody) {
  const inputs: string[] = []
  const calls: { method: string; args: unknown[] }[] = []
  const comments: { id: string; body: string }[] = []
  const issue = snapshot({ identifier: 'FOR-1', title: 'Invoice export', description })
  const child = snapshot({ identifier: 'FOR-2', title: 'PDF renderer', parent: 'FOR-1' })
  const runs: Record<string, Run[]> = {
    'FOR-1': [],
    'FOR-2': [
      run('r1', 'FOR-2', { summary: 'old attempt' }),
      run('r2', 'FOR-2', { summary: 'renders invoices as PDF', changed_files: ['src/pdf.ts'] }),
    ],
  }
  const events = [gate('r1', 'test', 1, 'old failure'), gate('r2', 'test', 0, '12 pass pdf.test.ts')]
  const cb: AcceptanceCallbacks = {
    completeStage: async (...args) => {
      calls.push({ method: 'completeStage', args })
    },
    holdStage: async (...args) => {
      calls.push({ method: 'holdStage', args })
    },
    log: { since: (_id, filter) => events.filter((e) => e.run === filter?.run) },
    runs: { forIssue: (i) => runs[i] ?? [] },
    gateResults: () => [],
    children: (i): IssueSnapshot[] => (i === 'FOR-1' ? [child] : []),
  }
  const call = (async (_def, input) => {
    inputs.push(input)
    if (!output)
      return { ok: false, reason: 'invalid_output', detail: 'bad json', trace: { sessionId: 's', calls: [] } }
    return { ok: true, output, trace: { sessionId: 's', calls: [] } }
  }) as SingleCall
  const handler = new AcceptanceHandler({
    config: () => harness().config,
    agents,
    gateway: async () => ({ baseUrl: 'http://gateway.test', apiKey: 'test' }),
    linear: {
      comment: async (id, body) => {
        comments.push({ id, body })
        return { id: 'c1', body, createdAt: '', parentId: null, by: 'me' }
      },
    },
    call,
    callbacks: () => cb,
    out: () => {},
  })
  const go = () => handler.run({ issue, stage: 'acceptance', agent: 'acceptor' })
  return { go, inputs, calls, comments }
}

const verdicts = (...v: AcceptorOutput['criteria'][number]['verdict'][]): AcceptorOutput => ({
  criteria: v.map((verdict, i) => ({
    criterion: ['invoices export as PDF', 'exports are logged'][i] as string,
    verdict,
    evidence: `evidence ${i}`,
  })),
})

describe('acceptance stage handler', () => {
  test('all met posts the verdict table and completes the stage', async () => {
    const s = setup(verdicts('met', 'met'))
    await s.go()
    expect(s.comments.length).toBe(1)
    expect(s.comments[0]?.body).toContain('| criterion | verdict | evidence |')
    expect(s.comments[0]?.body).toContain('| invoices export as PDF | met | evidence 0 |')
    expect(s.calls).toEqual([{ method: 'completeStage', args: ['FOR-1'] }])
  })

  test('one not_met holds the issue with the criterion and its evidence', async () => {
    const s = setup(verdicts('met', 'not_met'))
    await s.go()
    expect(s.calls.length).toBe(1)
    const [id, stage, reason, comment] = (s.calls[0]?.args ?? []) as string[]
    expect(s.calls[0]?.method).toBe('holdStage')
    expect([id, stage, reason]).toEqual(['FOR-1', 'acceptance', 'not_met'])
    expect(comment).toContain('- exports are logged: evidence 1')
    expect(comment).not.toContain('invoices export as PDF')
  })

  test('unverifiable without not_met holds with reason unverifiable', async () => {
    const s = setup(verdicts('unverifiable', 'met'))
    await s.go()
    expect(s.calls[0]?.method).toBe('holdStage')
    expect(s.calls[0]?.args.slice(0, 3)).toEqual(['FOR-1', 'acceptance', 'unverifiable'])
    expect(s.calls[0]?.args[3]).toContain('- invoices export as PDF: evidence 0')
  })

  test('not_met wins over unverifiable', async () => {
    const s = setup(verdicts('unverifiable', 'not_met'))
    await s.go()
    expect(s.calls[0]?.args[2]).toBe('not_met')
  })

  test('no criteria holds with no_criteria and calls nothing', async () => {
    const s = setup(verdicts('met'), '## Goal\nExport invoices.\n')
    await s.go()
    expect(s.inputs).toEqual([])
    expect(s.comments).toEqual([])
    expect(s.calls.map((c) => c.args.slice(0, 3))).toEqual([['FOR-1', 'acceptance', 'no_criteria']])
  })

  test('a failed call throws without a comment or callback', async () => {
    const s = setup(null)
    await expect(s.go()).rejects.toThrow('acceptor invalid_output: bad json')
    expect(s.comments).toEqual([])
    expect(s.calls).toEqual([])
  })

  test('the input holds the criteria, the latest gates and each child issue', async () => {
    const s = setup(verdicts('met', 'met'))
    await s.go()
    expect(s.inputs.length).toBe(1)
    const input = s.inputs[0] as string
    expect(input).toContain(
      '--- BEGIN CRITERIA ---\ninvoices export as PDF\nexports are logged\n--- END CRITERIA ---',
    )
    expect(input).toContain('--- BEGIN GATES ---')
    expect(input).toContain('FOR-2 test: exit code 0\n12 pass pdf.test.ts')
    expect(input).not.toContain('old failure')
    expect(input).toContain('--- BEGIN ISSUES ---')
    expect(input).toContain('FOR-1: Invoice export\nsummary: no finish report')
    expect(input).toContain(
      'FOR-2: PDF renderer\nsummary: renders invoices as PDF\nchanged files: src/pdf.ts',
    )
  })
})

describe('acceptance through the supervisor', () => {
  test('an issue entering acceptance gets a verdict and waits for your confirmation', async () => {
    let h: ReturnType<typeof harness> | undefined
    const call = (async () => ({
      ok: true,
      output: { criteria: [{ criterion: 'it works', verdict: 'met', evidence: 'gate test passed' }] },
      trace: { sessionId: 's', calls: [] },
    })) as SingleCall
    const acceptance = new AcceptanceHandler({
      config: () => (h as ReturnType<typeof harness>).config,
      agents,
      gateway: async () => ({ baseUrl: 'http://gateway.test', apiKey: 'test' }),
      linear: { comment: (id, body) => (h as ReturnType<typeof harness>).linear.comment(id, body) },
      call,
      callbacks: () => (h as ReturnType<typeof harness>).sup,
      out: () => {},
    })
    h = harness({ stageHandler: new StageRouter({ acceptance }) })
    h.config.stages.acceptance = { automatic: true, human_checkpoint: 'after' }
    h.linear.put(snapshot({ identifier: 'FOR-1', labels: ['ai-stage:acceptance'] }))
    await h.sup.start()
    for (let i = 0; i < 3; i++) {
      await h.sup.tick()
      await Bun.sleep(5)
    }
    expect(h.sup.awaiting('FOR-1')).toEqual({ kind: 'after', stage: 'acceptance' })
    const comments = h.linear.threads.get('FOR-1') ?? []
    expect(comments.some((c) => c.body.includes('| it works | met | gate test passed |'))).toBe(true)
    expect(comments.some((c) => c.body.includes('no handler for stage acceptance'))).toBe(false)
  })
})
