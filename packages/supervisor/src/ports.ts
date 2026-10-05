import type { LinearWorkspace } from '@nightshift/core'
import type { Event } from './events'
import type { PullRequestRecord } from './integration/records'
import type { Run } from './runs'

export type LifecycleState =
  | 'triage'
  | 'backlog'
  | 'ready'
  | 'running'
  | 'review'
  | 'blocked'
  | 'done'
  | 'canceled'

export type MergeMode = 'manual' | 'auto' | 'feature-branch'

export type Awaiting = { kind: 'before' | 'after' | 'escalated'; stage: string }

export type BlockerRef = { identifier: string; team: string; status: string }

export type IssueSnapshot = {
  id: string
  identifier: string
  title: string
  team: string
  status: string
  stateType?: string
  completedAt?: string | null
  canceledAt?: string | null
  // grouped labels as `<group>:<name>` with the group lowercased (stage:implementation, agent:human, repo:omni)
  labels: string[]
  delegated: boolean
  project: { id: string; name: string; initiatives: string[]; labels: string[] } | null
  priority: number
  estimate: number | null
  createdAt: string
  updatedAt: string
  description: string
  blockedBy: BlockerRef[]
}

export type LinearComment = {
  id: string
  body: string
  createdAt: string
  parentId: string | null
  by: string
}

export type IssueUpdate = {
  status?: LifecycleState
  stage?: string
}

export interface LinearPort {
  workspace(): Promise<LinearWorkspace>
  issues(q: { updatedSince?: string }): Promise<IssueSnapshot[]>
  candidates(q: { team: string; project: string | null; closedSince: string }): Promise<IssueSnapshot[]>
  issue(identifier: string): Promise<IssueSnapshot | null>
  comments(identifier: string): Promise<LinearComment[]>
  update(identifier: string, change: IssueUpdate): Promise<void>
  comment(identifier: string, body: string, opts?: { parentId?: string }): Promise<LinearComment>
  attachLink(identifier: string, url: string, title: string): Promise<void>
}

export type VaultIngestPrepared = {
  repository: string
  baseSha: string
  files: string[]
  sourceFiles: { path: string; content: string }[]
}

export interface VaultIngest {
  prepare(input: {
    issue: IssueSnapshot
    repository: string
    date: string
    events: Event[]
    pr: PullRequestRecord | null
  }): Promise<VaultIngestPrepared>
  publish(run: Run): Promise<string[]>
}

export type ExecutorStart = {
  run: Run
  issue: IssueSnapshot
  files: string[]
  sourceFiles?: { path: string; content: string }[]
  repairFrom?: { run: string; headSha: string }
}

export interface RunExecutor {
  start(s: ExecutorStart): Promise<void>
  reattach(run: Run): Promise<void>
  runStep(run: Run): Promise<void>
  nudge(run: Run, message: string): Promise<void>
  stop(run: Run, reason: string): Promise<void>
  detach?(): void
  captureHead?(run: Run): Promise<string | undefined>
}

export interface RepoInspector {
  baseSha(repository: string): Promise<string>
}

export type NotificationKind = 'question' | 'blocked' | 'pr' | 'failed' | 'ci' | 'paused' | 'info'

export type Notification = {
  title: string
  issue?: string
  kind?: NotificationKind
  url?: string
  question?: { comment: string; text: string; options?: string[] }
  subject?: string
  context?: string[]
  action?: string
}

export interface Notifier {
  notify(n: Notification): Promise<'linear' | 'macos' | 'ntfy' | 'signal' | null>
}

export interface OutboxDirs {
  list(): string[]
  remove(run: string): void
}

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

export type StageWork = { issue: IssueSnapshot; stage: string; agent: string | undefined }

export interface StageHandler {
  run(work: StageWork): Promise<void>
}
