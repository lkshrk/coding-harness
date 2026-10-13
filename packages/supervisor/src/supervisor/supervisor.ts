import {
  type Config,
  formatError,
  type LoadResult,
  NIGHTSHIFT_VERSION,
  profileEntries,
  validateAgainstWorkspace,
} from '@nightshift/core'
import { changedPaths, restartRequired } from '../policy/config'
import { planDispatch } from '../policy/ready'
import { RetryQueue } from '../policy/retry'
import { decide, type IssueView, VERIFICATION, viewIssue } from '../policy/stages'
import type { Awaiting, GateResult, IssueSnapshot } from '../ports'
import { type By, ControlError, type MissReport } from '../ports/control'
import type { DependentsResponse, ImplementRequest, ImplementResponse } from '../ports/generated/control'
import type {
  FinishRejectedInfo,
  NoProgressInfo,
  Progress,
  SandboxCreatedInfo,
  WorkerStartedInfo,
} from '../ports/worker'
import type { GateEventData } from '../stages/gates/report'
import type { ReviewOutcome } from '../stages/gates/review'
import { type PullRequestRecord, PullRequestStore } from '../stages/integration/records'
import { EventLog } from '../state/events'
import { LeaseStore } from '../state/leases'
import { retain, retainArtifacts } from '../state/retention'
import { type Run, RunStore } from '../state/runs'
import { readStatus, type SupervisorStatus, type Waiting } from '../state/status'
import { resolveRun } from '../state/targets'
import { createUlid } from '../state/ulid'
import { Dispatcher } from './dispatch'
import { type Modules, runFlow } from './flow'
import { Holds } from './holds'
import { implementProject } from './implement'
import { Ingest } from './ingest'
import { Leases } from './leases'
import { LinearSync } from './linear-sync'
import { PullRequestWatch } from './pr-watch'
import { Questions } from './questions'
import { Recovery } from './recovery'
import { Remediation } from './remediation'
import { Replan } from './replan'
import { importXxx220, ReviewLabeller, recordMiss } from './review-labels'
import { RunLifecycle } from './run-lifecycle'
import { type RecoveryReport, type StopOptions, type SupervisorDeps, SupervisorRuntime } from './runtime'
import { Verification } from './verification'

export type { By } from '../ports/control'
export type { SandboxCreatedInfo, WorkerStartedInfo } from '../ports/worker'
export { fallbackClassifier } from './remediation'
export type { RecoveryReport, SupervisorDeps } from './runtime'

const LEASE_TTL_MS = 180_000
const RBW_LOCKED = 'rbw locked'
const GATEWAY_UNAVAILABLE = 'gateway unavailable'
const GATEWAY_FAILURES = 2
const PROFILE_OVERRIDE = 'profile_override'

export type TickReport = { dispatched: string[]; unblocked: string[]; stopped: string[]; waiting: Waiting[] }

export class Supervisor {
  readonly log: EventLog
  readonly runs: RunStore
  readonly leases: LeaseStore
  readonly pullRequests: PullRequestStore
  readonly instanceId: string
  private cfg: Config
  private base: Config
  private readonly d: SupervisorDeps
  private readonly now: () => Date
  private readonly retry: RetryQueue
  private readonly cache = new Map<string, IssueSnapshot>()
  private readonly steps = new Map<string, { job: Promise<void>; cancel: AbortController }>()
  private paused = false
  private stopped = false
  private gatewayFailures = 0
  private readonly rt: SupervisorRuntime
  private readonly m: Modules
  private readonly labeller: ReviewLabeller | undefined

  constructor(deps: SupervisorDeps) {
    this.d = deps
    this.base = deps.config
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
    const rt = new SupervisorRuntime(
      deps,
      () => this.cfg,
      this.log,
      this.runs,
      this.pullRequests,
      this.cache,
      this.now,
    )
    const flow = runFlow({
      stopped: () => this.stopped,
      paused: () => this.paused,
      pause: (reason, by) => this.pause(reason, by),
      schedule: (run) => this.schedule(run),
      cancelSteps: (runId) => this.cancelSteps(runId),
      gatewayReachable: (reachable, reason) => this.gatewayReachable(reachable, reason),
      resolveRun: (target) => this.resolveRun(target),
      modules: () => this.m,
    })
    this.rt = rt
    this.m = {
      holds: new Holds(rt, flow),
      linearSync: new LinearSync(rt, flow),
      leasing: new Leases(rt, this.leases, this.instanceId, flow),
      questions: new Questions(rt, flow),
      ingest: new Ingest(rt, flow),
      lifecycle: new RunLifecycle(rt, flow),
      recovery: new Recovery(rt, flow),
      verification: new Verification(rt, flow),
      prWatch: new PullRequestWatch(rt, flow),
      dispatcher: new Dispatcher(rt, this.leases, this.retry, flow),
      remediation: new Remediation(rt, this.retry, flow),
      replan: new Replan(rt, flow),
    }
    this.labeller = deps.evalDir === undefined ? undefined : new ReviewLabeller(rt, deps.evalDir)
  }

  get config(): Config {
    return this.cfg
  }

  async start(): Promise<RecoveryReport> {
    this.applyOverride(this.rt.meta(PROFILE_OVERRIDE) || undefined)
    const workspace = await this.d.linear.workspace()
    const errors = validateAgainstWorkspace(this.cfg, workspace)
    if (errors.length) throw new Error(errors.map(formatError).join('\n'))
    this.rt.setMeta('instance', this.instanceId)
    this.rt.setMeta('linear_org', workspace.organization.urlKey)
    this.rt.setMeta('restart_required', 'false')
    this.paused = this.rt.meta('dispatch') === 'paused'
    // Artifacts first: run retention drops rows whose ended_at decides artifact age.
    retainArtifacts(this.d.db, this.d.artifactDirs ?? [], this.now())
    retain(this.d.db, this.now())
    this.log.append({ type: 'SUPERVISOR_STARTED', data: { version: NIGHTSHIFT_VERSION } })
    if (this.d.evalDir !== undefined) {
      try {
        importXxx220(this.rt, this.d.evalDir)
      } catch (e) {
        this.rt.setMeta('review_labels_error', `xxx-220 import: ${(e as Error).message}`)
      }
    }
    await this.m.linearSync.sync()
    const report = await this.m.recovery.recover()
    return report
  }

  useProfile(name: string): { active: string; previous: string } {
    if (!profileEntries(this.base.profiles).some(([n]) => n === name))
      throw new ControlError('refused', `no profile '${name}'`)
    const previous = this.cfg.profiles.active
    this.rt.setMeta(PROFILE_OVERRIDE, name)
    this.applyOverride(name)
    return { active: name, previous }
  }

  // An override naming a profile the base config lacks is dropped.
  private applyOverride(override: string | undefined): void {
    const known = override !== undefined && profileEntries(this.base.profiles).some(([n]) => n === override)
    if (override !== undefined && !known) this.rt.setMeta(PROFILE_OVERRIDE, '')
    this.cfg = known ? { ...this.base, profiles: { ...this.base.profiles, active: override } } : this.base
    this.rt.setMeta('active_profile', this.cfg.profiles.active)
  }

  async stop(reason = 'stopped'): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const cancelled = this.cancel(() => true, reason)
    this.d.executor.detach?.()
    this.log.append({ type: 'SUPERVISOR_STOPPED', data: { reason } })
    await cancelled
  }

  // Asks every running worker to hand off and waits for each until its grace period ends.
  async handOff(reason = 'supervisor stopping'): Promise<void> {
    const running = this.runs.active().filter((r) => r.state === 'running')
    await Promise.allSettled(running.map((r) => this.m.lifecycle.interruptRun(r.id, reason)))
  }

  async idle(): Promise<void> {
    while (this.steps.size > 0) await Promise.allSettled([...this.steps.values()].map((s) => s.job))
  }

  private cancelSteps(runId: string): Promise<void> {
    return this.cancel((key) => key.startsWith(`${runId}:`), 'run stopped')
  }

  // Only gate jobs are awaited: they destroy their sandbox on abort, other steps finish on their own.
  private async cancel(match: (key: string) => boolean, reason: string): Promise<void> {
    const steps = [...this.steps].filter(([key]) => match(key))
    for (const [, step] of steps) step.cancel.abort(reason)
    await Promise.allSettled(steps.filter(([key]) => key.endsWith(':gating')).map(([, s]) => s.job))
  }

  stepsRunning(): string[] {
    return [...this.steps.keys()]
  }

  private schedule(run: Run): void {
    const key = `${run.id}:${run.state}`
    if (this.steps.has(key)) return
    const cancel = new AbortController()
    const job = this.d.executor
      .runStep(run, cancel.signal)
      .catch((e: unknown) =>
        cancel.signal.aborted
          ? undefined
          : this.m.lifecycle.workerFailed(run.id, 'crash', `${run.state}: ${(e as Error).message}`),
      )
      .catch(() => undefined)
      .finally(() => this.steps.delete(key))
    this.steps.set(key, { job, cancel })
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { dispatched: [], unblocked: [], stopped: [], waiting: [] }
    this.m.leasing.renewLeases()
    await this.d.syncVault?.()
    for (const lease of this.leases.expired(this.now())) await this.m.leasing.expireLease(lease)
    await this.m.linearSync.sync()
    await this.m.questions.checkQuestions()
    await this.m.replan.resumeApproved()
    await this.m.prWatch.watchPullRequests()
    await this.labeller?.maybeLabel()
    const views = [...this.cache.values()].flatMap(
      (i) => viewIssue(i, this.cfg, this.m.holds.viewOptions(i.identifier)) ?? [],
    )
    report.stopped = await this.m.linearSync.enforceLinear()
    await this.m.linearSync.clearDoneStages()
    await this.m.dispatcher.launchQueued()
    if (!this.paused) await this.m.ingest.resumeInterrupted()

    const active = new Set(this.runs.active().map((r) => r.issue))
    const held = new Set(this.m.holds.held())
    const candidates: IssueView[] = []
    for (const view of views) {
      const id = view.snapshot.identifier
      const decision = decide(view, this.cfg, { agentKind: this.d.agentKind })
      if (decision.kind === 'enter') await this.m.verification.enterStage(view, decision.stage, decision.from)
      else if (decision.kind === 'advance') await this.m.verification.advance(view)
      else if (decision.kind === 'release') this.m.holds.setAwaiting(id, null)
      else if (decision.kind === 'role' && view.stage === VERIFICATION) {
        const idle = view.lifecycle === 'ready' || view.lifecycle === 'backlog'
        if (!active.has(id) && idle) await this.m.verification.backToImplementation(id)
      } else if (decision.kind === 'role') this.m.dispatcher.runRole(view, decision.stage, decision.agent)
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
    await this.probeGateway()
    await this.probeSecrets(candidates.length > 0 && running.length < this.cfg.limits.concurrency)
    const slots = this.paused ? 0 : Math.max(0, this.cfg.limits.concurrency - running.length)
    const plan = planDispatch({
      candidates,
      running,
      slots,
      config: this.cfg,
      profileFor: (view) => this.m.dispatcher.profileFor(view),
    })
    for (const { view, size, route } of plan.tooLarge) await this.m.dispatcher.tooLarge(view, size, route)
    for (const { view, by } of plan.unblocked) {
      const id = view.snapshot.identifier
      if (by.length) this.log.append({ type: 'DEPENDENCY_UNBLOCKED', issue: id, data: { by } })
      await this.m.linearSync.applyIntent(id, { kind: 'unblocked' })
      report.unblocked.push(id)
    }
    for (const view of plan.dispatch) {
      const size = plan.sizes.get(view.snapshot.identifier)
      if (await this.m.dispatcher.dispatchSized(view, size)) report.dispatched.push(view.snapshot.identifier)
    }
    const reason = (w: Waiting) =>
      this.paused && w.reason === 'concurrency limit reached' ? { ...w, reason: 'dispatch paused' } : w
    report.waiting.push(...plan.waiting.map(reason))
    this.rt.setMeta('ready_queue', JSON.stringify(report.waiting))
    this.m.linearSync.snapshotIssues(report.waiting)
    return report
  }

  pause(reason: string, by: By = 'cli'): void {
    if (this.paused) return
    this.paused = true
    this.rt.setMeta('dispatch', 'paused')
    this.rt.setMeta('dispatch_reason', reason)
    this.log.append({ type: 'DISPATCH_PAUSED', data: { reason, by } })
    if (by === 'cli' || by === 'lead') {
      this.rt.notify(`dispatch paused: ${reason}`, undefined, { kind: 'paused' }).catch(() => {})
    }
  }

  resume(reason: string, by: By = 'supervisor'): void {
    if (!this.paused) return
    this.paused = false
    this.m.remediation.resetStreak()
    this.rt.setMeta('dispatch', 'running')
    this.rt.setMeta('dispatch_reason', '')
    this.log.append({ type: 'DISPATCH_RESUMED', data: { reason, by } })
  }

  private async probeSecrets(dispatching: boolean): Promise<void> {
    if (!this.d.secretsLocked) return
    const lockPaused = this.paused && this.rt.meta('dispatch_reason') === RBW_LOCKED
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
      await this.rt.notify(
        `dispatch paused: rbw profile ${profile} is locked; run RBW_PROFILE=${profile} rbw unlock`,
        undefined,
        { kind: 'paused' },
      )
    } else if (!locked && lockPaused) this.resume('rbw unlocked')
  }

  private async probeGateway(): Promise<void> {
    if (!this.d.gatewayProbe) return
    let result: { ok: boolean; reason: string }
    try {
      result = await this.d.gatewayProbe()
    } catch (e) {
      result = { ok: false, reason: (e as Error).message }
    }
    if (result.ok) {
      this.gatewayFailures = 0
      this.gatewayReachable(true, result.reason)
      if (this.paused && this.rt.meta('dispatch_reason') === GATEWAY_UNAVAILABLE)
        this.resume('gateway recovered')
      return
    }
    this.gatewayFailures++
    if (this.gatewayFailures < GATEWAY_FAILURES) return
    this.gatewayReachable(false, result.reason)
    this.pause(GATEWAY_UNAVAILABLE, 'supervisor')
  }

  async reloadConfig(result: LoadResult): Promise<void> {
    if (!result.ok) {
      const errors = result.errors.map(formatError)
      this.log.append({ type: 'CONFIG_REJECTED', data: { errors } })
      await this.rt.notify(`config rejected: ${errors.join('; ')}`)
      return
    }
    const changed = changedPaths(this.base, result.config)
    if (!changed.length) return
    const restart = restartRequired(changed)
    this.base = restart
      ? {
          ...result.config,
          paths: this.base.paths,
          sandbox: { ...result.config.sandbox, driver: this.base.sandbox.driver },
        }
      : result.config
    if (changed.includes('profiles.active')) this.rt.setMeta(PROFILE_OVERRIDE, '')
    this.applyOverride(this.rt.meta(PROFILE_OVERRIDE) || undefined)
    this.log.append({ type: 'CONFIG_RELOADED', data: { changed, restart_required: restart } })
    if (restart) this.rt.setMeta('restart_required', 'true')
    this.m.verification.rescheduleRefused()
  }

  gateway(): 'ok' | 'unavailable' {
    const last = this.log.since(null, { types: ['GATEWAY_UNAVAILABLE', 'GATEWAY_RECOVERED'] }).at(-1)
    return last?.type === 'GATEWAY_UNAVAILABLE' ? 'unavailable' : 'ok'
  }

  gatewayReachable(reachable: boolean, reason: string): void {
    if ((this.gateway() === 'ok') === reachable) return
    this.log.append({ type: reachable ? 'GATEWAY_RECOVERED' : 'GATEWAY_UNAVAILABLE', data: { reason } })
  }

  status(): SupervisorStatus {
    return readStatus(this.d.db)
  }

  resolveRun(target: string): Run | undefined {
    return resolveRun(this.runs, target)
  }

  covered = (): string[] => this.m.holds.covered()
  cover = (issue: string, by?: By): void => this.m.holds.cover(issue, by)
  uncover = (issue: string, by?: By): void => this.m.holds.uncover(issue, by)
  dependents = (issue: string): Promise<DependentsResponse> => this.m.holds.dependents(issue)
  awaiting = (issue: string): Awaiting | null => this.m.holds.awaiting(issue)
  held = (): string[] => this.m.holds.held()
  hold = (issue: string, by?: By): void => this.m.holds.hold(issue, by)
  unhold = (issue: string, by?: By): void => this.m.holds.unhold(issue, by)
  sendMessage = (target: string, text: string, by: By): Promise<Run> =>
    this.m.questions.sendMessage(target, text, by)
  answerQuestion = (issue: string, text: string, by: By): Promise<void> =>
    this.m.questions.answerQuestion(issue, text, by)
  escalationCount = (issue: string): number => this.m.remediation.escalationCount(issue)
  completeStage = (identifier: string): Promise<void> => this.m.verification.completeStage(identifier)
  holdStage = (identifier: string, stage: string, reason: string, comment: string): Promise<void> =>
    this.m.holds.holdStage(identifier, stage, reason, comment)
  gatesFinished = (runId: string, results: GateResult[]): Promise<void> =>
    this.m.verification.gatesFinished(runId, results)
  gateResults = (runId: string): GateEventData[] => this.m.verification.gateResults(runId)
  reviewFinished = (runId: string, outcome: ReviewOutcome): Promise<void> =>
    this.m.verification.reviewFinished(runId, outcome)
  pullRequestOpened = (record: PullRequestRecord, title: string): Promise<void> =>
    this.m.prWatch.pullRequestOpened(record, title)
  forcedManual = (issue: string): string | null => this.m.prWatch.forcedManual(issue)
  continuedFrom = (run: Run): string | undefined => this.m.dispatcher.continuationOf(run)?.headSha
  baseConflict = (run: Run): { base: string; files: string[] } | null =>
    this.m.dispatcher.baseConflicts().forRun(run.id)
  sandboxCreated = (runId: string, info: SandboxCreatedInfo): Promise<void> =>
    this.m.lifecycle.sandboxCreated(runId, info)
  workerProgress = (runId: string, progress: Progress): Promise<void> =>
    this.m.lifecycle.workerProgress(runId, progress)
  workerNoProgress = (runId: string, info: NoProgressInfo): Promise<void> =>
    this.m.lifecycle.workerNoProgress(runId, info)
  finishRejected = (runId: string, info: FinishRejectedInfo): Promise<void> =>
    this.m.lifecycle.finishRejected(runId, info)
  wipCommitted = (runId: string, info: { sha: string; lines: number }): Promise<void> =>
    this.m.lifecycle.wipCommitted(runId, info)
  workerStarted = (runId: string, info: WorkerStartedInfo): Promise<void> =>
    this.m.lifecycle.workerStarted(runId, info)
  workerStalled = (runId: string, signal: string, detail?: string): Promise<void> =>
    this.m.lifecycle.workerStalled(runId, signal, detail)
  workerFinished = (runId: string, payload: unknown): Promise<void> =>
    this.m.lifecycle.workerFinished(runId, payload)
  workerFailed = (runId: string, reason: string, detail?: string): Promise<void> =>
    this.m.lifecycle.workerFailed(runId, reason, detail)
  headImported = (runId: string, headSha: string): Promise<void> =>
    this.m.lifecycle.headImported(runId, headSha)
  lockRegenerated = (runId: string, lock: { feature: string; changed: boolean }): Promise<void> =>
    this.m.lifecycle.lockRegenerated(runId, lock)
  stopRun = (runId: string, reason: string, opts?: StopOptions): Promise<void> =>
    this.m.lifecycle.stopRun(runId, reason, opts)
  stopForUser = (
    target: string,
    reason: string | undefined,
    by: By,
    opts?: { now?: boolean },
  ): Promise<Run> => this.m.lifecycle.stopForUser(target, reason, by, opts)
  interruptRun = (runId: string, reason: string, opts?: { by?: By; requeue?: boolean }): Promise<void> =>
    this.m.lifecycle.interruptRun(runId, reason, opts)
  retryRun = (
    target: string,
    o: { agent?: string; profile?: string; continue?: boolean; forceSize?: boolean },
    by: By,
  ): Promise<Run> => this.m.dispatcher.retryRun(target, o, by)
  retryIngest = (issue: string): Promise<Run> => this.m.ingest.retryIngest(issue)

  implementProject(req: ImplementRequest, by: By = 'cli'): Promise<ImplementResponse> {
    return implementProject(
      this.rt,
      {
        cover: (issue, who) => this.m.holds.cover(issue, who),
        refresh: (identifier) => this.m.linearSync.refresh(identifier),
        applyIntent: (identifier, intent) => this.m.linearSync.applyIntent(identifier, intent),
      },
      req,
      by,
    )
  }

  async recordMiss(miss: MissReport): Promise<string> {
    if (this.d.evalDir === undefined) throw new ControlError('refused', 'no evaluation directory configured')
    return recordMiss(this.rt, this.d.evalDir, miss)
  }
}
