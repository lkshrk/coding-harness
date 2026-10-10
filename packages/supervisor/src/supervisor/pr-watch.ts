import { INTEGRATION, lifecycleOf, viewIssue } from '../policy/stages'
import type { CiState, GitHost, ReviewThread } from '../ports'
import { CiFailureStore, type PullRequestRecord, ReviewRoundStore } from '../stages/integration/records'
import type { RunFlow, SupervisorRuntime } from './runtime'

type ThreadOutcome = { id: string; outcome: 'addressed' | 'disputed'; reason: string }

const newestComment = (t: ReviewThread): number => Math.max(0, ...t.comments.map((c) => c.id))

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
    if (!this.rt.runs.active().some((r) => r.issue === record.issue))
      await this.flow.applyIntent(record.issue, { kind: 'prOpened' })
    await this.closeReviewRound(record)
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
        else {
          if (pr.ci === 'pending') await this.checkCi(pr, await host.ci(pr))
          await this.checkReviews(pr, host)
        }
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

  async checkReviews(pr: PullRequestRecord, host: GitHost): Promise<void> {
    const store = new ReviewRoundStore(this.rt.deps.db)
    const round = store.get(pr.issue)
    if (round.pending || this.rt.runs.active().some((r) => r.issue === pr.issue)) return
    // A CI repair is already under way; its push resets ci to pending and the threads follow.
    if (this.rt.pullRequests.get(pr.issue)?.ci === 'failed') return
    const open = (await host.reviewThreads(pr)).filter((t) => !t.resolved && !t.outdated)
    const fresh = open.filter((t) => newestComment(t) > round.seen)
    if (!fresh.length) return
    const run = this.rt.runs.get(pr.run)
    if (!run) return
    store.put(pr.issue, {
      seen: Math.max(round.seen, ...open.map(newestComment)),
      pending: { run: run.id, threads: fresh },
    })
    await this.flow.remediate(
      run,
      'review_comments',
      `${fresh.length} unresolved review thread${fresh.length === 1 ? '' : 's'} on ${pr.url}`,
    )
    await this.flow.refresh(pr.issue)
  }

  // After the repair is pushed: reply to and resolve addressed threads, reply to disputed ones.
  async closeReviewRound(record: PullRequestRecord): Promise<void> {
    const host = this.rt.deps.gitHost
    const store = new ReviewRoundStore(this.rt.deps.db)
    const round = store.get(record.issue)
    if (!host || !round.pending) return
    const from = this.rt.runs.get(round.pending.run)
    const repair = this.rt.runs
      .forIssue(record.issue)
      .filter((r) => r.state === 'done' && r.attempt > (from?.attempt ?? 0))
      .at(-1)
    if (!repair) return
    // Only a commit the repair pushed can carry a fix; otherwise nothing is resolved.
    const pushed = repair.headSha === record.headSha && record.headSha !== from?.headSha
    const finish = (repair.finish ?? {}) as { report?: { threads?: ThreadOutcome[] } }
    const outcomes = new Map((finish.report?.threads ?? []).map((t) => [t.id, t]))
    let seen = round.seen
    const open: string[] = []
    for (const thread of round.pending.threads) {
      const outcome = outcomes.get(thread.id)
      const last = thread.comments.at(-1)
      if (!outcome || !last) {
        open.push(`${thread.path}: no outcome reported`)
        continue
      }
      const fixed = outcome.outcome === 'addressed' && pushed
      if (outcome.outcome === 'addressed' && !pushed) {
        open.push(`${thread.path}: reported addressed, but no new commit was pushed`)
        continue
      }
      const body = fixed ? `Fixed in ${record.headSha}. ${outcome.reason}` : `Not changed: ${outcome.reason}`
      const reply = await host.replyToThread(record, last.id, body)
      seen = Math.max(seen, reply.id)
      if (fixed) await host.resolveThread(record, thread.id)
      else open.push(`${thread.path}: ${outcome.reason}`)
    }
    store.put(record.issue, { seen })
    if (!open.length) return
    await this.rt.postOnce(
      record.issue,
      `review-threads-${record.run}`,
      `Review threads on ${record.url} left open for you:\n${open.map((o) => `- ${o}`).join('\n')}`,
    )
    await this.flow.holdForYou(record.issue, {
      kind: 'escalated',
      stage: INTEGRATION,
      reason: 'review_disputed',
    })
    await this.rt.notify(`review threads left open on PR #${record.number}`, record.issue, {
      kind: 'blocked',
      url: record.url,
      context: open,
      action: 'Answer the open review threads, then merge or retry',
    })
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
    await this.flow.applyIntent(pr.issue, { kind: 'merged' })
    const dependents = [...this.rt.cache.values()].filter((i) =>
      i.blockedBy.some((b) => b.identifier === pr.issue),
    )
    for (const id of [pr.issue, ...dependents.map((i) => i.identifier)]) await this.flow.refresh(id)
  }

  async pullRequestClosed(pr: PullRequestRecord): Promise<void> {
    this.rt.pullRequests.remove(pr.issue)
    await this.flow.applyIntent(pr.issue, { kind: 'prClosed' })
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
