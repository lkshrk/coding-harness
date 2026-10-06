import {
  IMPLEMENTATION,
  INTEGRATION,
  type IssueView,
  nextStage,
  VERIFICATION,
  viewIssue,
} from '../policy/stages'
import type { GateResult } from '../ports'
import { type GateEventData, gateComment, gateEventData } from '../stages/gates/report'
import { blockerSummary, type ReviewOutcome, reviewComment } from '../stages/gates/review'
import type { Event } from '../state/events'
import type { RunFlow, SupervisorRuntime } from './runtime'

export class Verification {
  private readonly reviewRefused = new Set<string>()

  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly flow: RunFlow,
  ) {}

  rescheduleRefused(): void {
    for (const id of [...this.reviewRefused]) {
      this.reviewRefused.delete(id)
      const run = this.rt.runs.get(id)
      if (run?.state === 'reviewing') this.flow.schedule(run)
    }
  }

  async completeStage(identifier: string): Promise<void> {
    const issue = await this.rt.deps.linear.issue(identifier)
    const view = issue && viewIssue(issue, this.rt.config(), this.flow.viewOptions(issue.identifier))
    if (!view?.stage) return
    const def = this.rt.config().stages[view.stage]
    if (def?.human_checkpoint === 'after' && view.awaiting?.kind !== 'after') {
      await this.flow.holdForYou(identifier, { kind: 'after', stage: view.stage })
      await this.rt.notify(`${view.stage} finished and waits for your check`, identifier, {
        kind: 'blocked',
        action: `Check the result, then \`ns resume ${identifier}\` to continue`,
      })
      return
    }
    await this.advance(view)
  }

  async gatesFinished(runId: string, results: GateResult[]): Promise<void> {
    const run = this.rt.requireRun(runId)
    if (run.state !== 'gating') return
    let last: Event | undefined
    for (const r of results) {
      last = this.rt.log.append({
        type: r.passed ? 'GATE_PASSED' : 'GATE_FAILED',
        issue: run.issue,
        run: run.id,
        data: gateEventData(r),
      })
    }
    const failed = results.find((r) => !r.passed)
    if (!last) {
      await this.flow.workerFailed(runId, 'crash', 'gate runner returned no results')
      return
    }
    if (!failed) {
      const reviewing = this.rt.runs.transition(runId, 'reviewing', last)
      this.flow.schedule(reviewing)
      return
    }
    await this.flow.end(runId, 'failed', last)
    this.flow.releaseLease(run.issue)
    await this.rt.postOnce(run.issue, last.id, gateComment(failed))
    await this.flow.remediate(
      this.rt.requireRun(runId),
      'gate_failed',
      `${failed.check} exited ${failed.result.exitCode}${failed.result.timedOut ? ' (timed out)' : ''}`,
    )
  }

  gateResults(runId: string): GateEventData[] {
    return this.rt.log
      .since(null, { run: runId, types: ['GATE_PASSED'] })
      .map((e) => e.data as unknown as GateEventData)
  }

  async reviewFinished(runId: string, outcome: ReviewOutcome): Promise<void> {
    const run = this.rt.requireRun(runId)
    if (run.state !== 'reviewing') return
    if (outcome.kind === 'refused') {
      this.reviewRefused.add(runId)
      this.rt.log.append({ type: 'CONFIG_REJECTED', data: { errors: [outcome.error] } })
      await this.rt.notify(`${run.issue}: review refused: ${outcome.error}`, run.issue)
      return
    }
    if (outcome.kind === 'error') {
      await this.flow.workerFailed(runId, outcome.reason, outcome.detail)
      return
    }
    if (outcome.kind === 'unreviewed') {
      const event = this.rt.log.append({
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
      this.flow.forceManual(run.issue, why)
      await this.rt.postOnce(
        run.issue,
        event.id,
        `This change is unreviewed: ${why}. Merge mode for this issue is forced to manual.`,
      )
      await this.reviewPassed(runId, event)
      return
    }
    const { review, model } = outcome
    const event = this.rt.log.append({
      type: 'REVIEW_RECEIVED',
      issue: run.issue,
      run: run.id,
      data: { verdict: review.verdict, model, findings: review.findings },
    })
    await this.rt.postOnce(run.issue, event.id, reviewComment(review, model))
    if (review.verdict === 'pass') {
      await this.reviewPassed(runId, event)
      return
    }
    await this.flow.end(runId, 'failed', event)
    this.flow.releaseLease(run.issue)
    await this.flow.remediate(this.rt.requireRun(runId), 'review_failed', blockerSummary(review))
  }

  async reviewPassed(runId: string, cause: Event): Promise<void> {
    const run = await this.flow.end(runId, 'done', cause)
    this.flow.releaseLease(run.issue)
    const issue = await this.rt.deps.linear.issue(run.issue)
    if (issue) this.flow.observeIssue(issue)
    const view = issue && viewIssue(issue, this.rt.config(), this.flow.viewOptions(issue.identifier))
    if (view?.stage === VERIFICATION) {
      this.rt.log.append({ type: 'STAGE_COMPLETED', issue: run.issue, data: { stage: IMPLEMENTATION } })
    }
    await this.completeStage(run.issue)
  }

  async enterVerification(identifier: string): Promise<void> {
    const issue = this.rt.cache.get(identifier)
    const view = issue && viewIssue(issue, this.rt.config(), this.flow.viewOptions(identifier))
    if (view?.stage !== IMPLEMENTATION) return
    if (nextStage(this.rt.config(), view.pipeline, IMPLEMENTATION) !== VERIFICATION) return
    await this.flow.relabel(identifier, VERIFICATION, IMPLEMENTATION)
  }

  async backToImplementation(identifier: string): Promise<void> {
    if (this.rt.runs.active().some((r) => r.issue === identifier)) return
    const issue = this.rt.cache.get(identifier)
    const stage = issue && viewIssue(issue, this.rt.config(), this.flow.viewOptions(identifier))?.stage
    if (stage !== VERIFICATION && stage !== INTEGRATION) return
    await this.flow.relabel(identifier, IMPLEMENTATION, stage)
  }

  async enterStage(view: IssueView, stage: string, from?: string): Promise<void> {
    const id = view.snapshot.identifier
    this.rt.log.append({ type: 'STAGE_ENTERED', issue: id, data: { stage, ...(from ? { from } : {}) } })
    const hold = this.rt.config().stages[stage]?.human_checkpoint === 'before'
    this.flow.setAwaiting(id, hold ? { kind: 'before', stage } : null)
    await this.flow.writeStatus(id, { stage, ...(hold ? { status: 'blocked' as const } : {}) })
    if (hold)
      await this.rt.notify(`${stage} needs your approval before it starts`, id, {
        kind: 'blocked',
        action: `\`ns resume ${id}\` to start ${stage}`,
      })
  }

  async advance(view: IssueView): Promise<void> {
    const stage = view.stage
    if (stage === null) return
    const id = view.snapshot.identifier
    this.rt.log.append({ type: 'STAGE_COMPLETED', issue: id, data: { stage } })
    const next = nextStage(this.rt.config(), view.pipeline, stage)
    if (next) await this.enterStage(view, next, stage)
    else {
      this.flow.setAwaiting(id, null)
      await this.flow.startIngest(view)
    }
  }
}
