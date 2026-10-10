import type { RetryQueue } from '../policy/retry'
import { viewIssue } from '../policy/stages'
import type { Classification, Classifier } from '../ports'
import type { Run } from '../state/runs'
import type { RunFlow, SupervisorRuntime } from './runtime'

const ENVIRONMENT_STREAK_PAUSE = 3
const ENVIRONMENT_REASONS = ['sandbox_error', 'gateway_error', 'supervisor_restart']
const CHECKED_REASONS = ['gate_failed', 'review_failed', 'ci_failed', 'review_comments']

const TASK_TOO_LARGE_CLASS: Classification = { class: 'task_too_large', action: 'split' }
// Conflicts between a continued attempt and the moved base are resolved by the user, not retried.
const baseConflictClass = (detail?: string): Classification => ({
  class: 'unknown',
  action: 'escalate_user',
  ...(detail ? { evidence: detail } : {}),
})

export const fallbackClassifier: Classifier = {
  async classify(f) {
    if (ENVIRONMENT_REASONS.includes(f.reason)) return { class: 'environment', action: 'retry_same' }
    if (CHECKED_REASONS.includes(f.reason))
      return { class: 'implementation_defect', action: 'retry_same', evidence: f.detail ?? f.reason }
    return { class: 'unknown', action: 'escalate_user', fallback: true }
  },
}

export class Remediation {
  private environmentStreak = 0

  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly retry: RetryQueue,
    private readonly flow: RunFlow,
  ) {}

  resetStreak(): void {
    this.environmentStreak = 0
  }

  async remediate(run: Run, reason: string, detail?: string): Promise<void> {
    await this.flow.backToImplementation(run.issue)
    const classifier =
      CHECKED_REASONS.includes(reason) || ENVIRONMENT_REASONS.includes(reason)
        ? fallbackClassifier
        : (this.rt.deps.classifier ?? fallbackClassifier)
    const c =
      reason === 'task_too_large'
        ? TASK_TOO_LARGE_CLASS
        : reason === 'base_conflict'
          ? baseConflictClass(detail)
          : await classifier.classify({ run, reason, ...(detail ? { detail } : {}) })
    this.rt.runs.update(run.id, { failure: c.class })
    const escalate =
      c.class !== 'environment' &&
      this.escalationCount(run.issue) >= this.rt.config().limits.repair_rounds + 2
    const action = escalate ? 'escalate_user' : c.action
    const event = this.rt.log.append({
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
    await this.rt.postOnce(
      run.issue,
      event.id,
      `Attempt ${run.attempt} (${run.agent}) failed: ${reason}${detail ? ` (${detail})` : ''}. Class \`${c.class}\`, action \`${action}\`.`,
    )
    this.environmentStreak = c.class === 'environment' ? this.environmentStreak + 1 : 0

    if (action === 'retry_same') {
      this.retry.schedule(run.issue, c.class, this.rt.now().getTime())
      await this.flow.applyIntent(run.issue, { kind: 'retryScheduled' })
    } else if (action === 'pause_dispatch') {
      this.flow.pause(`failure ${c.class} on ${run.issue}`, 'supervisor')
      await this.rt.notify(`dispatch paused after a ${c.class} failure`, run.issue, {
        kind: 'paused',
        context: this.failureContext(run),
        action: 'Fix the cause, then `ns resume`',
      })
    } else if (action === 'escalate_user') {
      await this.escalateUser(run, c)
    } else if ((await this.rt.deps.remediation?.handle(run, { ...c, action })) !== 'handled') {
      await this.escalateUser(run, c)
    }

    if (this.environmentStreak >= ENVIRONMENT_STREAK_PAUSE && !this.flow.paused()) {
      const why = `${ENVIRONMENT_STREAK_PAUSE} environment failures in a row`
      this.flow.pause(why, 'supervisor')
      await this.rt.notify(`dispatch paused: ${why}`, undefined, {
        kind: 'paused',
        context: [`last: ${run.issue}: ${this.failureContext(run).join('; ')}`],
        action: 'Check the gateway, Docker and the host, then `ns resume`',
      })
    }
  }

  async escalateUser(run: Run, c: Classification): Promise<void> {
    const issue = this.rt.cache.get(run.issue)
    await this.flow.holdForYou(run.issue, {
      kind: 'escalated',
      stage: (issue && viewIssue(issue, this.rt.config())?.stage) ?? '',
    })
    await this.rt.notify(`run failed and needs you (${c.class})`, run.issue, {
      kind: 'failed',
      context: this.failureContext(run),
      action: `Clarify the issue or answer in Linear, then \`ns retry ${run.issue}\``,
    })
  }

  escalationCount(issue: string): number {
    return this.rt.runs.forIssue(issue).filter((r) => r.failure !== null && r.failure !== 'environment')
      .length
  }

  failureContext(run: Run): string[] {
    const failed = this.rt.log.since(null, { run: run.id, types: ['WORKER_FAILED'] }).at(-1)
    const data = (failed?.data ?? {}) as { reason?: string; detail?: string }
    return [
      `${run.agent}, attempt ${run.attempt}`,
      data.reason ? `${data.reason}${data.detail ? `: ${data.detail.split('\n')[0]}` : ''}` : '',
    ]
  }
}
