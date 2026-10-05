import {
  type Config,
  formatError,
  GatewayError,
  LABEL_GROUPS,
  type LoadResult,
  NIGHTSHIFT_VERSION,
  profileEntries,
  teamStatuses,
  validateAgainstWorkspace,
} from '@nightshift/core'
import { changedPaths, restartRequired } from './config-watch'
import { TaskTooLargeError } from './context'
import { coveredIssues, heldIssues, setCovered, setHeld } from './coverage'
import type { Db } from './db'
import { type Event, EventLog, EventValidationError } from './events'
import { type GateEventData, gateComment, gateEventData } from './gates/report'
import { blockerSummary, type ReviewOutcome, reviewComment } from './gates/review'
import { type PullRequestRecord, PullRequestStore } from './integration/records'
import type { CiState, GateResult, GitHost, SandboxDriver, SandboxHandle, WorkerDriver } from './interfaces'
import { type Lease, LeaseStore } from './leases'
import type {
  Awaiting,
  Classification,
  Classifier,
  ExecutorStart,
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
  StageHandler,
  VaultIngest,
} from './ports'
import { planDispatch } from './ready'
import { RetryQueue } from './retry'
import { isTerminal, type Run, RunStore } from './runs'
import { selectAgent } from './selection'
import { ControlError } from './socket/errors'
import { activeRun, isIssueRef, resolveRun } from './socket/targets'
import {
  type AgentKind,
  decide,
  IMPLEMENTATION,
  INTEGRATION,
  type IssueView,
  lifecycleOf,
  nextStage,
  VERIFICATION,
  type ViewOptions,
  viewIssue,
} from './stages'
import { readStatus, type SupervisorStatus, type Waiting } from './status'
import { createUlid } from './ulid'
import type { Progress } from './worker/watch'

export type By = 'cli' | 'supervisor' | 'lead' | 'signal'

type DispatchOverride = { agent?: string; profile?: string; by?: By; continueFrom?: Run }

const LEASE_TTL_MS = 180_000
const RETENTION_MS = 90 * 24 * 3600_000
const ENVIRONMENT_STREAK_PAUSE = 3
const RBW_LOCKED = 'rbw locked'
const ENVIRONMENT_REASONS = ['sandbox_error', 'gateway_error', 'supervisor_restart']
const NO_FINISH_REASONS = ['step_cap', 'time_cap', 'token_cap', 'no_finish']
const CHECKED_REASONS = ['gate_failed', 'review_failed', 'ci_failed']

const STAGE_FAILURE_LIMIT = 3
const INGEST_AGENT = 'ingester'

const TASK_TOO_LARGE_CLASS: Classification = { class: 'task_too_large', action: 'split' }

export const fallbackClassifier: Classifier = {
  async classify(f) {
    if (ENVIRONMENT_REASONS.includes(f.reason)) return { class: 'environment', action: 'retry_same' }
    if (CHECKED_REASONS.includes(f.reason))
      return { class: 'implementation_defect', action: 'retry_same', evidence: f.detail ?? f.reason }
    return { class: 'unknown', action: 'escalate_user', fallback: true }
  },
}

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
  secretsLocked?: () => Promise<boolean>
  now?: () => Date
  instanceId?: string
  leaseTtlMs?: number
  retry?: { baseMs: number; maxMs: number }
}

export type TickReport = { dispatched: string[]; unblocked: string[]; stopped: string[]; waiting: Waiting[] }

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

export type WorkerStartedInfo = { sandbox: string; session: string; attach?: string }

export type SandboxCreatedInfo = { driver: SandboxHandle['driver']; id: string; image: string }

type FinishLike = {
  status?: unknown
  blocker?: { needs?: string; reason?: string; question?: string; options?: string[] }
}

type QuestionRow = { comment: string; issue: string }

export class Supervisor {
  readonly log: EventLog
  readonly runs: RunStore
  readonly leases: LeaseStore
  readonly pullRequests: PullRequestStore
  readonly instanceId: string
  private cfg: Config
  private readonly d: SupervisorDeps
  private readonly now: () => Date
  private readonly retry: RetryQueue
  private readonly cache = new Map<string, IssueSnapshot>()
  private readonly ownWrites = new Map<string, { status: string; previous: string; before: string }>()
  private readonly stalls = new Map<string, number>()
  private readonly roleInFlight = new Set<string>()
  private readonly roleFailures = new Map<string, number>()
  private readonly reviewRefused = new Set<string>()
  private readonly steps = new Map<string, Promise<void>>()
  private cursor: string | undefined
  private paused = false
  private stopped = false
  private environmentStreak = 0

  constructor(deps: SupervisorDeps) {
    this.d = deps
    this.cfg = deps.config
    this.now = deps.now ?? (() => new Date())
    const ulid = createUlid(() => this.now().getTime())
    this.instanceId = deps.instanceId ?? `${process.pid}-${ulid()}`
    this.log = new EventLog(deps.db, { now: this.now, ulid })
    this.runs = new RunStore(deps.db, { now: this.now, ulid })
    this.leases = new LeaseStore(deps.db, {
      now: this.now,
      holder: this.instanceId,
      ttlMs: deps.leaseTtlMs ?? LEASE_TTL_MS,
    })
    this.retry = new RetryQueue(deps.retry ?? { baseMs: 30_000, maxMs: 600_000 })
    this.pullRequests = new PullRequestStore(deps.db)
  }

  get config(): Config {
    return this.cfg
  }

  async start(): Promise<RecoveryReport> {
    const workspace = await this.d.linear.workspace()
    const errors = validateAgainstWorkspace(this.cfg, workspace)
    if (errors.length) throw new Error(errors.map(formatError).join('\n'))
    this.setMeta('instance', this.instanceId)
    this.setMeta('linear_org', workspace.organization.urlKey)
    this.setMeta('active_profile', this.cfg.profiles.active)
    this.setMeta('restart_required', 'false')
    this.paused = this.meta('dispatch') === 'paused'
    this.retain()
    this.log.append({ type: 'SUPERVISOR_STARTED', data: { version: NIGHTSHIFT_VERSION } })
    await this.sync()
    const report = await this.recover()
    return report
  }

  stop(reason = 'stopped'): void {
    if (this.stopped) return
    this.stopped = true
    this.log.append({ type: 'SUPERVISOR_STOPPED', data: { reason } })
  }

  private late(runId: string, what: string): boolean {
    if (this.stopped) console.error(`run ${runId}: ${what} after supervisor stop ignored`)
    return this.stopped
  }

  async idle(): Promise<void> {
    while (this.steps.size > 0) await Promise.allSettled([...this.steps.values()])
  }

  stepsRunning(): string[] {
    return [...this.steps.keys()]
  }

  private schedule(run: Run): void {
    const key = `${run.id}:${run.state}`
    if (this.steps.has(key)) return
    const job = this.d.executor
      .runStep(run)
      .catch((e: unknown) => this.workerFailed(run.id, 'crash', `${run.state}: ${(e as Error).message}`))
      .catch(() => undefined)
      .finally(() => this.steps.delete(key))
    this.steps.set(key, job)
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { dispatched: [], unblocked: [], stopped: [], waiting: [] }
    this.renewLeases()
    for (const lease of this.leases.expired(this.now())) await this.expireLease(lease)
    await this.sync()
    await this.checkQuestions()
    await this.watchPullRequests()
    const views = [...this.cache.values()].flatMap(
      (i) => viewIssue(i, this.cfg, this.viewOptions(i.identifier)) ?? [],
    )
    report.stopped = await this.enforceLinear()
    await this.launchQueued()

    const active = new Set(this.runs.active().map((r) => r.issue))
    const held = new Set(this.held())
    const candidates: IssueView[] = []
    for (const view of views) {
      const id = view.snapshot.identifier
      const decision = decide(view, this.cfg, { agentKind: this.d.agentKind })
      if (decision.kind === 'enter') await this.enterStage(view, decision.stage, decision.from)
      else if (decision.kind === 'advance') await this.advance(view)
      else if (decision.kind === 'release') this.setAwaiting(id, null)
      else if (decision.kind === 'role' && view.stage === VERIFICATION) {
        const idle = view.lifecycle === 'ready' || view.lifecycle === 'backlog'
        if (!active.has(id) && idle) await this.backToImplementation(id)
      } else if (decision.kind === 'role') this.runRole(view, decision.stage, decision.agent)
      else if (decision.kind === 'dispatch' && !active.has(id)) {
        const retry = this.retry.has(id) && !this.retry.due(this.now().getTime()).some((e) => e.issue === id)
        if (held.has(id)) report.waiting.push({ identifier: id, reason: 'held' })
        else if (retry) report.waiting.push({ identifier: id, reason: 'waiting for retry backoff' })
        else candidates.push(view)
      }
    }

    const byId = new Map(views.map((v) => [v.snapshot.identifier, v]))
    const running = this.runs.active().map((r) => ({
      identifier: r.issue,
      repository: r.repository,
      files: byId.get(r.issue)?.files ?? [],
    }))
    await this.probeSecrets(candidates.length > 0 && running.length < this.cfg.limits.concurrency)
    const slots = this.paused ? 0 : Math.max(0, this.cfg.limits.concurrency - running.length)
    const plan = planDispatch({ candidates, running, slots, config: this.cfg })
    for (const { view, by } of plan.unblocked) {
      const id = view.snapshot.identifier
      if (by.length) this.log.append({ type: 'DEPENDENCY_UNBLOCKED', issue: id, data: { by } })
      await this.writeStatus(id, { status: 'ready' })
      report.unblocked.push(id)
    }
    for (const view of plan.dispatch) {
      if (await this.dispatch(view)) report.dispatched.push(view.snapshot.identifier)
    }
    const reason = (w: Waiting) =>
      this.paused && w.reason === 'concurrency limit reached' ? { ...w, reason: 'dispatch paused' } : w
    report.waiting.push(...plan.waiting.map(reason))
    this.setMeta('ready_queue', JSON.stringify(report.waiting))
    this.snapshotIssues(report.waiting)
    return report
  }

  private snapshotIssues(waiting: Waiting[]): void {
    const reasons = new Map(waiting.map((w) => [w.identifier, w.reason]))
    const insert = this.d.db.query(
      `INSERT INTO issues (identifier, title, project, stage, lifecycle, status, blockers, waiting, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.d.db.transaction(() => {
      this.d.db.query('DELETE FROM issues').run()
      for (const issue of this.cache.values()) {
        const view = viewIssue(issue, this.cfg, this.viewOptions(issue.identifier))
        if (!view) continue
        const blockers = issue.blockedBy
          .filter((b) => {
            const state = lifecycleOf(this.cfg, b.team, b.status)
            return state !== 'done' && state !== 'canceled'
          })
          .map((b) => b.identifier)
        const awaiting = view.awaiting ? `awaiting you (${view.awaiting.kind} ${view.awaiting.stage})` : null
        insert.run(
          issue.identifier,
          issue.title,
          issue.project?.name ?? null,
          view.stage,
          view.lifecycle,
          issue.status,
          JSON.stringify(blockers),
          reasons.get(issue.identifier) ?? awaiting,
          issue.updatedAt,
        )
      }
    })()
  }

  pause(reason: string, by: By = 'cli'): void {
    if (this.paused) return
    this.paused = true
    this.setMeta('dispatch', 'paused')
    this.setMeta('dispatch_reason', reason)
    this.log.append({ type: 'DISPATCH_PAUSED', data: { reason, by } })
    if (by === 'cli' || by === 'lead') {
      this.notify(`dispatch paused: ${reason}`, undefined, { kind: 'paused' }).catch(() => {})
    }
  }

  resume(reason: string, by: By = 'supervisor'): void {
    if (!this.paused) return
    this.paused = false
    this.environmentStreak = 0
    this.setMeta('dispatch', 'running')
    this.setMeta('dispatch_reason', '')
    this.log.append({ type: 'DISPATCH_RESUMED', data: { reason, by } })
  }

  private async probeSecrets(dispatching: boolean): Promise<void> {
    if (!this.d.secretsLocked) return
    const lockPaused = this.paused && this.meta('dispatch_reason') === RBW_LOCKED
    if (!lockPaused && (this.paused || !dispatching)) return
    let locked: boolean
    try {
      locked = await this.d.secretsLocked()
    } catch {
      return
    }
    if (locked && !this.paused) {
      this.pause(RBW_LOCKED, 'supervisor')
      const profile = this.cfg.secrets.rbw_profile
      await this.notify(
        `dispatch paused: rbw profile ${profile} is locked; run RBW_PROFILE=${profile} rbw unlock`,
        undefined,
        { kind: 'paused' },
      )
    } else if (!locked && lockPaused) this.resume('rbw unlocked')
  }

  covered(): string[] {
    return coveredIssues(this.d.db)
  }

  cover(issue: string, by: By = 'supervisor'): void {
    this.setCoverage(issue, true, by)
  }

  uncover(issue: string, by: By = 'supervisor'): void {
    this.setCoverage(issue, false, by)
  }

  private setCoverage(issue: string, covered: boolean, by: By): void {
    if (this.coveredSet().has(issue) === covered) return
    setCovered(this.d.db, issue, covered)
    this.log.append({ type: 'COVERAGE_CHANGED', issue, data: { covered, by } })
  }

  gateway(): 'ok' | 'unavailable' {
    const last = this.log.since(null, { types: ['GATEWAY_UNAVAILABLE', 'GATEWAY_RECOVERED'] }).at(-1)
    return last?.type === 'GATEWAY_UNAVAILABLE' ? 'unavailable' : 'ok'
  }

  gatewayReachable(reachable: boolean, reason: string): void {
    if ((this.gateway() === 'ok') === reachable) return
    this.log.append({ type: reachable ? 'GATEWAY_RECOVERED' : 'GATEWAY_UNAVAILABLE', data: { reason } })
  }

  private coveredSet(): Set<string> {
    return new Set(coveredIssues(this.d.db))
  }

  private viewOptions(issue: string): ViewOptions {
    return { covered: this.coveredSet().has(issue), awaiting: this.awaitingMap()[issue] ?? null }
  }

  awaiting(issue: string): Awaiting | null {
    return this.awaitingMap()[issue] ?? null
  }

  private awaitingMap(): Record<string, Awaiting> {
    return this.metaMap<Awaiting>('awaiting')
  }

  private metaMap<T>(key: string): Record<string, T> {
    const raw = this.meta(key)
    return raw ? (JSON.parse(raw) as Record<string, T>) : {}
  }

  private setAwaiting(issue: string, value: Awaiting | null): void {
    const map = this.awaitingMap()
    if (value) map[issue] = value
    else delete map[issue]
    this.setMeta('awaiting', JSON.stringify(map))
  }

  private async holdForYou(issue: string, awaiting: Awaiting): Promise<void> {
    this.setAwaiting(issue, awaiting)
    await this.writeStatus(issue, { status: 'blocked' })
  }

  held(): string[] {
    return heldIssues(this.d.db)
  }

  hold(issue: string, by: By = 'supervisor'): void {
    if (this.held().includes(issue)) return
    setHeld(this.d.db, issue, true)
    this.log.append({ type: 'DISPATCH_PAUSED', issue, data: { reason: `${issue} held`, by } })
  }

  unhold(issue: string, by: By = 'supervisor'): void {
    if (!this.held().includes(issue)) return
    setHeld(this.d.db, issue, false)
    this.log.append({ type: 'DISPATCH_RESUMED', issue, data: { reason: `${issue} released`, by } })
  }

  status(): SupervisorStatus {
    return readStatus(this.d.db)
  }

  escalationCount(issue: string): number {
    return this.runs.forIssue(issue).filter((r) => r.failure !== null && r.failure !== 'environment').length
  }

  async reloadConfig(result: LoadResult): Promise<void> {
    if (!result.ok) {
      const errors = result.errors.map(formatError)
      this.log.append({ type: 'CONFIG_REJECTED', data: { errors } })
      await this.notify(`config rejected: ${errors.join('; ')}`)
      return
    }
    const changed = changedPaths(this.cfg, result.config)
    if (!changed.length) return
    const restart = restartRequired(changed)
    this.cfg = restart
      ? {
          ...result.config,
          paths: this.cfg.paths,
          sandbox: { ...result.config.sandbox, driver: this.cfg.sandbox.driver },
        }
      : result.config
    this.log.append({ type: 'CONFIG_RELOADED', data: { changed, restart_required: restart } })
    if (restart) this.setMeta('restart_required', 'true')
    this.setMeta('active_profile', this.cfg.profiles.active)
    for (const id of [...this.reviewRefused]) {
      this.reviewRefused.delete(id)
      const run = this.runs.get(id)
      if (run?.state === 'reviewing') this.schedule(run)
    }
  }

  async completeStage(identifier: string): Promise<void> {
    const issue = await this.d.linear.issue(identifier)
    const view = issue && viewIssue(issue, this.cfg, this.viewOptions(issue.identifier))
    if (!view?.stage) return
    const def = this.cfg.stages[view.stage]
    if (def?.human_checkpoint === 'after' && view.awaiting?.kind !== 'after') {
      await this.holdForYou(identifier, { kind: 'after', stage: view.stage })
      await this.notify(`${view.stage} finished and waits for your check`, identifier, {
        kind: 'blocked',
        action: `Check the result, then \`ns resume ${identifier}\` to continue`,
      })
      return
    }
    await this.advance(view)
  }

  async sandboxCreated(runId: string, info: SandboxCreatedInfo): Promise<void> {
    if (this.late(runId, 'sandbox created')) return
    this.log.append({ type: 'SANDBOX_CREATED', run: runId, data: info })
  }

  async workerProgress(runId: string, progress: Progress): Promise<void> {
    if (this.late(runId, 'progress')) return
    this.log.append({ type: 'WORKER_PROGRESS', run: runId, data: progress })
  }

  async workerStarted(runId: string, info: WorkerStartedInfo): Promise<void> {
    if (this.late(runId, 'start')) return
    const run = this.runs.update(runId, { sandbox: info.sandbox, session: info.session })
    const event = this.log.append({
      type: 'WORKER_STARTED',
      issue: run.issue,
      run: run.id,
      data: { sandbox: info.sandbox, session: info.session, ...(info.attach ? { attach: info.attach } : {}) },
    })
    this.runs.transition(run.id, 'running', event)
    this.gatewayReachable(true, `worker started for run ${run.id}`)
    if (info.attach) {
      await this.postOnce(
        run.issue,
        event.id,
        `Worker \`${run.agent}\` started (attempt ${run.attempt}). Attach: \`${info.attach}\``,
      )
    }
  }

  async workerStalled(runId: string, signal: string, detail?: string): Promise<void> {
    if (this.late(runId, `stall ${signal}`)) return
    const run = this.requireRun(runId)
    if (isTerminal(run.state)) return
    this.log.append({
      type: 'WORKER_STALLED',
      issue: run.issue,
      run: run.id,
      data: { signal, ...(detail ? { detail } : {}) },
    })
    const count = (this.stalls.get(runId) ?? 0) + 1
    this.stalls.set(runId, count)
    if (count === 1) {
      await this.d.executor.nudge(
        run,
        `nightshift: no progress detected (${signal}); continue or call finish`,
      )
      return
    }
    await this.d.executor.stop(run, `stalled: ${signal}`)
    await this.workerFailed(runId, 'stopped', `stalled: ${signal}`)
  }

  async workerFinished(runId: string, payload: unknown): Promise<void> {
    if (this.late(runId, 'finish')) return
    const run = this.requireRun(runId)
    if (isTerminal(run.state)) return
    let event: Event
    try {
      event = this.log.append({
        type: 'WORKER_FINISHED',
        issue: run.issue,
        run: run.id,
        data: payload as Record<string, unknown>,
      })
    } catch (e) {
      if (!(e instanceof EventValidationError)) throw e
      await this.workerFailed(runId, 'no_finish', e.errors.join('; '))
      return
    }
    this.runs.update(runId, { finish: payload })
    const finish = payload as FinishLike
    if (run.agent === INGEST_AGENT) {
      await this.ingestFinished(run, event, finish)
      return
    }
    if (finish.status === 'DONE' || finish.status === 'DONE_WITH_CONCERNS') {
      const gating = this.runs.transition(runId, 'gating', event)
      await this.enterVerification(run.issue)
      this.schedule(gating)
      return
    }
    await this.end(runId, 'failed', event)
    this.releaseLease(run.issue)
    if (finish.status === 'NEEDS_CONTEXT') {
      await this.askQuestion(run, event, finish.blocker ?? {})
      return
    }
    await this.remediate(this.requireRun(runId), 'blocked', finish.blocker?.reason)
  }

  async workerFailed(runId: string, reason: string, detail?: string): Promise<void> {
    if (this.late(runId, `failure ${reason}`)) return
    const run = this.requireRun(runId)
    if (isTerminal(run.state)) return
    if (reason === 'gateway_error') this.gatewayReachable(false, detail ?? reason)
    if (run.agent === INGEST_AGENT) {
      await this.ingestRunFailed(runId, detail ? `${reason}: ${detail}` : reason)
      return
    }
    const event = this.log.append({
      type: NO_FINISH_REASONS.includes(reason) ? 'WORKER_NO_FINISH' : 'WORKER_FAILED',
      issue: run.issue,
      run: run.id,
      data: { reason, ...(detail ? { detail } : {}) },
    })
    await this.end(runId, 'failed', event)
    this.stalls.delete(runId)
    this.releaseLease(run.issue)
    await this.remediate(this.requireRun(runId), reason, detail)
  }

  async headImported(runId: string, headSha: string): Promise<void> {
    const run = this.runs.update(runId, { headSha })
    await this.destroySandbox(run)
    this.runs.update(runId, { sandbox: null })
  }

  async gatesFinished(runId: string, results: GateResult[]): Promise<void> {
    const run = this.requireRun(runId)
    if (run.state !== 'gating') return
    let last: Event | undefined
    for (const r of results) {
      last = this.log.append({
        type: r.passed ? 'GATE_PASSED' : 'GATE_FAILED',
        issue: run.issue,
        run: run.id,
        data: gateEventData(r),
      })
    }
    const failed = results.find((r) => !r.passed)
    if (!last) {
      await this.workerFailed(runId, 'crash', 'gate runner returned no results')
      return
    }
    if (!failed) {
      const reviewing = this.runs.transition(runId, 'reviewing', last)
      this.schedule(reviewing)
      return
    }
    await this.end(runId, 'failed', last)
    this.releaseLease(run.issue)
    await this.postOnce(run.issue, last.id, gateComment(failed))
    await this.remediate(
      this.requireRun(runId),
      'gate_failed',
      `${failed.check} exited ${failed.result.exitCode}${failed.result.timedOut ? ' (timed out)' : ''}`,
    )
  }

  gateResults(runId: string): GateEventData[] {
    return this.log
      .since(null, { run: runId, types: ['GATE_PASSED'] })
      .map((e) => e.data as unknown as GateEventData)
  }

  async reviewFinished(runId: string, outcome: ReviewOutcome): Promise<void> {
    const run = this.requireRun(runId)
    if (run.state !== 'reviewing') return
    if (outcome.kind === 'refused') {
      this.reviewRefused.add(runId)
      this.log.append({ type: 'CONFIG_REJECTED', data: { errors: [outcome.error] } })
      await this.notify(`${run.issue}: review refused: ${outcome.error}`, run.issue)
      return
    }
    if (outcome.kind === 'error') {
      await this.workerFailed(runId, outcome.reason, outcome.detail)
      return
    }
    if (outcome.kind === 'unreviewed') {
      const event = this.log.append({
        type: outcome.reason === 'invalid_output' ? 'SINGLE_CALL_INVALID' : 'INPUT_OVER_BUDGET',
        issue: run.issue,
        run: run.id,
        data: {
          agent: 'reviewer',
          model: outcome.model,
          ...(outcome.errors ? { errors: outcome.errors } : {}),
          ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
          ...(outcome.budget !== undefined ? { budget: outcome.budget } : {}),
        },
      })
      const why =
        outcome.reason === 'invalid_output'
          ? 'the reviewer returned invalid output twice'
          : `the review input is over the reviewer budget (${outcome.detail})`
      this.forceManual(run.issue, why)
      await this.postOnce(
        run.issue,
        event.id,
        `This change is unreviewed: ${why}. Merge mode for this issue is forced to manual.`,
      )
      await this.reviewPassed(runId, event)
      return
    }
    const { review, model } = outcome
    const event = this.log.append({
      type: 'REVIEW_RECEIVED',
      issue: run.issue,
      run: run.id,
      data: { verdict: review.verdict, model, findings: review.findings },
    })
    await this.postOnce(run.issue, event.id, reviewComment(review, model))
    if (review.verdict === 'pass') {
      await this.reviewPassed(runId, event)
      return
    }
    await this.end(runId, 'failed', event)
    this.releaseLease(run.issue)
    await this.remediate(this.requireRun(runId), 'review_failed', blockerSummary(review))
  }

  async pullRequestOpened(record: PullRequestRecord, title: string): Promise<void> {
    this.pullRequests.put(record)
    const logged = this.log
      .since(null, { issue: record.issue, types: ['PR_CREATED'] })
      .some((e) => e.data.url === record.url)
    if (!logged) {
      this.log.append({
        type: 'PR_CREATED',
        issue: record.issue,
        run: record.run,
        data: {
          url: record.url,
          branch: record.branch,
          account: record.account,
          mode: record.mode,
          ...(record.title ? { title: record.title } : {}),
          ...(record.body ? { body: record.body } : {}),
        },
      })
    }
    await this.d.linear.attachLink(record.issue, record.url, `PR #${record.number}: ${title}`)
    await this.writeStatus(record.issue, { status: 'review' })
    if (!logged) {
      await this.notify(`PR #${record.number} ready for review`, record.issue, {
        kind: 'pr',
        url: record.url,
        context: this.runContext(record.run),
        action: `Review and merge PR #${record.number}${this.forcedManual(record.issue) ? ' (unreviewed, check carefully)' : ''}`,
      })
    }
  }

  private async watchPullRequests(): Promise<void> {
    const host = this.d.gitHost
    if (!host) return
    for (const pr of this.pullRequests.all()) {
      const issue = this.cache.get(pr.issue)
      const lifecycle = issue ? lifecycleOf(this.cfg, issue.team, issue.status) : null
      if (lifecycle === 'canceled') {
        this.pullRequests.remove(pr.issue)
        continue
      }
      try {
        const state = await host.state(pr)
        // Linear's GitHub automation can mark the issue Done before nightshift sees the merge.
        if (lifecycle === 'done' && state.state !== 'merged') this.pullRequests.remove(pr.issue)
        else if (state.state === 'merged') await this.pullRequestMerged(pr)
        else if (state.state === 'closed') await this.pullRequestClosed(pr)
        else if (pr.ci === 'pending') await this.checkCi(pr, await host.ci(pr))
      } catch (e) {
        console.error(`watch ${pr.url} (${pr.issue}): ${(e as Error).message}`)
      }
    }
  }

  private async checkCi(pr: PullRequestRecord, ci: CiState): Promise<void> {
    if (ci.state === 'pending') return
    this.pullRequests.put({ ...pr, ci: ci.state })
    if (ci.state === 'passed') {
      this.log.append({ type: 'CI_PASSED', issue: pr.issue, run: pr.run, data: { url: ci.url } })
      return
    }
    const event = this.log.append({
      type: 'CI_FAILED',
      issue: pr.issue,
      run: pr.run,
      data: { url: ci.url, failed_checks: ci.failedChecks },
    })
    const checks = ci.failedChecks.length ? ci.failedChecks.join(', ') : 'unknown checks'
    await this.postOnce(pr.issue, event.id, `CI failed on ${pr.url}: ${checks}.`)
    await this.notify(`CI failed on PR #${pr.number}`, pr.issue, {
      kind: 'ci',
      url: pr.url,
      context: [`failed checks: ${checks}`],
      action: 'nightshift attempts a repair; check the PR if it fails again',
    })
    const run = this.runs.get(pr.run)
    if (run) await this.remediate(run, 'ci_failed', `failed checks: ${checks}`)
    await this.refresh(pr.issue)
  }

  private async pullRequestMerged(pr: PullRequestRecord): Promise<void> {
    this.log.append({
      type: 'MERGED',
      issue: pr.issue,
      run: pr.run,
      data: { url: pr.url, branch: pr.branch, account: pr.account, mode: pr.mode },
    })
    this.pullRequests.remove(pr.issue)
    const issue = await this.d.linear.issue(pr.issue)
    const stage = issue && viewIssue(issue, this.cfg, this.viewOptions(pr.issue))?.stage
    if (stage === INTEGRATION) await this.completeStage(pr.issue)
    else this.log.append({ type: 'STAGE_COMPLETED', issue: pr.issue, data: { stage: INTEGRATION } })
    if (this.awaiting(pr.issue)?.kind !== 'after') await this.writeStatus(pr.issue, { status: 'done' })
    const dependents = [...this.cache.values()].filter((i) =>
      i.blockedBy.some((b) => b.identifier === pr.issue),
    )
    for (const id of [pr.issue, ...dependents.map((i) => i.identifier)]) await this.refresh(id)
  }

  private async refresh(identifier: string): Promise<void> {
    const issue = await this.d.linear.issue(identifier)
    if (issue) this.observeIssue(issue)
  }

  private observeIssue(issue: IssueSnapshot): void {
    const own = this.ownWrites.get(issue.identifier)
    // A read that still carries the pre-write updatedAt is Linear lagging our own write, not a change.
    if (own && issue.updatedAt === own.before && issue.status === own.previous) {
      this.cache.set(issue.identifier, { ...issue, status: own.status })
      return
    }
    this.ownWrites.delete(issue.identifier)
    this.cache.set(issue.identifier, issue)
    const lifecycle = lifecycleOf(this.cfg, issue.team, issue.status)
    if (lifecycle === 'done' || lifecycle === 'canceled') this.uncover(issue.identifier)
  }

  private async writeStatus(identifier: string, change: IssueUpdate): Promise<void> {
    await this.d.linear.update(identifier, change)
    const issue = this.cache.get(identifier)
    if (!issue || change.status === undefined) return
    const status = teamStatuses(this.cfg, issue.team)[change.status]
    this.ownWrites.set(identifier, { status, previous: issue.status, before: issue.updatedAt })
    this.cache.set(identifier, { ...issue, status })
  }

  private async pullRequestClosed(pr: PullRequestRecord): Promise<void> {
    this.pullRequests.remove(pr.issue)
    await this.holdForYou(pr.issue, { kind: 'escalated', stage: INTEGRATION })
    await this.postOnce(
      pr.issue,
      `pr-closed-${pr.number}`,
      `Pull request ${pr.url} was closed without merging. nightshift waits for you: move the issue to ready to push and open a new pull request.`,
    )
    await this.notify(`PR #${pr.number} closed without merge`, pr.issue, {
      kind: 'blocked',
      url: pr.url,
      action: 'Reopen the PR, move the issue to Todo for a new attempt, or cancel it in Linear',
    })
    await this.refresh(pr.issue)
  }

  forcedManual(issue: string): string | null {
    return this.metaMap<string>('forced_manual')[issue] ?? null
  }

  private forceManual(issue: string, why: string): void {
    const map = this.metaMap<string>('forced_manual')
    map[issue] = why
    this.setMeta('forced_manual', JSON.stringify(map))
  }

  private async reviewPassed(runId: string, cause: Event): Promise<void> {
    const run = await this.end(runId, 'done', cause)
    this.releaseLease(run.issue)
    const issue = await this.d.linear.issue(run.issue)
    if (issue) this.observeIssue(issue)
    const view = issue && viewIssue(issue, this.cfg, this.viewOptions(issue.identifier))
    if (view?.stage === VERIFICATION) {
      this.log.append({ type: 'STAGE_COMPLETED', issue: run.issue, data: { stage: IMPLEMENTATION } })
    }
    await this.completeStage(run.issue)
  }

  private async enterVerification(identifier: string): Promise<void> {
    const issue = this.cache.get(identifier)
    const view = issue && viewIssue(issue, this.cfg, this.viewOptions(identifier))
    if (view?.stage !== IMPLEMENTATION) return
    if (nextStage(this.cfg, view.pipeline, IMPLEMENTATION) !== VERIFICATION) return
    await this.relabel(identifier, VERIFICATION, IMPLEMENTATION)
  }

  private async backToImplementation(identifier: string): Promise<void> {
    if (this.runs.active().some((r) => r.issue === identifier)) return
    const issue = this.cache.get(identifier)
    const stage = issue && viewIssue(issue, this.cfg, this.viewOptions(identifier))?.stage
    if (stage !== VERIFICATION && stage !== INTEGRATION) return
    await this.relabel(identifier, IMPLEMENTATION, stage)
  }

  private async relabel(identifier: string, stage: string, from: string): Promise<void> {
    this.log.append({ type: 'STAGE_ENTERED', issue: identifier, data: { stage, from } })
    await this.d.linear.update(identifier, { stage })
    const issue = this.cache.get(identifier)
    if (issue) {
      const prefix = `${LABEL_GROUPS.stage}:`
      const labels = [...issue.labels.filter((l) => !l.startsWith(prefix)), `${prefix}${stage}`]
      this.cache.set(identifier, { ...issue, labels })
    }
  }

  async stopRun(runId: string, reason: string, by?: By): Promise<void> {
    const run = this.requireRun(runId)
    if (isTerminal(run.state)) return
    await this.d.executor.stop(run, reason)
    const event = this.log.append({
      type: 'WORKER_FAILED',
      issue: run.issue,
      run: run.id,
      data: { reason: 'stopped', detail: reason, ...(by ? { by } : {}) },
    })
    await this.end(runId, 'stopped', event)
    this.stalls.delete(runId)
    await this.destroySandbox(run)
    this.releaseLease(run.issue)
  }

  resolveRun(target: string): Run | undefined {
    return resolveRun(this.runs, target)
  }

  private requireActive(target: string): Run {
    const run = activeRun(this.runs, target)
    if (!run) throw new ControlError('not_found', `no active run for ${target}`)
    return run
  }

  async sendMessage(target: string, text: string, by: By): Promise<Run> {
    const run = this.requireActive(target)
    if (run.state !== 'running' || run.session === null) {
      throw new ControlError('refused', `run ${run.id} of ${run.issue} is ${run.state}; it takes no messages`)
    }
    await this.d.executor.nudge(run, text)
    this.log.append({ type: 'MESSAGE_SENT', issue: run.issue, run: run.id, data: { text, by } })
    return run
  }

  async answerQuestion(issue: string, text: string, by: By): Promise<void> {
    const q = this.d.db
      .query<{ comment: string; run: string | null }, [string]>(
        'SELECT comment, run FROM questions WHERE issue = ? AND answered_at IS NULL ORDER BY asked_at DESC',
      )
      .get(issue)
    if (!q) throw new ControlError('not_found', `no open question on ${issue}`)
    await this.d.linear.comment(issue, text, { parentId: q.comment })
    this.log.append({
      type: 'MESSAGE_SENT',
      issue,
      ...(q.run ? { run: q.run } : {}),
      data: { text, by, comment: q.comment },
    })
  }

  async stopForUser(target: string, reason: string | undefined, by: By): Promise<Run> {
    const run = this.requireActive(target)
    await this.stopRun(run.id, reason ?? 'stopped by you', by)
    const issue = this.cache.get(run.issue) ?? (await this.d.linear.issue(run.issue))
    const stage = (issue && viewIssue(issue, this.cfg)?.stage) ?? ''
    await this.holdForYou(run.issue, { kind: 'escalated', stage })
    return this.requireRun(run.id)
  }

  async retryRun(
    target: string,
    o: { agent?: string; profile?: string; continue?: boolean },
    by: By,
  ): Promise<Run> {
    const identifier = this.resolveRun(target)?.issue ?? (isIssueRef(target) ? target : undefined)
    if (!identifier) throw new ControlError('not_found', `unknown target ${target}`)
    const snapshot = await this.d.linear.issue(identifier)
    if (!snapshot) throw new ControlError('not_found', `unknown issue ${identifier}`)
    this.observeIssue(snapshot)
    const view = viewIssue(snapshot, this.cfg, this.viewOptions(identifier))
    const stage = view?.stage ?? null
    if (!view || stage === null || view.repository === null || !this.cfg.stages[stage]?.automatic) {
      throw new ControlError('refused', `${identifier}: stage ${stage ?? '(none)'} has no automatic role`)
    }
    if (view.lifecycle === 'done' || view.lifecycle === 'canceled') {
      throw new ControlError('refused', `${identifier} is ${view.lifecycle}`)
    }
    if (o.profile && !profileEntries(this.cfg.profiles).some(([name]) => name === o.profile)) {
      throw new ControlError('refused', `no profile '${o.profile}'`)
    }
    const runs = this.runs.forIssue(identifier)
    const continueFrom = o.continue ? runs.filter((r) => r.headSha !== null).at(-1) : undefined
    if (o.continue && !continueFrom) {
      throw new ControlError('refused', `${identifier}: no earlier attempt has a commit to continue from`)
    }
    const last = runs.at(-1)
    const agent = o.agent ?? this.selectFor(view, stage, (last?.attempt ?? 0) + 1, last)
    if (agent === undefined || this.d.agentKind(agent) !== 'worker') {
      throw new ControlError('refused', `${identifier}: no worker agent for stage ${stage}`)
    }
    const active = this.runs.active().find((r) => r.issue === identifier)
    if (active) await this.stopRun(active.id, 'retry requested', by)
    this.setAwaiting(identifier, null)
    const run = await this.dispatch(view, {
      agent,
      ...(o.profile ? { profile: o.profile } : {}),
      ...(continueFrom ? { continueFrom } : {}),
      by,
    })
    if (!run) throw new ControlError('refused', `${identifier} could not be dispatched (lease held)`)
    await this.refresh(identifier)
    return this.requireRun(run.id)
  }

  private async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      reattached: [],
      resumed: [],
      failed: [],
      stopped: [],
      answered: [],
      lost: [],
      orphanSandboxes: [],
      orphanOutboxes: [],
    }
    const withRun = new Set(this.runs.active().map((r) => r.issue))
    const lost = [...this.cache.values()].filter((i) => {
      const view = viewIssue(i, this.cfg, this.viewOptions(i.identifier))
      if (view?.lifecycle !== 'running' || withRun.has(i.identifier)) return false
      return (
        view.stage === VERIFICATION ||
        decide(view, this.cfg, { agentKind: this.d.agentKind }).kind === 'running'
      )
    })
    for (const run of this.runs.active()) await this.recoverRun(run, report)
    report.answered = await this.checkQuestions()

    const active = new Set(this.runs.active().map((r) => r.id))
    for (const handle of await this.d.sandbox.list({ nightshift: '1' })) {
      if (active.has(handle.name)) continue
      await this.d.sandbox.destroy(handle)
      report.orphanSandboxes.push(handle.id)
      if (this.runs.get(handle.name)) this.sandboxDestroyed(handle.name, handle)
    }
    const sandboxes = new Set((await this.d.sandbox.list({ nightshift: '1' })).map((h) => h.name))
    for (const dir of this.d.outbox.list()) {
      if (sandboxes.has(dir)) continue
      this.d.outbox.remove(dir)
      report.orphanOutboxes.push(dir)
    }

    for (const issue of lost) {
      await this.postOnce(
        issue.identifier,
        `lost-${issue.updatedAt}`,
        'nightshift lost the runtime state of this run; it is dispatched again.',
      )
      await this.writeStatus(issue.identifier, { status: 'ready' })
      report.lost.push(issue.identifier)
    }
    return report
  }

  private async recoverRun(
    run: Run,
    report: Pick<RecoveryReport, 'reattached' | 'resumed' | 'failed' | 'stopped'>,
  ) {
    if (run.agent === INGEST_AGENT) {
      await this.ingestRunFailed(run.id, 'interrupted by supervisor restart')
      report.failed.push(run.id)
      return
    }
    const issue = await this.d.linear.issue(run.issue)
    if (issue) this.observeIssue(issue)
    const view = issue && viewIssue(issue, this.cfg, this.viewOptions(issue.identifier))
    if (view?.lifecycle !== 'running') {
      await this.stopRun(run.id, 'issue changed in Linear')
      report.stopped.push(run.id)
      return
    }
    if (run.state === 'queued') {
      this.takeLease(run)
      report.resumed.push(run.id)
      return
    }
    if (run.state === 'gating' || run.state === 'reviewing') {
      this.takeLease(run)
      this.schedule(run)
      report.resumed.push(run.id)
      return
    }
    if (await this.alive(run)) {
      this.takeLease(run)
      await this.d.executor.reattach(run)
      report.reattached.push(run.id)
      return
    }
    await this.workerFailed(run.id, 'supervisor_restart')
    report.failed.push(run.id)
  }

  private async alive(run: Run): Promise<boolean> {
    if (run.sandbox === null || run.session === null) return false
    if ((await this.d.sandbox.status(this.handle(run))) !== 'running') return false
    return this.d.worker.alive({ id: run.session, attach: [] })
  }

  private async sync(): Promise<void> {
    const issues = await this.d.linear.issues(this.cursor === undefined ? {} : { updatedSince: this.cursor })
    const seen = new Set<string>()
    for (const issue of issues) {
      seen.add(issue.identifier)
      this.observeIssue(issue)
      if (this.cursor === undefined || issue.updatedAt > this.cursor) this.cursor = issue.updatedAt
    }
    // Covered and running issues may fall outside the opt-in query; re-read them so coverage and stops apply.
    const watched = [
      ...this.runs.active().map((r) => r.issue),
      ...this.coveredSet(),
      ...this.pullRequests.all().map((p) => p.issue),
    ]
    for (const id of new Set(watched)) {
      if (seen.has(id)) continue
      const issue = await this.d.linear.issue(id)
      if (issue) this.observeIssue(issue)
    }
  }

  private async enforceLinear(): Promise<string[]> {
    const stopped: string[] = []
    for (const run of this.runs.active()) {
      const issue = this.cache.get(run.issue)
      if (!issue || run.agent === INGEST_AGENT) continue
      const view = viewIssue(issue, this.cfg, this.viewOptions(issue.identifier))
      if (view?.lifecycle === 'running') continue
      await this.stopRun(run.id, 'issue changed in Linear')
      stopped.push(run.issue)
    }
    return stopped
  }

  private async dispatch(view: IssueView, o: DispatchOverride = {}): Promise<Run | undefined> {
    const id = view.snapshot.identifier
    const repository = view.repository
    const stage = view.stage
    if (repository === null || stage === null) return undefined
    const last = this.runs.forIssue(id).at(-1)
    const attempt = (last?.attempt ?? 0) + 1
    const agent = o.agent ?? this.selectFor(view, stage, attempt, last)
    if (agent === undefined) return undefined
    const profile = o.profile ?? this.profileFor(view)
    const model = this.d.modelFor(agent, profile, this.cfg)
    const from = o.continueFrom ?? (last?.failure === 'implementation_defect' ? last : undefined)
    const baseSha = from?.headSha && from.baseSha ? from.baseSha : await this.d.repos.baseSha(repository)
    const run = this.runs.create({ issue: id, agent, profile, model, repository, baseSha, attempt })
    const dispatched = this.log.append({
      type: 'DISPATCHED',
      issue: id,
      run: run.id,
      data: {
        agent,
        profile,
        model,
        attempt,
        repository,
        base: this.cfg.repositories[repository]?.base ?? 'main',
        ...(o.by ? { reason: 'manual retry', by: o.by } : last?.failure ? { reason: last.failure } : {}),
        ...(o.continueFrom ? { continues: o.continueFrom.id } : {}),
      },
    })
    if (!this.leases.acquire(id, run.id)) {
      this.runs.transition(run.id, 'stopped', dispatched)
      return undefined
    }
    this.leaseEvent('LEASE_ACQUIRED', id)
    this.retry.take(id)
    await this.writeStatus(id, { status: 'running' })
    await this.launch(run, view)
    return run
  }

  private selectFor(view: IssueView, stage: string, attempt: number, last: Run | undefined) {
    return selectAgent(this.cfg.selection, {
      stage,
      issueType: view.issueType,
      failureClass: last?.failure,
      attempt,
    })
  }

  private async launch(run: Run, view: IssueView): Promise<void> {
    const started = this.runs.transition(
      run.id,
      'starting',
      this.log.append({ type: 'RUN_STARTING', issue: run.issue, run: run.id, data: {} }),
    )
    try {
      const repairFrom = this.continuationOf(run)
      await this.d.executor.start({
        run: started,
        issue: view.snapshot,
        files: view.files,
        ...(repairFrom ? { repairFrom } : {}),
      })
      if (!isTerminal(this.requireRun(run.id).state)) this.gatewayReachable(true, `run ${run.id} started`)
    } catch (e) {
      const reason =
        e instanceof TaskTooLargeError
          ? e.reason
          : e instanceof GatewayError
            ? 'gateway_error'
            : 'sandbox_error'
      await this.workerFailed(run.id, reason, (e as Error).message)
    }
  }

  private continuationOf(run: Run): ExecutorStart['repairFrom'] {
    const dispatched = this.log.since(null, { run: run.id, types: ['DISPATCHED'] }).at(-1)
    const continues = dispatched?.data.continues
    const from =
      typeof continues === 'string'
        ? this.runs.get(continues)
        : this.runs
            .forIssue(run.issue)
            .find((r) => r.attempt === run.attempt - 1 && r.failure === 'implementation_defect')
    return from?.headSha ? { run: from.id, headSha: from.headSha } : undefined
  }

  private async launchQueued(): Promise<void> {
    for (const run of this.runs.active()) {
      if (run.state !== 'queued') continue
      const issue = this.cache.get(run.issue)
      const view = issue && viewIssue(issue, this.cfg, this.viewOptions(run.issue))
      if (view) await this.launch(run, view)
    }
  }

  private async end(runId: string, to: 'done' | 'failed' | 'stopped', cause: Event): Promise<Run> {
    return this.runs.transition(runId, to, cause)
  }

  private profileFor(view: IssueView): string {
    const projectId = view.snapshot.project?.id
    const chosen = projectId
      ? this.d.db
          .query<{ value: string }, [string]>(
            "SELECT value FROM session_choices WHERE project = ? AND key = 'profile'",
          )
          .get(projectId)?.value
      : undefined
    return chosen ?? view.project.profile ?? this.cfg.profiles.active
  }

  private async remediate(run: Run, reason: string, detail?: string): Promise<void> {
    await this.backToImplementation(run.issue)
    const classifier =
      CHECKED_REASONS.includes(reason) || ENVIRONMENT_REASONS.includes(reason)
        ? fallbackClassifier
        : (this.d.classifier ?? fallbackClassifier)
    const c =
      reason === 'task_too_large'
        ? TASK_TOO_LARGE_CLASS
        : await classifier.classify({ run, reason, ...(detail ? { detail } : {}) })
    this.runs.update(run.id, { failure: c.class })
    const escalate =
      c.class !== 'environment' && this.escalationCount(run.issue) >= this.cfg.limits.repair_rounds + 2
    const action = escalate ? 'escalate_user' : c.action
    const event = this.log.append({
      type: 'FAILURE_CLASSIFIED',
      issue: run.issue,
      run: run.id,
      data: {
        class: c.class,
        action,
        ...(c.evidence ? { evidence: c.evidence } : {}),
        fallback: c.fallback ?? false,
      },
    })
    await this.postOnce(
      run.issue,
      event.id,
      `Attempt ${run.attempt} (${run.agent}) failed: ${reason}${detail ? ` (${detail})` : ''}. Class \`${c.class}\`, action \`${action}\`.`,
    )
    this.environmentStreak = c.class === 'environment' ? this.environmentStreak + 1 : 0

    if (action === 'retry_same') {
      this.retry.schedule(run.issue, c.class, this.now().getTime())
      await this.writeStatus(run.issue, { status: 'ready' })
    } else if (action === 'pause_dispatch') {
      this.pause(`failure ${c.class} on ${run.issue}`, 'supervisor')
      await this.notify(`dispatch paused after a ${c.class} failure`, run.issue, {
        kind: 'paused',
        context: this.failureContext(run),
        action: 'Fix the cause, then `ns resume`',
      })
    } else if (action === 'escalate_user') {
      await this.escalateUser(run, c)
    } else if ((await this.d.remediation?.handle(run, { ...c, action })) !== 'handled') {
      await this.escalateUser(run, c)
    }

    if (this.environmentStreak >= ENVIRONMENT_STREAK_PAUSE && !this.paused) {
      const why = `${ENVIRONMENT_STREAK_PAUSE} environment failures in a row`
      this.pause(why, 'supervisor')
      await this.notify(`dispatch paused: ${why}`, undefined, {
        kind: 'paused',
        context: [`last: ${run.issue}: ${this.failureContext(run).join('; ')}`],
        action: 'Check the gateway, Docker and the host, then `ns resume`',
      })
    }
  }

  private async escalateUser(run: Run, c: Classification): Promise<void> {
    const issue = this.cache.get(run.issue)
    await this.holdForYou(run.issue, {
      kind: 'escalated',
      stage: (issue && viewIssue(issue, this.cfg)?.stage) ?? '',
    })
    await this.notify(`run failed and needs you (${c.class})`, run.issue, {
      kind: 'failed',
      context: this.failureContext(run),
      action: `Clarify the issue or answer in Linear, then \`ns retry ${run.issue}\``,
    })
  }

  private async askQuestion(
    run: Run,
    cause: Event,
    blocker: NonNullable<FinishLike['blocker']>,
  ): Promise<void> {
    const to = blocker.needs === 'decision' || blocker.needs === 'permission' ? 'user' : 'lead'
    const question = blocker.question || blocker.reason || 'the worker needs more context'
    const options = blocker.options?.length ? blocker.options : undefined
    const choices = options ? `\n\nOptions: ${options.join(' | ')}` : ''
    const comment = await this.postOnce(run.issue, cause.id, `Question for the ${to}: ${question}${choices}`)
    this.log.append({
      type: 'QUESTION_ASKED',
      issue: run.issue,
      run: run.id,
      data: { to, question, comment: comment.id, ...(options ? { options } : {}) },
    })
    this.d.db
      .query(
        'INSERT OR IGNORE INTO questions (comment, issue, run, asked_to, asked_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(comment.id, run.issue, run.id, to, this.now().toISOString())
    await this.writeStatus(run.issue, { status: 'blocked' })
    await this.notify(`question for the ${to}: ${question}`, run.issue, {
      kind: 'question',
      context: [
        `asked by ${run.agent} (attempt ${run.attempt})${options ? `; options: ${options.join(' | ')}` : ''}`,
      ],
      question: { comment: comment.id, text: question, ...(options ? { options } : {}) },
    })
  }

  private async checkQuestions(): Promise<string[]> {
    const answered: string[] = []
    const open = this.d.db
      .query<QuestionRow, []>(
        'SELECT comment, issue FROM questions WHERE answered_at IS NULL ORDER BY asked_at',
      )
      .all()
    for (const q of open) {
      const reply = (await this.d.linear.comments(q.issue)).find((c) => c.parentId === q.comment)
      if (!reply) continue
      this.d.db
        .query('UPDATE questions SET answered_at = ?, answer = ? WHERE comment = ?')
        .run(this.now().toISOString(), reply.body, q.comment)
      this.log.append({
        type: 'QUESTION_ANSWERED',
        issue: q.issue,
        data: { comment: q.comment, answer: reply.body, by: reply.by },
      })
      answered.push(q.issue)
      await this.resumeAnswered(q.issue)
    }
    return answered
  }

  private async resumeAnswered(identifier: string): Promise<void> {
    const stillOpen = this.d.db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM questions WHERE issue = ? AND answered_at IS NULL',
      )
      .get(identifier)
    if (stillOpen?.n || this.awaiting(identifier) || this.runs.active().some((r) => r.issue === identifier))
      return
    const issue = this.cache.get(identifier)
    if (!issue || lifecycleOf(this.cfg, issue.team, issue.status) !== 'blocked') return
    await this.writeStatus(identifier, { status: 'ready' })
    await this.refresh(identifier)
  }

  private async enterStage(view: IssueView, stage: string, from?: string): Promise<void> {
    const id = view.snapshot.identifier
    this.log.append({ type: 'STAGE_ENTERED', issue: id, data: { stage, ...(from ? { from } : {}) } })
    const hold = this.cfg.stages[stage]?.human_checkpoint === 'before'
    this.setAwaiting(id, hold ? { kind: 'before', stage } : null)
    await this.writeStatus(id, { stage, ...(hold ? { status: 'blocked' as const } : {}) })
    if (hold)
      await this.notify(`${stage} needs your approval before it starts`, id, {
        kind: 'blocked',
        action: `\`ns resume ${id}\` to start ${stage}`,
      })
  }

  private async advance(view: IssueView): Promise<void> {
    const stage = view.stage
    if (stage === null) return
    const id = view.snapshot.identifier
    this.log.append({ type: 'STAGE_COMPLETED', issue: id, data: { stage } })
    const next = nextStage(this.cfg, view.pipeline, stage)
    if (next) await this.enterStage(view, next, stage)
    else {
      this.setAwaiting(id, null)
      await this.startIngest(view)
    }
  }

  private readonly ingesting = new Set<string>()

  private async startIngest(view: IssueView): Promise<void> {
    const ingest = this.d.ingest
    const id = view.snapshot.identifier
    if (!ingest || this.cfg.stages.closeout?.ingest === false || this.ingesting.has(id)) return
    if (this.log.since(null, { issue: id, types: ['VAULT_INGEST_STARTED'] }).length) return
    this.ingesting.add(id)
    try {
      const started = this.log.append({ type: 'VAULT_INGEST_STARTED', issue: id, data: {} })
      let prepared: Awaited<ReturnType<VaultIngest['prepare']>>
      try {
        prepared = await ingest.prepare({
          issue: view.snapshot,
          repository: view.repository ?? '',
          date: this.now().toISOString().slice(0, 10),
          events: this.log.since(null, { issue: id }),
          pr: this.pullRequests.get(id) ?? null,
        })
      } catch (e) {
        await this.ingestFailed(id, `prepare: ${(e as Error).message}`)
        return
      }
      const profile = this.profileFor(view)
      const run = this.runs.create({
        issue: id,
        agent: INGEST_AGENT,
        profile,
        model: this.d.modelFor(INGEST_AGENT, profile, this.cfg),
        repository: prepared.repository,
        baseSha: prepared.baseSha,
        attempt: 1,
      })
      const starting = this.runs.transition(run.id, 'starting', started)
      try {
        await this.d.executor.start({
          run: starting,
          issue: view.snapshot,
          files: prepared.files,
          sourceFiles: prepared.sourceFiles,
        })
      } catch (e) {
        await this.ingestRunFailed(run.id, `start: ${(e as Error).message}`)
      }
    } finally {
      this.ingesting.delete(id)
    }
  }

  private async ingestFinished(run: Run, event: Event, finish: FinishLike): Promise<void> {
    if (finish.status !== 'DONE' && finish.status !== 'DONE_WITH_CONCERNS') {
      await this.ingestRunFailed(run.id, `${finish.status}: ${finish.blocker?.reason ?? 'no reason'}`, event)
      return
    }
    // Publishing is the ingest gate (vault lints, rebase, push); there is no code review stage.
    this.runs.transition(run.id, 'gating', event)
    let commits: string[]
    try {
      commits = await (this.d.ingest as VaultIngest).publish(this.requireRun(run.id))
    } catch (e) {
      await this.ingestRunFailed(run.id, `publish: ${(e as Error).message}`, event)
      return
    }
    this.runs.transition(run.id, 'reviewing', event)
    await this.end(run.id, 'done', event)
    this.log.append({ type: 'VAULT_INGESTED', issue: run.issue, data: { commits } })
  }

  private async ingestRunFailed(runId: string, reason: string, cause?: Event): Promise<void> {
    const run = this.requireRun(runId)
    if (!isTerminal(run.state)) {
      await this.end(
        runId,
        'failed',
        cause ??
          this.log.append({
            type: 'WORKER_FAILED',
            issue: run.issue,
            run: run.id,
            data: { reason: 'crash', detail: reason },
          }),
      )
    }
    this.stalls.delete(runId)
    await this.ingestFailed(run.issue, reason)
  }

  private async ingestFailed(issue: string, reason: string): Promise<void> {
    if (this.log.since(null, { issue, types: ['VAULT_INGEST_FAILED', 'VAULT_INGESTED'] }).length) return
    this.log.append({ type: 'VAULT_INGEST_FAILED', issue, data: { reason } })
    await this.notify('Vault ingest failed', issue, { kind: 'info', context: [reason] })
  }

  private runRole(view: IssueView, stage: string, agent: string | undefined): void {
    const handler = this.d.stageHandler
    const id = view.snapshot.identifier
    if (!handler || this.roleInFlight.has(id)) return
    this.roleInFlight.add(id)
    const key = `${id}:${stage}`
    handler
      .run({ issue: view.snapshot, stage, agent })
      .then(() => this.roleFailures.delete(key))
      .catch((e) => this.roleFailed(id, stage, key, (e as Error).message))
      .finally(() => this.roleInFlight.delete(id))
  }

  private async roleFailed(id: string, stage: string, key: string, message: string): Promise<void> {
    console.error(`stage ${stage} on ${id}: ${message}`)
    const count = (this.roleFailures.get(key) ?? 0) + 1
    this.roleFailures.set(key, count)
    if (count < STAGE_FAILURE_LIMIT) return
    this.roleFailures.delete(key)
    await this.holdForYou(id, { kind: 'escalated', stage })
    await this.notify(`${stage} failed ${count} times in a row`, id, {
      kind: 'failed',
      context: [message],
      action: `Fix the cause, then move ${id} to Todo to try ${stage} again`,
    })
  }

  private renewLeases(): void {
    for (const run of this.runs.active()) {
      if (this.leases.get(run.issue)?.holder === this.instanceId) this.leases.renew(run.issue)
    }
  }

  private async expireLease(lease: Lease): Promise<void> {
    this.log.append({
      type: 'LEASE_EXPIRED',
      issue: lease.issue,
      data: { holder: lease.holder, expires: lease.expiresAt },
    })
    const run = this.runs.get(lease.run)
    if (run && !isTerminal(run.state)) {
      await this.recoverRun(run, { reattached: [], resumed: [], failed: [], stopped: [] })
    } else {
      this.leases.release(lease.issue)
    }
  }

  private takeLease(run: Run): void {
    this.leases.release(run.issue)
    this.leases.acquire(run.issue, run.id)
    this.leaseEvent('LEASE_ACQUIRED', run.issue)
  }

  private releaseLease(issue: string): void {
    const lease = this.leases.get(issue)
    if (!lease) return
    this.leases.release(issue)
    this.log.append({
      type: 'LEASE_RELEASED',
      issue,
      data: { holder: lease.holder, expires: lease.expiresAt },
    })
  }

  private leaseEvent(type: 'LEASE_ACQUIRED', issue: string): void {
    const lease = this.leases.get(issue)
    if (lease) this.log.append({ type, issue, data: { holder: lease.holder, expires: lease.expiresAt } })
  }

  private handle(run: Run): SandboxHandle {
    return { driver: this.cfg.sandbox.driver, id: run.sandbox ?? '', name: run.id }
  }

  private async destroySandbox(run: Run): Promise<void> {
    if (run.sandbox === null) return
    const handle = this.handle(run)
    await this.d.sandbox.destroy(handle)
    this.sandboxDestroyed(run.id, handle)
  }

  private sandboxDestroyed(runId: string, handle: SandboxHandle): void {
    this.log.append({ type: 'SANDBOX_DESTROYED', run: runId, data: { driver: handle.driver, id: handle.id } })
  }

  private async postOnce(identifier: string, marker: string, body: string): Promise<LinearComment> {
    const tag = `<!-- nightshift:${marker} -->`
    const existing = (await this.d.linear.comments(identifier)).find((c) => c.body.includes(tag))
    return existing ?? this.d.linear.comment(identifier, `${body}\n\n${tag}`)
  }

  private runContext(runId: string): string[] {
    const run = this.runs.get(runId)
    const finish = (run?.finish ?? {}) as { summary?: string; concerns?: string[] }
    const gates = this.log.since(null, { run: runId, types: ['GATE_PASSED', 'GATE_FAILED'] })
    const review = this.log.since(null, { run: runId, types: ['REVIEW_RECEIVED'] }).at(-1)
    const findings = (review?.data as { verdict?: string; findings?: unknown[] } | undefined) ?? {}
    return [
      finish.summary ?? '',
      ...(finish.concerns ?? []).map((c) => `concern: ${c}`),
      gates.length
        ? `gates: ${gates.map((g) => `${(g.data as { check: string }).check} ${g.type === 'GATE_PASSED' ? '✓' : '✗'}`).join(', ')}`
        : '',
      review
        ? `review: ${findings.verdict ?? '?'}, ${findings.findings?.length ?? 0} findings`
        : 'review: none',
    ]
  }

  private failureContext(run: Run): string[] {
    const failed = this.log.since(null, { run: run.id, types: ['WORKER_FAILED'] }).at(-1)
    const data = (failed?.data ?? {}) as { reason?: string; detail?: string }
    return [
      `${run.agent}, attempt ${run.attempt}`,
      data.reason ? `${data.reason}${data.detail ? `: ${data.detail.split('\n')[0]}` : ''}` : '',
    ]
  }

  private async notify(
    title: string,
    issue?: string,
    extra: Omit<Notification, 'title' | 'issue'> = {},
  ): Promise<void> {
    const subject = issue ? this.cache.get(issue)?.title : undefined
    const channel = await this.d.notifier.notify({
      title,
      ...(issue ? { issue } : {}),
      ...(subject ? { subject } : {}),
      ...extra,
    })
    if (channel) {
      this.log.append({ type: 'NOTIFICATION_SENT', data: { channel, title, ...(issue ? { issue } : {}) } })
    }
  }

  private retain(): void {
    const cutoff = new Date(this.now().getTime() - RETENTION_MS).toISOString()
    const open = "SELECT id FROM runs WHERE state NOT IN ('done','failed','stopped')"
    this.d.db
      .query(
        `DELETE FROM events WHERE ts < ? AND (run IS NULL OR run NOT IN (${open}))
         AND (issue IS NULL OR issue NOT IN (SELECT issue FROM questions WHERE answered_at IS NULL))`,
      )
      .run(cutoff)
    this.d.db
      .query(
        `DELETE FROM runs WHERE started_at < ? AND state IN ('done','failed','stopped')
         AND id NOT IN (SELECT run FROM events WHERE run IS NOT NULL)
         AND id NOT IN (SELECT run FROM leases)
         AND id NOT IN (SELECT run FROM questions WHERE run IS NOT NULL)`,
      )
      .run(cutoff)
  }

  private requireRun(id: string): Run {
    const run = this.runs.get(id)
    if (!run) throw new Error(`no run ${id}`)
    return run
  }

  private meta(key: string): string | undefined {
    return this.d.db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)
      ?.value
  }

  private setMeta(key: string, value: string): void {
    this.d.db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }
}
