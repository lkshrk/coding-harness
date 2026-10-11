import { GatewayError, profileEntries } from '@nightshift/core'
import { prRef } from '../policy/naming'
import type { RetryQueue } from '../policy/retry'
import { selectAgent } from '../policy/selection'
import { INTEGRATION, type IssueView, viewIssue } from '../policy/stages'
import type { ExecutorStart } from '../ports'
import type { By } from '../ports/control'
import { ControlError } from '../ports/control'
import type { PullRequestRecord } from '../ports/git-host'
import { BaseConflictError } from '../ports/worker'
import { TaskTooLargeError } from '../stages/context'
import { BaseConflictStore } from '../stages/integration/records'
import type { LeaseStore } from '../state/leases'
import { isTerminal, type Run } from '../state/runs'
import { isIssueRef } from '../state/targets'
import type { RunFlow, SupervisorRuntime } from './runtime'

type PrHead = { ref: string; headSha: string }

type Continuation = { run: string; headSha: string } | PrHead

type DispatchOverride = {
  agent?: string
  profile?: string
  by?: By
  continueFrom?: Run
  continueRef?: PrHead
}

const STAGE_FAILURE_LIMIT = 3

export class Dispatcher {
  private readonly roleInFlight = new Set<string>()
  private readonly roleFailures = new Map<string, number>()

  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly leaseStore: LeaseStore,
    private readonly retry: RetryQueue,
    private readonly flow: RunFlow,
  ) {}

  async dispatch(view: IssueView, o: DispatchOverride = {}): Promise<Run | undefined> {
    const id = view.snapshot.identifier
    const repository = view.repository
    const stage = view.stage
    if (repository === null || stage === null) return undefined
    const last = this.rt.runs.forIssue(id).at(-1)
    const attempt = (last?.attempt ?? 0) + 1
    const agent = o.agent ?? this.selectFor(view, stage, attempt, last)
    if (agent === undefined) return undefined
    const profile = o.profile ?? this.profileFor(view)
    const model = this.rt.deps.modelFor(agent, profile, this.rt.config())
    const baseSha = await this.rt.deps.repos.baseSha(repository)
    const from = this.sourceOf(id, attempt, {
      continues: o.continueFrom?.id,
      continues_ref: o.continueRef?.ref,
      continues_sha: o.continueRef?.headSha,
    })
    const conflicts = this.baseConflicts()
    const files =
      from && !this.conflictRound(id) ? await this.conflictingFiles(repository, baseSha, from) : []
    if (files.length && conflicts.get(id)?.base === baseSha) {
      this.retry.take(id)
      await this.holdBaseConflict(id, stage, baseSha, files)
      return undefined
    }
    const run = this.rt.runs.create({ issue: id, agent, profile, model, repository, baseSha, attempt })
    if (files.length) conflicts.put(id, { base: baseSha, files, run: run.id })
    const dispatched = this.rt.log.append({
      type: 'DISPATCHED',
      issue: id,
      run: run.id,
      data: {
        agent,
        profile,
        model,
        attempt,
        repository,
        base: this.rt.config().repositories[repository]?.base ?? 'main',
        ...(o.by ? { reason: 'manual retry', by: o.by } : last?.failure ? { reason: last.failure } : {}),
        ...(o.continueFrom ? { continues: o.continueFrom.id } : {}),
        ...(o.continueRef ? { continues_ref: o.continueRef.ref, continues_sha: o.continueRef.headSha } : {}),
      },
    })
    if (!this.leaseStore.acquire(id, run.id)) {
      this.rt.runs.transition(run.id, 'stopped', dispatched)
      return undefined
    }
    this.flow.leaseEvent('LEASE_ACQUIRED', id)
    this.retry.take(id)
    await this.flow.applyIntent(id, { kind: 'dispatched' })
    await this.launch(run, view)
    return run
  }

  selectFor(view: IssueView, stage: string, attempt: number, last: Run | undefined) {
    return selectAgent(this.rt.config().selection, {
      stage,
      issueType: view.issueType,
      failureClass: last?.failure,
      attempt,
    })
  }

  async launch(run: Run, view: IssueView): Promise<void> {
    const started = this.rt.runs.transition(
      run.id,
      'starting',
      this.rt.log.append({ type: 'RUN_STARTING', issue: run.issue, run: run.id, data: {} }),
    )
    try {
      const repairFrom = this.continuationOf(run)
      await this.rt.deps.executor.start({
        run: started,
        issue: view.snapshot,
        files: view.files,
        ...(repairFrom ? { repairFrom } : {}),
      })
      if (!isTerminal(this.rt.requireRun(run.id).state))
        this.flow.gatewayReachable(true, `run ${run.id} started`)
    } catch (e) {
      const reason =
        e instanceof TaskTooLargeError || e instanceof BaseConflictError
          ? e.reason
          : e instanceof GatewayError
            ? 'gateway_error'
            : 'sandbox_error'
      await this.flow.workerFailed(run.id, reason, (e as Error).message)
    }
  }

  continuationOf(run: Run): ExecutorStart['repairFrom'] {
    const dispatched = this.rt.log.since(null, { run: run.id, types: ['DISPATCHED'] }).at(-1)
    const from = this.sourceOf(run.issue, run.attempt, dispatched?.data ?? {})
    if (!from) return undefined
    const resolve = this.conflictRound(run.issue, run.id) || this.baseConflicts().forRun(run.id) !== null
    return resolve ? { ...from, resolveConflicts: true } : from
  }

  sourceOf(issue: string, attempt: number, d: Record<string, unknown>): Continuation | undefined {
    const { continues, continues_ref, continues_sha } = d
    if (typeof continues_ref === 'string' && typeof continues_sha === 'string')
      return { ref: continues_ref, headSha: continues_sha }
    const from =
      typeof continues === 'string'
        ? this.rt.runs.get(continues)
        : this.rt.runs
            .forIssue(issue)
            .find((r) => r.attempt === attempt - 1 && r.failure === 'implementation_defect')
    return from?.headSha ? { run: from.id, headSha: from.headSha } : undefined
  }

  // A run repairing a PR conflict leaves the merge of the base to the worker instead of escalating.
  conflictRound(issue: string, runId?: string): boolean {
    const conflict = this.rt.pullRequests.get(issue)?.conflict
    const from = conflict && !conflict.held ? this.rt.runs.get(conflict.run) : undefined
    if (!from) return false
    return !this.rt.runs
      .forIssue(issue)
      .some((r) => r.id !== runId && r.attempt > from.attempt && r.state === 'done')
  }

  baseConflicts(): BaseConflictStore {
    return new BaseConflictStore(this.rt.deps.db)
  }

  // An inspection failure falls back to merging in the sandbox, which ends a conflict as base_conflict.
  async conflictingFiles(repository: string, base: string, from: Continuation): Promise<string[]> {
    const inspect = this.rt.deps.repos.conflictingFiles
    if (!inspect || !base) return []
    try {
      return await inspect.call(this.rt.deps.repos, repository, base, from.headSha)
    } catch (e) {
      console.error(
        `${repository}: inspecting the merge of ${base} into ${from.headSha}: ${(e as Error).message}`,
      )
      return []
    }
  }

  async holdBaseConflict(id: string, stage: string, base: string, files: string[]): Promise<void> {
    const list = files.join(', ')
    await this.rt.postOnce(
      id,
      `base-conflict-${base}`,
      `Merging base ${base} into the continued attempt still conflicts after a resolving attempt, in: ${list}. Resolve it by hand, retry without \`--continue\`, or retry once the base moves.`,
    )
    await this.flow.holdForYou(id, { kind: 'escalated', stage, reason: 'base_conflict' })
    await this.rt.notify(`${id} conflicts with base ${base.slice(0, 12)}`, id, {
      kind: 'blocked',
      context: [`conflicting files: ${list}`],
      action: `Resolve the conflict by hand or \`ns retry ${id}\` for a fresh attempt`,
    })
  }

  async launchQueued(): Promise<void> {
    for (const run of this.rt.runs.active()) {
      if (run.state !== 'queued') continue
      const issue = this.rt.cache.get(run.issue)
      const view = issue && viewIssue(issue, this.rt.config(), this.flow.viewOptions(run.issue))
      if (view) await this.launch(run, view)
    }
  }

  profileFor(view: IssueView): string {
    const projectId = view.snapshot.project?.id
    const chosen = projectId
      ? this.rt.deps.db
          .query<{ value: string }, [string]>(
            "SELECT value FROM session_choices WHERE project = ? AND key = 'profile'",
          )
          .get(projectId)?.value
      : undefined
    return chosen ?? view.project.profile ?? this.rt.config().profiles.active
  }

  async retryRun(
    target: string,
    o: { agent?: string; profile?: string; continue?: boolean },
    by: By,
  ): Promise<Run> {
    const identifier = this.flow.resolveRun(target)?.issue ?? (isIssueRef(target) ? target : undefined)
    if (!identifier) throw new ControlError('not_found', `unknown target ${target}`)
    const snapshot = await this.rt.deps.linear.issue(identifier)
    if (!snapshot) throw new ControlError('not_found', `unknown issue ${identifier}`)
    this.flow.observeIssue(snapshot)
    const pr = this.rt.pullRequests.get(identifier)
    const runs = this.rt.runs.forIssue(identifier)
    const prHead = pr ? await this.prHead(pr) : undefined
    const prRun = prHead ? runs.filter((r) => r.headSha === prHead).at(-1) : undefined
    const continueRef = pr && prHead && !prRun ? await this.fetchPrHead(identifier, pr, prHead) : undefined
    const before = viewIssue(snapshot, this.rt.config(), this.flow.viewOptions(identifier))
    if (pr && before?.stage === INTEGRATION && before.lifecycle !== 'done' && before.lifecycle !== 'canceled')
      await this.flow.applyIntent(identifier, { kind: 'retryRequested' })
    const current = this.rt.cache.get(identifier) ?? snapshot
    const view = viewIssue(current, this.rt.config(), this.flow.viewOptions(identifier))
    const stage = view?.stage ?? null
    if (!view || stage === null || view.repository === null || !this.rt.config().stages[stage]?.automatic) {
      throw new ControlError('refused', `${identifier}: stage ${stage ?? '(none)'} has no automatic role`)
    }
    if (view.lifecycle === 'done' || view.lifecycle === 'canceled') {
      throw new ControlError('refused', `${identifier} is ${view.lifecycle}`)
    }
    if (o.profile && !profileEntries(this.rt.config().profiles).some(([name]) => name === o.profile)) {
      throw new ControlError('refused', `no profile '${o.profile}'`)
    }
    const continueFrom = continueRef
      ? undefined
      : (prRun ?? (o.continue ? runs.filter((r) => r.headSha !== null).at(-1) : undefined))
    if (o.continue && !continueFrom && !continueRef) {
      throw new ControlError('refused', `${identifier}: no earlier attempt has a commit to continue from`)
    }
    const last = runs.at(-1)
    const agent = o.agent ?? this.selectFor(view, stage, (last?.attempt ?? 0) + 1, last)
    if (agent === undefined || this.rt.deps.agentKind(agent) !== 'worker') {
      throw new ControlError('refused', `${identifier}: no worker agent for stage ${stage}`)
    }
    const active = this.rt.runs.active().find((r) => r.issue === identifier)
    if (active) await this.flow.stopRun(active.id, 'retry requested', { by })
    this.flow.setAwaiting(identifier, null)
    const run = await this.dispatch(view, {
      agent,
      ...(o.profile ? { profile: o.profile } : {}),
      ...(continueFrom ? { continueFrom } : {}),
      ...(continueRef ? { continueRef } : {}),
      by,
    })
    if (!run && this.flow.awaiting(identifier)?.reason === 'base_conflict')
      throw new ControlError('refused', `${identifier}: the continued attempt still conflicts with the base`)
    if (!run) throw new ControlError('refused', `${identifier} could not be dispatched (lease held)`)
    await this.flow.refresh(identifier)
    return this.rt.requireRun(run.id)
  }

  async prHead(pr: PullRequestRecord): Promise<string> {
    const state = await this.rt.deps.gitHost?.state(pr)
    return state?.state === 'open' && state.headSha ? state.headSha : pr.headSha
  }

  async fetchPrHead(identifier: string, pr: PullRequestRecord, headSha: string): Promise<PrHead> {
    const fetch = this.rt.deps.repos.fetchPullRequest
    if (!fetch) {
      throw new ControlError(
        'refused',
        `${identifier}: the open PR head ${headSha} is not a nightshift attempt and cannot be fetched`,
      )
    }
    const ref = prRef(pr.number)
    const fetched = await fetch.call(this.rt.deps.repos, pr.repository, pr)
    if (fetched !== headSha) {
      throw new ControlError(
        'refused',
        `${identifier}: fetched ${ref} at ${fetched}, but the open PR head is ${headSha}`,
      )
    }
    return { ref, headSha }
  }

  runRole(view: IssueView, stage: string, agent: string | undefined): void {
    const handler = this.rt.deps.stageHandler
    const id = view.snapshot.identifier
    if (this.roleInFlight.has(id)) return
    if (!handler || (handler.handles && !handler.handles(stage))) {
      this.roleInFlight.add(id)
      this.noHandler(id, stage)
        .catch((e) => console.error(`stage ${stage} on ${id}: ${(e as Error).message}`))
        .finally(() => this.roleInFlight.delete(id))
      return
    }
    this.roleInFlight.add(id)
    const key = `${id}:${stage}`
    handler
      .run({ issue: view.snapshot, stage, agent })
      .then(() => this.roleFailures.delete(key))
      .catch((e) => this.roleFailed(id, stage, key, (e as Error).message))
      .finally(() => this.roleInFlight.delete(id))
  }

  async noHandler(id: string, stage: string): Promise<void> {
    const reason = `no handler for stage ${stage}`
    const held = this.flow.awaiting(id)
    if (held?.stage === stage && held.reason === reason) return
    console.error(`${id}: ${reason}`)
    await this.flow.holdForYou(id, { kind: 'escalated', stage, reason })
    await this.rt.notify(reason, id, {
      kind: 'blocked',
      action: `Move ${id} past ${stage} by hand, or fix the supervisor and move it to Todo`,
    })
  }

  async roleFailed(id: string, stage: string, key: string, message: string): Promise<void> {
    console.error(`stage ${stage} on ${id}: ${message}`)
    const count = (this.roleFailures.get(key) ?? 0) + 1
    this.roleFailures.set(key, count)
    if (count < STAGE_FAILURE_LIMIT) return
    this.roleFailures.delete(key)
    await this.flow.holdForYou(id, { kind: 'escalated', stage })
    await this.rt.notify(`${stage} failed ${count} times in a row`, id, {
      kind: 'failed',
      context: [message],
      action: `Fix the cause, then move ${id} to Todo to try ${stage} again`,
    })
  }
}
