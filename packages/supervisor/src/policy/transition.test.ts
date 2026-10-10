import { describe, expect, test } from 'bun:test'
import type { Awaiting, LifecycleState } from '../ports'
import { snapshot, testConfig } from '../testing/testing'
import { type ViewOptions, viewIssue } from './stages'
import { type Intent, RULES, transition } from './transition'

const config = testConfig()
const ctx = { config }

const STATUS: Record<LifecycleState, string> = {
  triage: 'Backlog',
  backlog: 'Backlog',
  ready: 'Todo',
  running: 'In Progress',
  review: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
  canceled: 'Canceled',
}
const STATES = Object.keys(STATUS) as LifecycleState[]

const view = (lifecycle: LifecycleState, stage = 'implementation', opts: ViewOptions = {}) => {
  const v = viewIssue(
    snapshot({ identifier: 'FOR-1', status: STATUS[lifecycle], labels: [`ai-stage:${stage}`] }),
    config,
    opts,
  )
  if (!v) throw new Error('unmanaged')
  return { ...v, lifecycle }
}

const INTENTS: Intent[] = [
  { kind: 'dispatched' },
  { kind: 'prOpened' },
  { kind: 'merged' },
  { kind: 'prClosed' },
  { kind: 'heldForUser', awaiting: { kind: 'escalated', stage: 'implementation' } },
  { kind: 'released' },
  { kind: 'retryRequested' },
  { kind: 'stageEntered', stage: 'verification', from: 'implementation' },
  { kind: 'unblocked' },
  { kind: 'lost' },
  ...STATES.map((to) => ({ kind: 'humanChanged' as const, to })),
]

const LIVE: LifecycleState[] = ['triage', 'backlog', 'ready', 'running', 'review', 'blocked']
const escalated = (stage: string): Awaiting => ({ kind: 'escalated', stage })

const expected: Record<Exclude<Intent['kind'], 'humanChanged'>, Partial<Record<LifecycleState, object>>> = {
  dispatched: Object.fromEntries(LIVE.map((s) => [s, { status: 'running' }])),
  prOpened: Object.fromEntries(LIVE.map((s) => [s, { status: 'review' }])),
  merged: Object.fromEntries([...LIVE, 'done'].map((s) => [s, { status: 'done' }])),
  prClosed: Object.fromEntries(
    LIVE.map((s) => [s, { status: 'blocked', awaiting: escalated('integration') }]),
  ),
  heldForUser: Object.fromEntries(
    LIVE.map((s) => [s, { status: 'blocked', awaiting: escalated('implementation') }]),
  ),
  released: Object.fromEntries(
    LIVE.map((s) => [s, s === 'blocked' ? { status: 'ready', awaiting: null } : { awaiting: null }]),
  ),
  retryRequested: Object.fromEntries(
    LIVE.map((s) => [s, { status: 'ready', awaiting: null, runAction: s === 'running' ? 'stop' : 'none' }]),
  ),
  stageEntered: Object.fromEntries(LIVE.map((s) => [s, { stage: 'verification', awaiting: null }])),
  unblocked: { backlog: { status: 'ready' } },
  lost: { running: { status: 'ready' } },
}

describe('transition rule table', () => {
  test('every intent has a rule or an explicit ignore for every lifecycle state', () => {
    for (const rules of Object.values(RULES)) expect(Object.keys(rules).sort()).toEqual([...STATES].sort())
    expect(Object.keys(RULES).sort()).toEqual([...new Set(INTENTS.map((i) => i.kind))].sort())
  })

  for (const intent of INTENTS) {
    if (intent.kind === 'humanChanged') continue
    for (const state of STATES) {
      test(`${intent.kind} in ${state}`, () => {
        const result = transition(view(state), intent, ctx)
        const want = expected[intent.kind][state]
        expect(result.log).toBeString()
        if (want === undefined) {
          expect(RULES[intent.kind][state]).toBe('ignore')
          expect(result).toEqual({ log: expect.stringContaining('ignored') })
        } else expect(result).toMatchObject(want)
        if (want)
          for (const key of ['status', 'stage', 'awaiting', 'runAction'] as const)
            if (!(key in want)) expect(result[key]).toBeUndefined()
      })
    }
  }

  test('an unmapped status is ignored', () => {
    const v = { ...view('ready'), lifecycle: null }
    expect(transition(v, { kind: 'dispatched' }, ctx)).toEqual({ log: expect.stringContaining('not mapped') })
  })

  test('merged keeps the status while an after checkpoint waits for you', () => {
    const v = view('review', 'integration', { awaiting: { kind: 'after', stage: 'integration' } })
    const result = transition(v, { kind: 'merged' }, ctx)
    expect(result.status).toBeUndefined()
  })

  test('heldForUser without awaiting only blocks', () => {
    expect(transition(view('running'), { kind: 'heldForUser' }, ctx)).toMatchObject({ status: 'blocked' })
    expect(transition(view('running'), { kind: 'heldForUser' }, ctx).awaiting).toBeUndefined()
  })

  test('stageEntered into a before checkpoint blocks and awaits approval', () => {
    const cfg = testConfig()
    cfg.stages.verification = { ...cfg.stages.verification, human_checkpoint: 'before' } as never
    const result = transition(view('ready'), { kind: 'stageEntered', stage: 'verification' }, { config: cfg })
    expect(result).toMatchObject({
      stage: 'verification',
      status: 'blocked',
      awaiting: { kind: 'before', stage: 'verification' },
    })
  })
})

describe('humanChanged on a running issue', () => {
  const cases: [LifecycleState, string, object][] = [
    ['backlog', 'requeue', { runAction: 'stopKeepWip' }],
    ['ready', 'requeue', { runAction: 'stopKeepWip' }],
    ['blocked', 'hold', { runAction: 'stopKeepWip', awaiting: escalated('implementation') }],
    ['canceled', 'drop', { status: 'canceled', runAction: 'stop', awaiting: null }],
    ['done', 'finish', { status: 'done', runAction: 'stopKeepWip', awaiting: null }],
    ['running', 'continue', { runAction: 'none' }],
  ]
  for (const [to, outcome, want] of cases) {
    test(`to ${to}: ${outcome}`, () => {
      const result = transition(view('running'), { kind: 'humanChanged', to }, ctx)
      expect(result).toEqual({ ...want, log: expect.stringContaining(outcome) })
    })
  }

  test('hold, finish, drop and requeue produce distinct writes', () => {
    const actionable = (to: LifecycleState) => {
      const { log: _, ...rest } = transition(view('running'), { kind: 'humanChanged', to }, ctx)
      return JSON.stringify(rest)
    }
    const outcomes = ['backlog', 'blocked', 'done', 'canceled', 'running'] as const
    expect(new Set(outcomes.map(actionable)).size).toBe(outcomes.length)
  })

  test('is ignored when no run is live', () => {
    for (const state of STATES.filter((s) => s !== 'running'))
      expect(RULES.humanChanged[state]).toBe('ignore')
  })
})

describe('retryRequested', () => {
  test('from integration with an open PR returns to implementation and keeps the PR', () => {
    const v = view('review', 'integration')
    const result = transition(v, { kind: 'retryRequested' }, ctx)
    expect(result).toMatchObject({
      status: 'ready',
      stage: 'implementation',
      awaiting: null,
      runAction: 'none',
    })
    expect(result.log).toContain('pull request kept')
  })

  test('from verification returns to implementation', () => {
    expect(transition(view('blocked', 'verification'), { kind: 'retryRequested' }, ctx).stage).toBe(
      'implementation',
    )
  })

  test('in implementation keeps the stage and stops a live run', () => {
    const result = transition(view('running'), { kind: 'retryRequested' }, ctx)
    expect(result.stage).toBeUndefined()
    expect(result.runAction).toBe('stop')
  })
})
