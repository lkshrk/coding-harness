import { INTEGRATION, lifecycleOf, viewIssue } from '../policy/stages'
import type { CiState } from '../ports'
import { CiFailureStore, type PullRequestRecord } from '../stages/integration/records'
import type { RunFlow, SupervisorRuntime } from './runtime'

export class PullRequestWatch {
  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly flow: RunFlow,
  ) {}

  async pullRequestOpened(record: PullRequestRecord, title: string): Promise<void> {
    this.rt.pullRequests.put(record)
    const logged = this.rt.log
      .since(null, { issue: record.issue, types: ['PR_CREATED'] })
      .some((e) => e.data.url === record.url)
    if (!logged) {
      this.rt.log.append({
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
    await this.rt.deps.linear.attachLink(record.issue, record.url, `PR #${record.number}: ${title}`)
    await this.flow.writeStatus(record.issue, { status: 'review' })
    if (!logged) {
      await this.rt.notify(`PR #${record.number} ready for review`, record.issue, {
        kind: 'pr',
        url: record.url,
        context: this.runContext(record.run),
        action: `Review and merge PR #${record.number}${this.forcedManual(record.issue) ? ' (unreviewed, check carefully)' : ''}`,
      })
    }
  }

  async watchPullRequests(): Promise<void> {
    const host = this.rt.deps.gitHost
    if (!host) return
    for (const pr of this.rt.pullRequests.all()) {
      const issue = this.rt.cache.get(pr.issue)
      const lifecycle = issue ? lifecycleOf(this.rt.config(), issue.team, issue.status) : null
      if (lifecycle === 'canceled') {
        this.rt.pullRequests.remove(pr.issue)
        continue
      }
      try {
        const state = await host.state(pr)
        // Linear's GitHub automation can mark the issue Done before nightshift sees the merge.
        if (lifecycle === 'done' && state.state !== 'merged') this.rt.pullRequests.remove(pr.issue)
        else if (state.state === 'merged') await this.pullRequestMerged(pr)
        else if (state.state === 'closed') await this.pullRequestClosed(pr)
        else if (pr.ci === 'pending') await this.checkCi(pr, await host.ci(pr))
      } catch (e) {
        console.error(`watch ${pr.url} (${pr.issue}): ${(e as Error).message}`)
      }
    }
  }

  async checkCi(pr: PullRequestRecord, ci: CiState): Promise<void> {
    if (ci.state === 'pending') return
    this.rt.pullRequests.put({ ...pr, ci: ci.state })
    if (ci.state === 'passed') {
      this.rt.log.append({ type: 'CI_PASSED', issue: pr.issue, run: pr.run, data: { url: ci.url } })
      return
    }
    const event = this.rt.log.append({
      type: 'CI_FAILED',
      issue: pr.issue,
      run: pr.run,
      data: {
        url: ci.url,
        failed_checks: ci.failedChecks,
        failures: ci.failures.map((f) => ({ name: f.name, url: f.url })),
      },
    })
    if (ci.failures.some((f) => f.log !== '')) new CiFailureStore(this.rt.deps.db).put(pr.run, ci.failures)
    const checks = ci.failedChecks.length ? ci.failedChecks.join(', ') : 'unknown checks'
    await this.rt.postOnce(pr.issue, event.id, `CI failed on ${pr.url}: ${checks}.`)
    await this.rt.notify(`CI failed on PR #${pr.number}`, pr.issue, {
      kind: 'ci',
      url: pr.url,
      context: [`failed checks: ${checks}`],
      action: 'nightshift attempts a repair; check the PR if it fails again',
    })
    const run = this.rt.runs.get(pr.run)
    if (run) await this.flow.remediate(run, 'ci_failed', `failed checks: ${checks}`)
    await this.flow.refresh(pr.issue)
  }

  async pullRequestMerged(pr: PullRequestRecord): Promise<void> {
    this.rt.log.append({
      type: 'MERGED',
      issue: pr.issue,
      run: pr.run,
      data: { url: pr.url, branch: pr.branch, account: pr.account, mode: pr.mode },
    })
    this.rt.pullRequests.remove(pr.issue)
    const issue = await this.rt.deps.linear.issue(pr.issue)
    const stage = issue && viewIssue(issue, this.rt.config(), this.flow.viewOptions(pr.issue))?.stage
    if (stage === INTEGRATION) await this.flow.completeStage(pr.issue)
    else this.rt.log.append({ type: 'STAGE_COMPLETED', issue: pr.issue, data: { stage: INTEGRATION } })
    if (this.flow.awaiting(pr.issue)?.kind !== 'after')
      await this.flow.writeStatus(pr.issue, { status: 'done' })
    const dependents = [...this.rt.cache.values()].filter((i) =>
      i.blockedBy.some((b) => b.identifier === pr.issue),
    )
    for (const id of [pr.issue, ...dependents.map((i) => i.identifier)]) await this.flow.refresh(id)
  }

  async pullRequestClosed(pr: PullRequestRecord): Promise<void> {
    this.rt.pullRequests.remove(pr.issue)
    await this.flow.holdForYou(pr.issue, { kind: 'escalated', stage: INTEGRATION })
    await this.rt.postOnce(
      pr.issue,
      `pr-closed-${pr.number}`,
      `Pull request ${pr.url} was closed without merging. nightshift waits for you: move the issue to ready to push and open a new pull request.`,
    )
    await this.rt.notify(`PR #${pr.number} closed without merge`, pr.issue, {
      kind: 'blocked',
      url: pr.url,
      action: 'Reopen the PR, move the issue to Todo for a new attempt, or cancel it in Linear',
    })
    await this.flow.refresh(pr.issue)
  }

  forcedManual(issue: string): string | null {
    return this.rt.metaMap<string>('forced_manual')[issue] ?? null
  }

  forceManual(issue: string, why: string): void {
    const map = this.rt.metaMap<string>('forced_manual')
    map[issue] = why
    this.rt.setMeta('forced_manual', JSON.stringify(map))
  }

  runContext(runId: string): string[] {
    const run = this.rt.runs.get(runId)
    const finish = (run?.finish ?? {}) as { summary?: string; concerns?: string[] }
    const gates = this.rt.log.since(null, { run: runId, types: ['GATE_PASSED', 'GATE_FAILED'] })
    const review = this.rt.log.since(null, { run: runId, types: ['REVIEW_RECEIVED'] }).at(-1)
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
}
