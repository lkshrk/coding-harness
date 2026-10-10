import type { Config } from '@nightshift/core'
import type { Awaiting, LifecycleState } from '../ports'
import { IMPLEMENTATION, INTEGRATION, type IssueView, VERIFICATION } from './stages'

export type Intent =
  | { kind: 'dispatched' }
  | { kind: 'prOpened' }
  | { kind: 'merged' }
  | { kind: 'prClosed' }
  | { kind: 'heldForUser'; awaiting?: Awaiting }
  | { kind: 'released' }
  | { kind: 'retryRequested' }
  | { kind: 'stageEntered'; stage: string; from?: string }
  | { kind: 'unblocked' }
  | { kind: 'lost' }
  | { kind: 'humanChanged'; to: LifecycleState }

export type RunAction = 'stop' | 'stopKeepWip' | 'none'

export type Transition = {
  status?: LifecycleState
  stage?: string
  awaiting?: Awaiting | null
  runAction?: RunAction
  log: string
}

export type TransitionContext = { config: Config }

type Rule<I extends Intent> = (current: IssueView, intent: I, ctx: TransitionContext) => Transition
type Cell<I extends Intent> = Rule<I> | 'ignore'
type Table = { [K in Intent['kind']]: Record<LifecycleState, Cell<Extract<Intent, { kind: K }>>> }

const LIVE = ['triage', 'backlog', 'ready', 'running', 'review', 'blocked'] as const

function cells<I extends Intent>(
  rule: Rule<I>,
  states: readonly LifecycleState[] = LIVE,
): Record<LifecycleState, Cell<I>> {
  const all: LifecycleState[] = [...LIVE, 'done', 'canceled']
  return Object.fromEntries(all.map((s) => [s, states.includes(s) ? rule : 'ignore'])) as Record<
    LifecycleState,
    Cell<I>
  >
}

const humanRunAction: Record<LifecycleState, RunAction> = {
  triage: 'stop',
  backlog: 'stopKeepWip',
  ready: 'stopKeepWip',
  running: 'none',
  review: 'stop',
  blocked: 'stop',
  done: 'stop',
  canceled: 'stop',
}

export const RULES: Table = {
  dispatched: cells(() => ({ status: 'running', log: 'dispatched' })),
  prOpened: cells(() => ({ status: 'review', log: 'pull request opened' })),
  merged: cells(
    (current) =>
      current.awaiting?.kind === 'after'
        ? { log: `merged; ${current.awaiting.stage} waits for your check` }
        : { status: 'done', log: 'merged' },
    [...LIVE, 'done'],
  ),
  prClosed: cells(() => ({
    status: 'blocked',
    awaiting: { kind: 'escalated', stage: INTEGRATION },
    log: 'pull request closed without merge; held for you',
  })),
  heldForUser: cells((_, intent) =>
    intent.awaiting
      ? { status: 'blocked', awaiting: intent.awaiting, log: `held for you (${intent.awaiting.kind})` }
      : { status: 'blocked', log: 'held for you' },
  ),
  released: cells((current) => ({
    ...(current.lifecycle === 'blocked' ? { status: 'ready' as const } : {}),
    awaiting: null,
    log: 'released',
  })),
  retryRequested: cells((current) => {
    const back = current.stage === VERIFICATION || current.stage === INTEGRATION
    return {
      status: 'ready',
      ...(back ? { stage: IMPLEMENTATION } : {}),
      awaiting: null,
      runAction: current.lifecycle === 'running' ? 'stop' : 'none',
      log: back ? `retry from ${current.stage}; back to ${IMPLEMENTATION}, pull request kept` : 'retry',
    }
  }),
  stageEntered: cells((_, intent, ctx) => {
    const hold = ctx.config.stages[intent.stage]?.human_checkpoint === 'before'
    return {
      stage: intent.stage,
      ...(hold ? { status: 'blocked' as const } : {}),
      awaiting: hold ? { kind: 'before', stage: intent.stage } : null,
      log: `entered ${intent.stage}${intent.from ? ` from ${intent.from}` : ''}${hold ? '; waits for your approval' : ''}`,
    }
  }),
  unblocked: cells(() => ({ status: 'ready', log: 'blockers done' }), ['backlog']),
  lost: cells(() => ({ status: 'ready', log: 'runtime state lost; dispatched again' }), ['running']),
  humanChanged: cells(
    (current, intent) => {
      const runAction = humanRunAction[intent.to]
      const log = `status changed to ${intent.to} by you; run ${runAction}`
      if (intent.to === 'blocked')
        return { awaiting: { kind: 'escalated', stage: current.stage ?? '' }, runAction, log }
      if (intent.to === 'done' || intent.to === 'canceled') return { awaiting: null, runAction, log }
      return { runAction, log }
    },
    ['running'],
  ),
}

export function transition(current: IssueView, intent: Intent, ctx: TransitionContext): Transition {
  if (current.lifecycle === null)
    return { log: `${intent.kind} ignored: status ${current.snapshot.status} is not mapped` }
  const cell = RULES[intent.kind][current.lifecycle] as Cell<Intent>
  if (cell === 'ignore') return { log: `${intent.kind} ignored in ${current.lifecycle}` }
  return cell(current, intent, ctx)
}
