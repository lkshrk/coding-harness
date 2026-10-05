import type { Db } from './db'
import type { Event } from './events'

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

const TERMINAL: readonly RunState[] = ['done', 'failed', 'stopped']

const NEXT: Record<RunState, readonly RunState[]> = {
  queued: ['starting'],
  starting: ['running'],
  running: ['finishing', 'gating'],
  finishing: ['gating'],
  gating: ['reviewing'],
  reviewing: ['done'],
  done: [],
  failed: [],
  stopped: [],
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL.includes(state)
}

export function canTransition(from: RunState, to: RunState): boolean {
  if (isTerminal(from)) return false
  return to === 'failed' || to === 'stopped' || NEXT[from].includes(to)
}

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

export type RunUpdate = Partial<
  Pick<Run, 'sandbox' | 'session' | 'headSha' | 'finish' | 'failure' | 'tokensIn' | 'tokensOut'>
>

export class RunTransitionError extends Error {
  override name = 'RunTransitionError'
}

type Row = {
  id: string
  issue: string
  agent: string
  profile: string
  model: string
  repository: string
  base_sha: string
  attempt: number
  state: RunState
  sandbox: string | null
  session: string | null
  head_sha: string | null
  finish: string | null
  failure: string | null
  started_at: string
  ended_at: string | null
  tokens_in: number
  tokens_out: number
}

const COLUMNS: Record<keyof RunUpdate, keyof Row> = {
  sandbox: 'sandbox',
  session: 'session',
  headSha: 'head_sha',
  finish: 'finish',
  failure: 'failure',
  tokensIn: 'tokens_in',
  tokensOut: 'tokens_out',
}

function fromRow(r: Row): Run {
  return {
    id: r.id,
    issue: r.issue,
    agent: r.agent,
    profile: r.profile,
    model: r.model,
    repository: r.repository,
    baseSha: r.base_sha,
    attempt: r.attempt,
    state: r.state,
    sandbox: r.sandbox,
    session: r.session,
    headSha: r.head_sha,
    finish: r.finish === null ? null : JSON.parse(r.finish),
    failure: r.failure,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
  }
}

export class RunStore {
  private readonly now: () => Date
  private readonly ulid: () => string

  constructor(
    private readonly db: Db,
    opts: { now: () => Date; ulid: () => string },
  ) {
    this.now = opts.now
    this.ulid = opts.ulid
  }

  create(r: NewRun): Run {
    const id = this.ulid()
    this.db
      .query(
        `INSERT INTO runs (id, issue, agent, profile, model, repository, base_sha, attempt, state, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(
        id,
        r.issue,
        r.agent,
        r.profile,
        r.model,
        r.repository,
        r.baseSha,
        r.attempt,
        this.now().toISOString(),
      )
    return this.require(id)
  }

  get(id: string): Run | undefined {
    const row = this.db.query<Row, [string]>('SELECT * FROM runs WHERE id = ?').get(id)
    return row ? fromRow(row) : undefined
  }

  transition(id: string, to: RunState, cause: Event): Run {
    const run = this.require(id)
    if (!canTransition(run.state, to)) {
      throw new RunTransitionError(`${run.state} → ${to} not allowed (run ${id}, cause ${cause.type})`)
    }
    const endedAt = isTerminal(to) ? this.now().toISOString() : null
    this.db.query('UPDATE runs SET state = ?, ended_at = ? WHERE id = ?').run(to, endedAt, id)
    return this.require(id)
  }

  update(id: string, fields: RunUpdate): Run {
    const entries = Object.entries(fields) as [keyof RunUpdate, unknown][]
    if (entries.length) {
      const set = entries.map(([k]) => `${COLUMNS[k]} = ?`).join(', ')
      const values = entries.map(([k, v]) =>
        k === 'finish' && v !== null ? JSON.stringify(v) : (v as string | number | null),
      )
      this.db.query(`UPDATE runs SET ${set} WHERE id = ?`).run(...values, id)
    }
    return this.require(id)
  }

  active(): Run[] {
    return this.db
      .query<Row, []>("SELECT * FROM runs WHERE state NOT IN ('done','failed','stopped') ORDER BY id")
      .all()
      .map(fromRow)
  }

  forIssue(issue: string): Run[] {
    return this.db
      .query<Row, [string]>('SELECT * FROM runs WHERE issue = ? ORDER BY attempt, id')
      .all(issue)
      .map(fromRow)
  }

  private require(id: string): Run {
    const run = this.get(id)
    if (!run) throw new RunTransitionError(`no run ${id}`)
    return run
  }
}
