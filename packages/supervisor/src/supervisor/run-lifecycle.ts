import { viewIssue } from '../policy/stages'
import type { SandboxHandle } from '../ports'
import type { By } from '../ports/control'
import { ControlError } from '../ports/control'
import type { Progress, SandboxCreatedInfo, WorkerStartedInfo } from '../ports/worker'
import { type Event, EventValidationError } from '../state/events'
import { isTerminal, type Run } from '../state/runs'
import { activeRun } from '../state/targets'
import { type FinishLike, INGEST_AGENT, type RunFlow, type SupervisorRuntime } from './runtime'

const NO_FINISH_REASONS = ['step_cap', 'time_cap', 'token_cap', 'no_finish']

export class RunLifecycle {
  private readonly stalls = new Map<string, number>()

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
    let event: Event
    try {
      event = this.rt.log.append({
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
    this.rt.runs.update(runId, { finish: payload })
    const finish = payload as FinishLike
    if (run.agent === INGEST_AGENT) {
      await this.flow.ingestFinished(run, event, finish)
      return
    }
    if (finish.status === 'DONE' || finish.status === 'DONE_WITH_CONCERNS') {
      const gating = this.rt.runs.transition(runId, 'gating', event)
      await this.flow.enterVerification(run.issue)
      this.flow.schedule(gating)
      return
    }
    await this.preserveHead(runId, typeof finish.status === 'string' ? finish.status : undefined)
    await this.end(runId, 'failed', event)
    this.flow.releaseLease(run.issue)
    if (finish.status === 'NEEDS_CONTEXT') {
      await this.flow.askQuestion(run, event, finish.blocker ?? {})
      return
    }
    await this.flow.remediate(this.rt.requireRun(runId), 'blocked', finish.blocker?.reason)
  }

  async workerFailed(runId: string, reason: string, detail?: string): Promise<void> {
    if (this.late(runId, `failure ${reason}`)) return
    const run = this.rt.requireRun(runId)
    if (isTerminal(run.state)) return
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
    this.flow.releaseLease(run.issue)
    await this.flow.remediate(this.rt.requireRun(runId), reason, detail)
  }

  async headImported(runId: string, headSha: string): Promise<void> {
    const run = this.rt.runs.update(runId, { headSha })
    await this.destroySandbox(run)
    this.rt.runs.update(runId, { sandbox: null })
  }

  async stopRun(runId: string, reason: string, by?: By): Promise<void> {
    const run = this.rt.requireRun(runId)
    if (isTerminal(run.state)) return
    await this.rt.deps.executor.stop(run, reason)
    await this.preserveHead(runId, 'stopped')
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

  requireActive(target: string): Run {
    const run = activeRun(this.rt.runs, target)
    if (!run) throw new ControlError('not_found', `no active run for ${target}`)
    return run
  }

  async stopForUser(target: string, reason: string | undefined, by: By): Promise<Run> {
    const run = this.requireActive(target)
    await this.stopRun(run.id, reason ?? 'stopped by you', by)
    const issue = this.rt.cache.get(run.issue) ?? (await this.rt.deps.linear.issue(run.issue))
    const stage = (issue && viewIssue(issue, this.rt.config())?.stage) ?? ''
    await this.flow.holdForYou(run.issue, { kind: 'escalated', stage })
    return this.rt.requireRun(run.id)
  }

  async end(runId: string, to: 'done' | 'failed' | 'stopped', cause: Event): Promise<Run> {
    return this.rt.runs.transition(runId, to, cause)
  }

  handle(run: Run): SandboxHandle {
    return { driver: this.rt.config().sandbox.driver, id: run.sandbox ?? '', name: run.id }
  }

  async wipCommitted(runId: string, wip: { sha: string; lines: number }): Promise<void> {
    const run = this.rt.requireRun(runId)
    this.rt.log.append({
      type: 'WIP_COMMITTED',
      issue: run.issue,
      run: run.id,
      data: { run: run.id, sha: wip.sha, lines: wip.lines },
    })
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

  sandboxDestroyed(runId: string, handle: SandboxHandle): void {
    this.rt.log.append({
      type: 'SANDBOX_DESTROYED',
      run: runId,
      data: { driver: handle.driver, id: handle.id },
    })
  }
}
