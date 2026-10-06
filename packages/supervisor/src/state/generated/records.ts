// Generated from packages/supervisor/schema/records.schema.json by `bun run gen`; do not edit.
export type Lifecycle =
  | 'triage'
  | 'backlog'
  | 'ready'
  | 'running'
  | 'review'
  | 'blocked'
  | 'done'
  | 'canceled'

/**
 * Rows the CLI prints with --json; read from the state database.
 */
export interface CliRecords {
  issue?: IssueRecord
  worker?: WorkerRecord
  question?: QuestionRecord
  status?: StatusRecord
  diff?: DiffRecord
  tests?: TestsRecord
  [k: string]: unknown
}
export interface IssueRecord {
  identifier: string
  title: string
  project: string | null
  stage: string | null
  lifecycle: Lifecycle | null
  /**
   * Linear workflow state name
   */
  status: string
  /**
   * unfinished blockers
   */
  blockers: string[]
  /**
   * why the issue is not running
   */
  waiting: string | null
  /**
   * agent of the newest run
   */
  agent: string | null
  /**
   * state of the newest run
   */
  agent_state: string | null
  attempt: number
  updated_at: string
}
export interface WorkerRecord {
  run: string
  issue: string
  agent: string
  model: string
  profile: string
  state: string
  attempt: number
  started_at: string
  elapsed_ms: number
  steps: number
  tool_calls: number
  tokens: number
  last_tool: string | null
  diff_lines: number | null
}
export interface QuestionRecord {
  issue: string
  /**
   * Linear comment id of the question
   */
  comment: string
  run: string | null
  asked_to: 'lead' | 'user'
  asked_at: string
  question: string | null
  /**
   * Linear link of the question comment
   */
  url: string | null
}
export interface StatusRecord {
  supervisor: 'running' | 'down'
  dispatch: 'running' | 'paused'
  gateway: 'ok' | 'unavailable' | null
  /**
   * Signal channel; absent when not configured
   */
  signal?: {
    state: 'ok' | 'unavailable' | 'unpaired'
    detail?: string
    since?: string
  }
  profile: string | null
  restart_required: boolean
  held: string[]
  covered: string[]
  workers: WorkerRecord[]
  waiting: {
    identifier: string
    reason: string
  }[]
  questions: QuestionRecord[]
  /**
   * FAILURE_CLASSIFIED events
   */
  failures: {
    [k: string]: unknown
  }[]
}
export interface DiffRecord {
  run: string
  issue: string
  base: string
  head: string
  files: {
    path: string
    /**
     * null for binary files
     */
    added: number | null
    deleted: number | null
  }[]
  patch?: string
}
export interface TestsRecord {
  run: string
  issue: string
  checks: {
    check: string
    passed: boolean
    exit_code: number
    duration_ms: number
    output_tail?: string
    artifact?: string
  }[]
  review: null | {
    verdict: 'pass' | 'fail'
    model?: string
    findings: {
      severity: 'BLOCKER' | 'SUGGESTION'
      file: string
      lines?: string
      message: string
      evidence?: string
      confidence?: number
    }[]
  }
}
