import type { Config } from '@nightshift/core'
import type { AgentKind, IssueView, ViewOptions } from '../policy/stages'
import type {
  Awaiting,
  Classifier,
  GitHost,
  IssueSnapshot,
  IssueUpdate,
  LinearComment,
  LinearPort,
  Notification,
  Notifier,
  OutboxDirs,
  RemediationHandler,
  RepoInspector,
  RunExecutor,
  SandboxDriver,
  SandboxHandle,
  StageHandler,
  VaultIngest,
  WorkerDriver,
} from '../ports'
import type { By } from '../ports/control'
import type { PullRequestStore } from '../stages/integration/records'
import type { Db } from '../state/db'
import type { Event, EventLog } from '../state/events'
import type { Run, RunStore } from '../state/runs'

export const INGEST_AGENT = 'ingester'

export type SupervisorDeps = {
  config: Config
  db: Db
  linear: LinearPort
  executor: RunExecutor
  sandbox: Pick<SandboxDriver, 'status' | 'list' | 'destroy'>
  worker: Pick<WorkerDriver, 'alive'>
  repos: RepoInspector
  notifier: Notifier
  outbox: OutboxDirs
  agentKind: (agent: string) => AgentKind | undefined
  modelFor: (agent: string, profile: string, config: Config) => string
  classifier?: Classifier
  remediation?: RemediationHandler
  stageHandler?: StageHandler
  gitHost?: GitHost
  ingest?: VaultIngest
  syncVault?: () => Promise<void>
  secretsLocked?: () => Promise<boolean>
  now?: () => Date
  instanceId?: string
  leaseTtlMs?: number
  retry?: { baseMs: number; maxMs: number }
}

export type FinishLike = {
  status?: unknown
  blocker?: { needs?: string; reason?: string; question?: string; options?: string[] }
}

export class SupervisorRuntime {
  constructor(
    readonly deps: SupervisorDeps,
    readonly config: () => Config,
    readonly log: EventLog,
    readonly runs: RunStore,
    readonly pullRequests: PullRequestStore,
    readonly cache: Map<string, IssueSnapshot>,
    readonly now: () => Date,
  ) {}

  requireRun(id: string): Run {
    const run = this.runs.get(id)
    if (!run) throw new Error(`no run ${id}`)
    return run
  }

  meta(key: string): string | undefined {
    return this.deps.db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)
      ?.value
  }

  setMeta(key: string, value: string): void {
    this.deps.db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  metaMap<T>(key: string): Record<string, T> {
    const raw = this.meta(key)
    return raw ? (JSON.parse(raw) as Record<string, T>) : {}
  }

  async postOnce(identifier: string, marker: string, body: string): Promise<LinearComment> {
    const tag = `<!-- nightshift:${marker} -->`
    const existing = (await this.deps.linear.comments(identifier)).find((c) => c.body.includes(tag))
    return existing ?? this.deps.linear.comment(identifier, `${body}\n\n${tag}`)
  }

  async notify(
    title: string,
    issue?: string,
    extra: Omit<Notification, 'title' | 'issue'> = {},
  ): Promise<void> {
    const subject = issue ? this.cache.get(issue)?.title : undefined
    const channel = await this.deps.notifier.notify({
      title,
      ...(issue ? { issue } : {}),
      ...(subject ? { subject } : {}),
      ...extra,
    })
    if (channel) {
      this.log.append({ type: 'NOTIFICATION_SENT', data: { channel, title, ...(issue ? { issue } : {}) } })
    }
  }
}

export type RecoveryReport = {
  reattached: string[]
  resumed: string[]
  failed: string[]
  stopped: string[]
  answered: string[]
  lost: string[]
  orphanSandboxes: string[]
  orphanOutboxes: string[]
}

export type RunFlow = {
  stopped(): boolean
  paused(): boolean
  pause(reason: string, by?: By): void
  schedule(run: Run): void
  cancelSteps(runId: string): Promise<void>
  gatewayReachable(reachable: boolean, reason: string): void
  viewOptions(issue: string): ViewOptions
  awaiting(issue: string): Awaiting | null
  setAwaiting(issue: string, value: Awaiting | null): void
  holdForYou(issue: string, awaiting: Awaiting): Promise<void>
  coveredSet(): Set<string>
  uncover(issue: string): void
  observeIssue(issue: IssueSnapshot): void
  refresh(identifier: string): Promise<void>
  writeStatus(identifier: string, change: IssueUpdate): Promise<void>
  relabel(identifier: string, stage: string, from: string): Promise<void>
  takeLease(run: Run): void
  releaseLease(issue: string): void
  leaseEvent(type: 'LEASE_ACQUIRED', issue: string): void
  askQuestion(run: Run, cause: Event, blocker: NonNullable<FinishLike['blocker']>): Promise<void>
  checkQuestions(): Promise<string[]>
  startIngest(view: IssueView): Promise<void>
  ingestFinished(run: Run, event: Event, finish: FinishLike): Promise<void>
  ingestRunFailed(runId: string, reason: string, cause?: Event): Promise<void>
  workerFailed(runId: string, reason: string, detail?: string): Promise<void>
  stopRun(runId: string, reason: string, by?: By): Promise<void>
  end(runId: string, to: 'done' | 'failed' | 'stopped', cause: Event): Promise<Run>
  resolveRun(target: string): Run | undefined
  completeStage(identifier: string): Promise<void>
  enterVerification(identifier: string): Promise<void>
  backToImplementation(identifier: string): Promise<void>
  forceManual(issue: string, why: string): void
  remediate(run: Run, reason: string, detail?: string): Promise<void>
  recoverRun(run: Run): Promise<void>
  requireActive(target: string): Run
  profileFor(view: IssueView): string
  forgetStalls(runId: string): void
  sandboxDestroyed(runId: string, handle: SandboxHandle): void
  sandboxHandle(run: Run): SandboxHandle
}
