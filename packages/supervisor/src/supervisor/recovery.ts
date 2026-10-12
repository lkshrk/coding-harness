import { decide, VERIFICATION, viewIssue } from '../policy/stages'
import type { EventType } from '../state/event-schema'
import type { Event } from '../state/events'
import { isTerminal, type Run } from '../state/runs'
import {
  type FinishLike,
  INGEST_AGENT,
  type RecoveryReport,
  type RunFlow,
  type SupervisorRuntime,
} from './runtime'

const FINISH_HANDLED: EventType[] = [
  'QUESTION_ASKED',
  'FAILURE_CLASSIFIED',
  'STAGE_ENTERED',
  'GATE_PASSED',
  'GATE_FAILED',
  'SIZE_CHECKED',
  'DISPATCHED',
]

export class Recovery {
  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly flow: RunFlow,
  ) {}

  async recover(): Promise<RecoveryReport> {
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
    const withRun = new Set(this.rt.runs.active().map((r) => r.issue))
    const lost = [...this.rt.cache.values()].filter((i) => {
      const view = viewIssue(i, this.rt.config(), this.flow.viewOptions(i.identifier))
      if (view?.lifecycle !== 'running' || withRun.has(i.identifier)) return false
      return (
        view.stage === VERIFICATION ||
        decide(view, this.rt.config(), { agentKind: this.rt.deps.agentKind }).kind === 'running'
      )
    })
    for (const run of this.rt.runs.active()) await this.recoverRun(run, report)
    report.answered = await this.flow.checkQuestions()

    const active = new Set(this.rt.runs.active().map((r) => r.id))
    for (const handle of await this.rt.deps.sandbox.list({ nightshift: '1' })) {
      if (active.has(handle.name)) continue
      await this.rt.deps.sandbox.destroy(handle)
      report.orphanSandboxes.push(handle.id)
      if (this.rt.runs.get(handle.name)) this.flow.sandboxDestroyed(handle.name, handle)
    }
    const sandboxes = new Set((await this.rt.deps.sandbox.list({ nightshift: '1' })).map((h) => h.name))
    for (const dir of this.rt.deps.outbox.list()) {
      if (sandboxes.has(dir)) continue
      this.rt.deps.outbox.remove(dir)
      report.orphanOutboxes.push(dir)
    }

    for (const issue of lost) {
      const run = this.rt.runs.forIssue(issue.identifier).at(-1)
      const finish = run && isTerminal(run.state) ? this.pendingFinish(run) : undefined
      if (run && finish) {
        await this.flow.handleFinish(run, finish, run.finish as FinishLike)
        report.resumed.push(run.id)
        continue
      }
      await this.rt.postOnce(
        issue.identifier,
        `lost-${issue.updatedAt}`,
        'nightshift lost the runtime state of this run; it is dispatched again.',
      )
      await this.flow.applyIntent(issue.identifier, { kind: 'lost' })
      report.lost.push(issue.identifier)
    }
    return report
  }

  async recoverRun(run: Run, report: Pick<RecoveryReport, 'reattached' | 'resumed' | 'failed' | 'stopped'>) {
    if (run.agent === INGEST_AGENT) {
      await this.flow.ingestRunFailed(run.id, 'interrupted by supervisor restart')
      report.failed.push(run.id)
      return
    }
    const issue = await this.rt.deps.linear.issue(run.issue)
    if (issue) this.flow.observeIssue(issue)
    const view = issue && viewIssue(issue, this.rt.config(), this.flow.viewOptions(issue.identifier))
    if (!issue) {
      await this.flow.stopRun(run.id, 'issue changed in Linear')
      report.stopped.push(run.id)
      return
    }
    if (view?.lifecycle !== 'running' && (await this.flow.resolveMismatch(run, issue))) {
      report.stopped.push(run.id)
      return
    }
    if (run.state === 'queued') {
      this.flow.takeLease(run)
      report.resumed.push(run.id)
      return
    }
    const finish = this.pendingFinish(run)
    if (finish && (run.state === 'running' || run.state === 'gating')) {
      this.flow.takeLease(run)
      await this.flow.handleFinish(run, finish, run.finish as FinishLike)
      report.resumed.push(run.id)
      return
    }
    if (run.state === 'gating' || run.state === 'reviewing') {
      this.flow.takeLease(run)
      this.flow.schedule(run)
      report.resumed.push(run.id)
      return
    }
    if (await this.alive(run)) {
      this.flow.takeLease(run)
      await this.rt.deps.executor.reattach(run)
      report.reattached.push(run.id)
      return
    }
    await this.flow.workerFailed(run.id, 'supervisor_restart')
    report.failed.push(run.id)
  }

  // A finish recorded before a restart whose handling (question, remediation, verification) never happened.
  pendingFinish(run: Run): Event | undefined {
    if (run.agent === INGEST_AGENT || run.finish === null) return undefined
    const finished = this.rt.log.since(null, { run: run.id, types: ['WORKER_FINISHED'] }).at(-1)
    if (!finished) return undefined
    const handled = this.rt.log.since(finished.id, { issue: run.issue, types: FINISH_HANDLED })
    return handled.length ? undefined : finished
  }

  async alive(run: Run): Promise<boolean> {
    if (run.sandbox === null || run.session === null) return false
    if ((await this.rt.deps.sandbox.status(this.flow.sandboxHandle(run))) !== 'running') return false
    return this.rt.deps.worker.alive({ id: run.session, attach: [] })
  }
}
