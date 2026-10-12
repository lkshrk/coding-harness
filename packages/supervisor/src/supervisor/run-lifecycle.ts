import { effectiveLimits } from '../policy/limits'
import { issueSize, sizeData } from '../policy/size'
import { viewIssue } from '../policy/stages'
import type { SandboxHandle } from '../ports'
import type { By } from '../ports/control'
import { ControlError } from '../ports/control'
import type { NoProgressInfo, Progress, SandboxCreatedInfo, WorkerStartedInfo } from '../ports/worker'
import { type Event, EventValidationError } from '../state/events'
import { isTerminal, type Run } from '../state/runs'
import { activeRun } from '../state/targets'
import { SIZE_EXPLORE } from './dispatch'
import {
  type FinishLike,
  INGEST_AGENT,
  type RunFlow,
  type StopOptions,
  type SupervisorRuntime,
} from './runtime'

const NO_FINISH_REASONS = ['step_cap', 'time_cap', 'token_cap', 'no_finish']
// The worker was asked to hand off when it hit the limit; ending without one still keeps the run interrupted.
const RUN_LIMITS = ['step_cap', 'time_cap', 'token_cap']

export const handoffMessage = (reason: string, seconds: number) =>
  `nightshift is stopping this run (${reason}). Within ${seconds} seconds: finish your current step, commit your work, and call finish with status HANDOFF and a handoff note (done, in_progress, next, questions, verify). The next attempt continues from your commit.`

type Interruption = { reason: string; by?: By; requeue: boolean }

type PendingHandoff = Interruption & { resolve: () => void }

export class RunLifecycle {
  private readonly stalls = new Map<string, number>()
  private readonly handoffs = new Map<string, PendingHandoff>()

  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly flow: RunFlow,
  ) {}

  forgetStalls(runId: string): void {
    this.stalls.delete(runId)
  }

  late(runId: string, what: string): boolean {
    if (this.flow.stopped()) console.error(`run ${runId}: ${what} after supervisor stop ignored`)
    return this.flow.stopped()
  }

  async sandboxCreated(runId: string, info: SandboxCreatedInfo): Promise<void> {
    if (this.late(runId, 'sandbox created')) return
    this.rt.log.append({ type: 'SANDBOX_CREATED', run: runId, data: info })
  }

  async workerProgress(runId: string, progress: Progress): Promise<void> {
    if (this.late(runId, 'progress')) return
    this.rt.log.append({ type: 'WORKER_PROGRESS', run: runId, data: progress })
  }

  async workerNoProgress(runId: string, info: NoProgressInfo): Promise<void> {
    if (this.late(runId, 'no progress')) return
    const run = this.rt.requireRun(runId)
    this.rt.log.append({ type: 'WORKER_NO_PROGRESS', issue: run.issue, run: run.id, data: info })
  }

  async wipCommitted(runId: string, info: { sha: string; lines: number }): Promise<void> {
    if (this.late(runId, 'wip commit')) return
    const run = this.rt.requireRun(runId)
    this.rt.log.append({ type: 'WIP_COMMITTED', issue: run.issue, run: run.id, data: info })
  }

  async workerStarted(runId: string, info: WorkerStartedInfo): Promise<void> {
    if (this.late(runId, 'start')) return
    const run = this.rt.runs.update(runId, { sandbox: info.sandbox, session: info.session })
    const event = this.rt.log.append({
      type: 'WORKER_STARTED',
      issue: run.issue,
      run: run.id,
      data: { sandbox: info.sandbox, session: info.session, ...(info.attach ? { attach: info.attach } : {}) },
    })
    this.rt.runs.transition(run.id, 'running', event)
    this.flow.gatewayReachable(true, `worker started for run ${run.id}`)
    if (info.attach) {
      await this.rt.postOnce(
        run.issue,
        event.id,
        `Worker \`${run.agent}\` started (attempt ${run.attempt}). Attach: \`${info.attach}\``,
      )
    }
  }

  async workerStalled(runId: string, signal: string, detail?: string): Promise<void> {
    if (this.late(runId, `stall ${signal}`)) return
    const run = this.rt.requireRun(runId)
    if (isTerminal(run.state)) return
    this.rt.log.append({
      type: 'WORKER_STALLED',
      issue: run.issue,
      run: run.id,
      data: { signal, ...(detail ? { detail } : {}) },
    })
    const count = (this.stalls.get(runId) ?? 0) + 1
    this.stalls.set(runId, count)
    if (count === 1) {
      await this.rt.deps.executor.nudge(
        run,
        `nightshift: no progress detected (${signal}); continue or call finish`,
      )
      return
    }
    await this.rt.deps.executor.stop(run, `stalled: ${signal}`)
    await this.workerFailed(runId, 'stopped', `stalled: ${signal}`)
  }

  async workerFinished(runId: string, payload: unknown): Promise<void> {
    if (this.late(runId, 'finish')) return
    const run = this.rt.requireRun(runId)
    if (isTerminal(run.state)) return
    const handoff = (payload as FinishLike | null)?.status === 'HANDOFF'
    let event: Event
    try {
      event = this.rt.log.append({
        type: handoff ? 'HANDOFF_WRITTEN' : 'WORKER_FINISHED',
        issue: run.issue,
        run: run.id,
        data: payload as Record<string, unknown>,
      })
    } catch (e) {
      if (!(e instanceof EventValidationError)) throw e
      await this.workerFailed(runId, 'no_finish', e.errors.join('; '))
      return
    }
    this.rt.runs.update(runId, { finish: payload })
    const finish = payload as FinishLike
    const pending = this.handoffs.get(runId)
    if (handoff) {
      await this.interrupted(runId, pending ?? { reason: 'worker handed off', requeue: true }, true)
      pending?.resolve()
      return
    }
    pending?.resolve()
    if (run.agent === INGEST_AGENT) {
      await this.flow.ingestFinished(run, event, finish)
      return
    }
    if ((finish.status === 'DONE' || finish.status === 'DONE_WITH_CONCERNS') && this.sizeExplore(run)) {
      await this.explored(run, event, payload)
      return
    }
    if (finish.status === 'DONE' || finish.status === 'DONE_WITH_CONCERNS') {
      const gating = this.rt.runs.transition(runId, 'gating', event)
      await this.flow.enterVerification(run.issue)
      this.flow.schedule(gating)
      return
    }
    await this.preserveHead(runId, String(finish.status))
    await this.end(runId, 'failed', event)
    await this.releaseSandbox(runId)
    this.flow.releaseLease(run.issue)
    if (finish.status === 'NEEDS_CONTEXT') {
      await this.flow.askQuestion(run, event, finish.blocker ?? {})
      return
    }
    await this.flow.remediate(this.rt.requireRun(runId), 'blocked', finish.blocker?.reason)
  }

  sizeExplore(run: Run): boolean {
    const dispatched = this.rt.log.since(null, { run: run.id, types: ['DISPATCHED'] }).at(-1)
    return dispatched?.data.reason === SIZE_EXPLORE
  }

  // The explorer only maps the code; its reading list feeds the implementer run that follows.
  async explored(run: Run, event: Event, payload: unknown): Promise<void> {
    this.rt.runs.transition(run.id, 'gating', event)
    this.rt.runs.transition(run.id, 'reviewing', event)
    await this.end(run.id, 'done', event)
    await this.releaseSandbox(run.id)
    this.flow.releaseLease(run.issue)
    const estimate = (payload as { report?: { size_estimate?: unknown } }).report?.size_estimate
    const issue = this.rt.cache.get(run.issue)
    const view = issue && viewIssue(issue, this.rt.config(), this.flow.viewOptions(run.issue))
    if (view) {
      const size = issueSize(
        view,
        view.repository === null ? undefined : this.rt.config().repositories[view.repository],
        effectiveLimits(this.rt.config(), run.profile),
      )
      this.rt.log.append({
        type: 'SIZE_CHECKED',
        issue: run.issue,
        run: run.id,
        data: {
          ...sizeData(size, 'dispatch', run.profile),
          ...(typeof estimate === 'number' ? { explorer_estimate: estimate } : {}),
        },
      })
    }
    await this.flow.applyIntent(run.issue, { kind: 'retryScheduled' })
  }

  async workerFailed(runId: string, reason: string, detail?: string): Promise<void> {
    if (this.late(runId, `failure ${reason}`)) return
    const run = this.rt.requireRun(runId)
    if (isTerminal(run.state)) return
    const pending = this.handoffs.get(runId)
    if (pending) {
      pending.resolve()
      return
    }
    if (RUN_LIMITS.includes(reason)) {
      await this.interrupted(runId, { reason: `run limit: ${reason}`, requeue: true }, false)
      return
    }
    if (reason === 'gateway_error') this.flow.gatewayReachable(false, detail ?? reason)
    if (run.agent === INGEST_AGENT) {
      await this.flow.ingestRunFailed(runId, detail ? `${reason}: ${detail}` : reason)
      return
    }
    const event = this.rt.log.append({
      type: NO_FINISH_REASONS.includes(reason) ? 'WORKER_NO_FINISH' : 'WORKER_FAILED',
      issue: run.issue,
      run: run.id,
      data: { reason, ...(detail ? { detail } : {}) },
    })
    await this.preserveHead(runId, reason)
    await this.end(runId, 'failed', event)
    this.stalls.delete(runId)
    await this.releaseSandbox(runId)
    this.flow.releaseLease(run.issue)
    await this.flow.remediate(this.rt.requireRun(runId), reason, detail)
  }

  async headImported(runId: string, headSha: string): Promise<void> {
    const run = this.rt.runs.update(runId, { headSha })
    await this.destroySandbox(run)
    this.rt.runs.update(runId, { sandbox: null })
  }

  async lockRegenerated(runId: string, lock: { feature: string; changed: boolean }): Promise<void> {
    if (this.late(runId, 'lock')) return
    const run = this.rt.requireRun(runId)
    this.rt.log.append({ type: 'LOCK_REGENERATED', issue: run.issue, run: run.id, data: lock })
  }

  async stopRun(runId: string, reason: string, opts: StopOptions = {}): Promise<void> {
    const { by, keepWork = true } = opts
    await this.flow.cancelSteps(runId)
    const run = this.rt.requireRun(runId)
    if (isTerminal(run.state)) return
    await this.rt.deps.executor.stop(run, reason)
    if (keepWork) await this.preserveHead(runId, 'stopped')
    const event = this.rt.log.append({
      type: 'WORKER_FAILED',
      issue: run.issue,
      run: run.id,
      data: { reason: 'stopped', detail: reason, ...(by ? { by } : {}) },
    })
    await this.end(runId, 'stopped', event)
    this.stalls.delete(runId)
    await this.destroySandbox(run)
    this.flow.releaseLease(run.issue)
  }

  // The worker gets the grace period to hand off; one that does not is killed and its work tree kept as WIP.
  async interruptRun(
    runId: string,
    reason: string,
    opts: { by?: By; requeue?: boolean } = {},
  ): Promise<void> {
    const run = this.rt.requireRun(runId)
    if (run.state !== 'running' || this.handoffs.has(runId)) return
    const seconds = this.rt.config().limits.handoff_grace_seconds
    const why: Interruption = { reason, requeue: opts.requeue ?? true, ...(opts.by ? { by: opts.by } : {}) }
    const answered = new Promise<void>((resolve) => this.handoffs.set(runId, { ...why, resolve }))
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, seconds * 1000)
    })
    try {
      void this.rt.deps.executor.nudge(run, handoffMessage(reason, seconds)).catch((e: Error) => {
        console.error(`${run.issue}: asking run ${run.id} to hand off failed: ${e.message}`)
      })
      await Promise.race([answered, expired])
    } finally {
      clearTimeout(timer)
      this.handoffs.delete(runId)
    }
    if (this.rt.requireRun(runId).state !== 'running') return
    await this.rt.deps.executor.stop(run, `interrupted: ${reason}`)
    await this.interrupted(runId, why, false)
  }

  private async interrupted(runId: string, why: Interruption, handoff: boolean): Promise<void> {
    await this.preserveHead(runId, 'interrupted')
    const run = this.rt.requireRun(runId)
    const event = this.rt.log.append({
      type: 'RUN_INTERRUPTED',
      issue: run.issue,
      run: run.id,
      data: { reason: why.reason, handoff, ...(why.by ? { by: why.by } : {}) },
    })
    await this.end(runId, 'interrupted', event)
    this.stalls.delete(runId)
    await this.releaseSandbox(runId)
    this.flow.releaseLease(run.issue)
    // The issue of an ingest is already done: the ingest module resumes it, or a user stop leaves it to `ns ingest`.
    if (run.agent === INGEST_AGENT) {
      if (why.by) await this.flow.ingestRunFailed(runId, `stopped: ${why.reason}`)
    } else if (why.requeue) await this.flow.applyIntent(run.issue, { kind: 'retryScheduled' })
  }

  requireActive(target: string): Run {
    const run = activeRun(this.rt.runs, target)
    if (!run) throw new ControlError('not_found', `no active run for ${target}`)
    return run
  }

  async stopForUser(
    target: string,
    reason: string | undefined,
    by: By,
    opts: { now?: boolean } = {},
  ): Promise<Run> {
    const run = this.requireActive(target)
    const why = reason ?? 'stopped by you'
    if (!opts.now && run.state === 'running') await this.interruptRun(run.id, why, { by, requeue: false })
    if (!isTerminal(this.rt.requireRun(run.id).state)) await this.stopRun(run.id, why, { by })
    const issue = this.rt.cache.get(run.issue) ?? (await this.rt.deps.linear.issue(run.issue))
    const stage = (issue && viewIssue(issue, this.rt.config())?.stage) ?? ''
    await this.flow.holdForYou(run.issue, { kind: 'escalated', stage })
    return this.rt.requireRun(run.id)
  }

  async end(runId: string, to: 'done' | 'failed' | 'stopped' | 'interrupted', cause: Event): Promise<Run> {
    return this.rt.runs.transition(runId, to, cause)
  }

  handle(run: Run): SandboxHandle {
    return { driver: this.rt.config().sandbox.driver, id: run.sandbox ?? '', name: run.id }
  }

  async preserveHead(runId: string, status?: string): Promise<void> {
    const run = this.rt.requireRun(runId)
    if (run.headSha !== null || run.sandbox === null || run.agent === INGEST_AGENT) return
    try {
      const head = await this.rt.deps.executor.captureHead?.(run, status)
      if (head) this.rt.runs.update(runId, { headSha: head })
    } catch (e) {
      console.error(`${run.issue}: keeping the commits of run ${run.id} failed: ${(e as Error).message}`)
    }
  }

  async destroySandbox(run: Run): Promise<void> {
    if (run.sandbox === null) return
    const handle = this.handle(run)
    await this.rt.deps.sandbox.destroy(handle)
    this.sandboxDestroyed(run.id, handle)
  }

  // An ended run's head is already preserved; a failed destroy leaves the outcome as is.
  async releaseSandbox(runId: string): Promise<void> {
    const run = this.rt.requireRun(runId)
    if (run.sandbox === null) return
    try {
      await this.destroySandbox(run)
      this.rt.runs.update(runId, { sandbox: null })
    } catch (e) {
      console.error(`${run.issue}: destroying the sandbox of run ${run.id} failed: ${(e as Error).message}`)
    }
  }

  sandboxDestroyed(runId: string, handle: SandboxHandle): void {
    this.rt.log.append({
      type: 'SANDBOX_DESTROYED',
      run: runId,
      data: { driver: handle.driver, id: handle.id },
    })
  }
}
