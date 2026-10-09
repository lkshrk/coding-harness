// Generated from packages/supervisor/schema/events.schema.json by `bun run gen`; do not edit.
export type EventType =
  | 'SUPERVISOR_STARTED'
  | 'VAULT_INGEST_STARTED'
  | 'VAULT_INGESTED'
  | 'VAULT_INGEST_FAILED'
  | 'SUPERVISOR_STOPPED'
  | 'CONFIG_RELOADED'
  | 'CONFIG_REJECTED'
  | 'DISPATCH_PAUSED'
  | 'DISPATCH_RESUMED'
  | 'GATEWAY_UNAVAILABLE'
  | 'GATEWAY_RECOVERED'
  | 'STAGE_ENTERED'
  | 'STAGE_COMPLETED'
  | 'DEPENDENCY_UNBLOCKED'
  | 'LEASE_ACQUIRED'
  | 'LEASE_RELEASED'
  | 'LEASE_EXPIRED'
  | 'DISPATCHED'
  | 'RUN_STARTING'
  | 'SANDBOX_CREATED'
  | 'SANDBOX_DESTROYED'
  | 'WORKER_STARTED'
  | 'WORKER_PROGRESS'
  | 'WORKER_STALLED'
  | 'WORKER_FINISHED'
  | 'WORKER_NO_FINISH'
  | 'WORKER_FAILED'
  | 'WIP_COMMITTED'
  | 'GATE_PASSED'
  | 'GATE_FAILED'
  | 'REVIEW_RECEIVED'
  | 'FAILURE_CLASSIFIED'
  | 'QUESTION_ASKED'
  | 'QUESTION_ANSWERED'
  | 'PR_CREATED'
  | 'CI_PASSED'
  | 'CI_FAILED'
  | 'MERGED'
  | 'SINGLE_CALL_INVALID'
  | 'INPUT_OVER_BUDGET'
  | 'NOTIFICATION_SENT'
  | 'MESSAGE_SENT'
  | 'COVERAGE_CHANGED'
/**
 * Linear identifier, e.g. XXX-42
 */
export type IssueRef = string
export type Ulid = string

/**
 * One row of the append-only event log. 'type' selects the shape of 'data'.
 */
export interface EventRecord {
  /**
   * ULID; sortable by time
   */
  id: string
  ts: string
  type: EventType
  issue?: IssueRef
  run?: Ulid
  data: {
    [k: string]: unknown
  }
}
