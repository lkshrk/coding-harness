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
  | { kind: 'retryScheduled' }
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

// Operator status change on a running issue: Backlog or Todo re-queue keeping a WIP commit,
// Blocked hold (WIP kept, escalated to you), Done finish (WIP kept, terminal), Canceled drop
// (WIP discarded, terminal). Triage and Review take the run off the queue without keeping WIP.
type HumanOutcome = 'requeue' | 'hold' | 'finish' | 'drop' | 'continue' | 'stop'

const humanOutcome: Record<LifecycleState, HumanOutcome> = {
  triage: 'stop',
  backlog: 'requeue',
  ready: 'requeue',
  running: 'continue',
  review: 'stop',
  blocked: 'hold',
  done: 'finish',
  canceled: 'drop',
}

function humanChange(current: IssueView, to: LifecycleState): Transition {
  const outcome = humanOutcome[to]
  const log = `status changed to ${to} by you; ${outcome}`
  switch (outcome) {
    case 'requeue':
      return { runAction: 'stopKeepWip', log: `${log}, work in progress kept` }
    case 'hold':
      return {
        runAction: 'stopKeepWip',
        awaiting: { kind: 'escalated', stage: current.stage ?? '' },
        log: `${log}, work in progress kept until you release it`,
      }
    case 'finish':
      return {
        status: 'done',
        runAction: 'stopKeepWip',
        awaiting: null,
        log: `${log}, work in progress kept`,
      }
    case 'drop':
      return {
        status: 'canceled',
        runAction: 'stop',
        awaiting: null,
        log: `${log}, work in progress discarded`,
      }
    case 'continue':
      return { runAction: 'none', log }
    case 'stop':
      return { runAction: 'stop', log }
  }
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
  // Supervisor retry of the same stage after a classified failure: only back to ready.
  retryScheduled: cells(() => ({ status: 'ready', log: 'retry of the same stage scheduled' })),
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
  humanChanged: cells((current, intent) => humanChange(current, intent.to), ['running']),
}

export function transition(current: IssueView, intent: Intent, ctx: TransitionContext): Transition {
  if (current.lifecycle === null)
    return { log: `${intent.kind} ignored: status ${current.snapshot.status} is not mapped` }
  const cell = RULES[intent.kind][current.lifecycle] as Cell<Intent>
  if (cell === 'ignore') return { log: `${intent.kind} ignored in ${current.lifecycle}` }
  return cell(current, intent, ctx)
}
