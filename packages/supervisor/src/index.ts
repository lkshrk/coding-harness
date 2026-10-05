import { NIGHTSHIFT_VERSION } from '@nightshift/core'

export { changedPaths, restartRequired, type WatchOptions, watchConfig } from './config-watch'
export { acquireLock, type Db, MIGRATIONS, openState, openStateReadOnly, STATE_DB, statePath } from './db'
export { EVENT_TYPES, type EventInput, type EventType, validateEvent } from './event-schema'
export { type Event, type EventFilter, EventLog, EventValidationError } from './events'
export {
  GitHubAuthError,
  GitHubTokens,
  type GitHubTokensOptions,
  GitHubUnauthorizedError,
  gitAuthEnv,
  githubOwner,
  TOKEN_TTL_MS,
} from './github-tokens'
export { duplicateInput, findCandidates, findDuplicates, type IntakeDeps } from './intake/duplicates'
export { intakeInput, runIntake } from './intake/intake'
export type * from './interfaces'
export { type Lease, LeaseStore } from './leases'
export { createLinearPort, type LinearPortOptions } from './linear-adapter'
export { agentResolver, type LoopOptions, runSupervisor } from './loop'
export type * from './ports'
export { blockersSatisfied, type DispatchPlan, filesOverlap, planDispatch, type RunningIssue } from './ready'
export { type RetryEntry, RetryQueue } from './retry'
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
} from './runs'
export { type SelectionContext, selectAgent } from './selection'
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
} from './stages'
export { type OpenQuestion, readStatus, type SupervisorStatus, type Waiting } from './status'
export {
  type By,
  fallbackClassifier,
  type RecoveryReport,
  type SandboxCreatedInfo,
  Supervisor,
  type SupervisorDeps,
  type TickReport,
  type WorkerStartedInfo,
} from './supervisor'
export { createUlid, ulidTime } from './ulid'
export * from './worker'

export function supervisorVersion(): string {
  return NIGHTSHIFT_VERSION
}
export * from './compose'
export * from './context'
export { coveredIssues, heldIssues, setCovered, setHeld } from './coverage'
export * from './gates'
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
} from './generated/control'
export type {
  DiffRecord,
  IssueRecord,
  QuestionRecord,
  StatusRecord,
  TestsRecord,
  WorkerRecord,
} from './generated/records'
export * from './integration'
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
} from './records'
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
} from './signal'
export * from './socket'
export { branchOf } from './worker/executor'
