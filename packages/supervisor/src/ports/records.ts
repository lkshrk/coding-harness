import type { EventType } from './generated/events'

export type { EventType }

export const RUN_STATES = [
  'queued',
  'starting',
  'running',
  'finishing',
  'gating',
  'reviewing',
  'done',
  'failed',
  'stopped',
] as const

export type RunState = (typeof RUN_STATES)[number]

export type NewRun = {
  issue: string
  agent: string
  profile: string
  model: string
  repository: string
  baseSha: string
  attempt: number
}

export type Run = NewRun & {
  id: string
  state: RunState
  sandbox: string | null
  session: string | null
  headSha: string | null
  finish: unknown
  failure: string | null
  startedAt: string
  endedAt: string | null
  tokensIn: number
  tokensOut: number
}

export type EventInput = { type: EventType; issue?: string; run?: string; data: Record<string, unknown> }

export type Event = EventInput & { id: string; ts: string }
