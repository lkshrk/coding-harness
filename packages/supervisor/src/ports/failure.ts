import type { Run } from '../state/runs'

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
