import type { IssueSnapshot } from './linear'
import type { Run } from './records'

export type FailureClass =
  | 'environment'
  | 'implementation_defect'
  | 'insufficient_context'
  | 'task_too_large'
  | 'missing_dependency'
  | 'architectural_conflict'
  | 'capability_limit'
  | 'unknown'

export type Remediation =
  | 'retry_same'
  | 'repair'
  | 'best_of'
  | 'enrich_context'
  | 'split'
  | 'create_blocker'
  | 'escalate_lead'
  | 'escalate_user'
  | 'pause_dispatch'

export type Classification = {
  class: FailureClass
  action: Remediation
  evidence?: string
  fallback?: boolean
}

export type FailureSignal = { run: Run; reason: string; detail?: string }

export interface Classifier {
  classify(f: FailureSignal): Promise<Classification>
}

export interface RemediationHandler {
  handle(run: Run, c: Classification): Promise<'handled' | 'unhandled'>
}

export type ReplanIssue = { title: string; description: string }

export type ReplanReport = {
  action: 'split' | 'create_blocker' | 'escalate_lead'
  sub_issues?: ReplanIssue[]
  blocker?: ReplanIssue
  reason: string
}

export type ReplanRequest = {
  run: Run
  issue: IssueSnapshot
  classification: Classification
  detail?: string
}

export interface Replanner {
  /** Null when the call failed or its output did not match the schema. */
  replan(r: ReplanRequest): Promise<ReplanReport | null>
}
