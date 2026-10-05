import { NIGHTSHIFT_VERSION } from '@nightshift/core'

export {
  GitHubAuthError,
  GitHubTokens,
  type GitHubTokensOptions,
  GitHubUnauthorizedError,
  gitAuthEnv,
  githubOwner,
  TOKEN_TTL_MS,
} from './adapters/github/github-tokens'
export { createLinearPort, type LinearPortOptions } from './adapters/linear/linear-adapter'
export * from './adapters/worker'
export {
  blockersSatisfied,
  type DispatchPlan,
  filesOverlap,
  planDispatch,
  type RunningIssue,
} from './policy/ready'
export { type RetryEntry, RetryQueue } from './policy/retry'
export { type SelectionContext, selectAgent } from './policy/selection'
export {
  type AgentKind,
  type DecideContext,
  type Decision,
  decide,
  type IssueView,
  labelValue,
  lifecycleOf,
  nextStage,
  viewIssue,
} from './policy/stages'
export type * from './ports/interfaces'
export type * from './ports/ports'
export { changedPaths, restartRequired, type WatchOptions, watchConfig } from './runtime/config-watch'
export { agentResolver, type LoopOptions, runSupervisor } from './runtime/loop'
export { duplicateInput, findCandidates, findDuplicates, type IntakeDeps } from './stages/intake/duplicates'
export { intakeInput, runIntake } from './stages/intake/intake'
export {
  acquireLock,
  type Db,
  MIGRATIONS,
  openState,
  openStateReadOnly,
  STATE_DB,
  statePath,
} from './state/db'
export { EVENT_TYPES, type EventInput, type EventType, validateEvent } from './state/event-schema'
export { type Event, type EventFilter, EventLog, EventValidationError } from './state/events'
export { type Lease, LeaseStore } from './state/leases'
export {
  canTransition,
  isTerminal,
  type NewRun,
  RUN_STATES,
  type Run,
  type RunState,
  RunStore,
  RunTransitionError,
  type RunUpdate,
} from './state/runs'
export { type OpenQuestion, readStatus, type SupervisorStatus, type Waiting } from './state/status'
export { createUlid, ulidTime } from './state/ulid'
export {
  type By,
  fallbackClassifier,
  type RecoveryReport,
  type SandboxCreatedInfo,
  Supervisor,
  type SupervisorDeps,
  type TickReport,
  type WorkerStartedInfo,
} from './supervisor/supervisor'

export function supervisorVersion(): string {
  return NIGHTSHIFT_VERSION
}
export {
  PAIRING_TTL_MS,
  readSignalState,
  resolveTarget,
  SignalApi,
  SignalApiError,
  type SignalSettings,
  type SignalState,
  signalApi,
  startPairing,
} from './adapters/signal'
export { branchOf } from './adapters/worker/executor'
export type {
  AnswerRequest,
  AttachInfo,
  CoverRequest,
  ErrorResponse,
  Health,
  Ok,
  PauseRequest,
  RetryRequest,
  RunResponse,
  SendRequest,
  StopRequest,
} from './control/generated/control'
export * from './control/socket'
export * from './runtime/compose'
export * from './stages/context'
export { ingestConfig, VAULT_REPOSITORY } from './stages/context/ingest-runtime'
export * from './stages/gates'
export * from './stages/integration'
export { coveredIssues, heldIssues, setCovered, setHeld } from './state/coverage'
export type {
  DiffRecord,
  IssueRecord,
  QuestionRecord,
  StatusRecord,
  TestsRecord,
  WorkerRecord,
} from './state/generated/records'
export {
  commentUrl,
  type EventQuery,
  eventsAfter,
  issueRecords,
  newestEventId,
  questionRecords,
  runStore,
  workerRecord,
  workerRecords,
} from './state/records'
