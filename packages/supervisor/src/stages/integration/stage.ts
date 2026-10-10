import { homedir } from 'node:os'
import { type Config, expandHome } from '@nightshift/core'
import { BRANCH_PREFIX, runRef } from '../../policy/naming'
import { INTEGRATION, lifecycleOf, viewIssue } from '../../policy/stages'
import type { GitHost, StageHandler, StageWork } from '../../ports'
import type { EventLog } from '../../state/events'
import { isTerminal, type Run, type RunStore } from '../../state/runs'
import type { GateEventData } from '../gates/report'
import type { ReviewFinding } from '../gates/review'
import { pullRequestBody, pullRequestTitle } from './body'
import type { PullRequestRecord, PullRequestStore } from './records'

export interface IntegrationCallbacks {
  readonly runs: Pick<RunStore, 'forIssue'>
  readonly log: Pick<EventLog, 'since'>
  readonly pullRequests: Pick<PullRequestStore, 'get'>
  forcedManual(issue: string): string | null
  gateResults(runId: string): GateEventData[]
  pullRequestOpened(record: PullRequestRecord, title: string): Promise<void>
}

export type IntegrationDeps = {
  config: () => Config
  host: GitHost
  callbacks: () => IntegrationCallbacks
  home?: string
  out?: (line: string) => void
}

export function prBranch(identifier: string): string {
  return `${BRANCH_PREFIX}${identifier}`
}

export function changedFiles(checkout: string, base: string, head: string): string[] {
  const r = Bun.spawnSync(['git', '-C', checkout, 'diff', '--name-only', '--no-renames', base, head], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  if (r.exitCode !== 0) throw new Error(`git diff ${base} ${head}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString().split('\n').filter(Boolean)
}

export function headSubject(checkout: string, head: string): string {
  const r = Bun.spawnSync(['git', '-C', checkout, 'log', '-1', '--format=%s', head], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  if (r.exitCode !== 0) throw new Error(`git log ${head}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString().trim()
}

export function riskPathsTouched(files: readonly string[], patterns: readonly string[]): string[] {
  const globs = patterns.map((p) => new Bun.Glob(p))
  return files.filter((f) => globs.some((g) => g.match(f)))
}

export class IntegrationHandler implements StageHandler {
  constructor(private readonly d: IntegrationDeps) {}

  async run(work: StageWork): Promise<void> {
    if (work.stage !== INTEGRATION) return
    const id = work.issue.identifier
    const cb = this.d.callbacks()
    const config = this.d.config()
    const runs = cb.runs.forIssue(id)
    if (runs.some((r) => !isTerminal(r.state))) {
      this.d.out?.(`${id}: a run is active; integration waits for it`)
      return
    }
    const run = runs.filter((r) => r.state === 'done' && r.headSha !== null).at(-1)
    if (!run?.headSha) {
      this.d.out?.(`${id}: integration has no finished run to push`)
      return
    }
    const title = pullRequestTitle(work.issue)
    const existing = cb.pullRequests.get(id)
    if (existing && existing.headSha === run.headSha) {
      if (lifecycleOf(config, work.issue.team, work.issue.status) !== 'review')
        await cb.pullRequestOpened(existing, title)
      return
    }
    const repo = config.repositories[run.repository]
    if (!repo) throw new Error(`no repository '${run.repository}'`)
    const checkout = expandHome(repo.path, this.d.home ?? homedir())
    if (headSubject(checkout, run.headSha).startsWith('wip:'))
      throw new Error(
        `${id}: head commit is a WIP commit (${run.headSha.slice(0, 12)}); refusing to open a PR`,
      )
    const risk = riskPathsTouched(
      changedFiles(checkout, run.baseSha || `${run.headSha}^`, run.headSha),
      repo.risk_paths,
    )
    const requested = viewIssue(work.issue, config, { covered: true })?.mergeMode ?? 'manual'
    if (requested !== 'manual')
      this.d.out?.(`${id}: merge mode ${requested} is not supported yet; using manual`)
    const branch = prBranch(id)
    const { headSha } = await this.d.host.push({ repository: run.repository, source: runRef(run.id), branch })
    const body = this.body(work, run, cb, risk, config)
    const pr = await this.d.host.openPullRequest({
      repository: run.repository,
      branch,
      base: repo.base,
      title,
      body,
      draft: risk.length > 0,
    })
    await cb.pullRequestOpened(
      {
        ...pr,
        issue: id,
        run: run.id,
        headSha,
        title,
        body,
        mode: 'manual',
        draft: risk.length > 0,
        ci: 'pending',
      },
      title,
    )
  }

  private body(work: StageWork, run: Run, cb: IntegrationCallbacks, risk: string[], config: Config): string {
    const review = cb.log.since(null, { run: run.id, types: ['REVIEW_RECEIVED'] }).at(-1)?.data as
      | { verdict: 'pass' | 'fail'; findings: ReviewFinding[] }
      | undefined
    const phoenix = config.gateway.phoenix_url
    return pullRequestBody({
      issue: work.issue,
      runId: run.id,
      finish: (run.finish ?? null) as { summary?: string; concerns?: string[] } | null,
      gates: cb.gateResults(run.id),
      review: review ?? null,
      unreviewed: review ? null : cb.forcedManual(work.issue.identifier),
      riskPaths: risk,
      ...(phoenix ? { traceUrl: phoenix } : {}),
    })
  }
}
