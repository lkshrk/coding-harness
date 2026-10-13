import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Config, expandHome } from '@nightshift/core'
import { BRANCH_PREFIX, runRef } from '../../policy/naming'
import { INTEGRATION, lifecycleOf, viewIssue } from '../../policy/stages'
import type { GitHost, StageHandler, StageWork } from '../../ports'
import { PushRejectedError } from '../../ports/git-host'
import type { EventLog } from '../../state/events'
import { isTerminal, type Run, type RunStore } from '../../state/runs'
import type { GateEventData } from '../gates/report'
import type { ReviewFinding } from '../gates/review'
import { type AttemptFinish, type AttemptSummary, pullRequestBody, pullRequestTitle } from './body'
import type { PullRequestRecord, PullRequestStore } from './records'
import { captureScreenshots, type ScreenshotDeps, type ScreenshotOutcome } from './screenshots'

export interface IntegrationCallbacks {
  readonly runs: Pick<RunStore, 'forIssue'>
  readonly log: Pick<EventLog, 'since'>
  readonly pullRequests: Pick<PullRequestStore, 'get'>
  forcedManual(issue: string): string | null
  continuedFrom(run: Run): string | undefined
  gateResults(runId: string): GateEventData[]
  pullRequestOpened(record: PullRequestRecord, title: string): Promise<void>
  holdStage(identifier: string, stage: string, reason: string, comment: string): Promise<void>
}

export type IntegrationDeps = {
  config: () => Config
  host: GitHost
  callbacks: () => IntegrationCallbacks
  screenshots?: ScreenshotDeps
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

function isAncestor(checkout: string, ancestor: string, head: string): boolean {
  const r = Bun.spawnSync(['git', '-C', checkout, 'merge-base', '--is-ancestor', ancestor, head], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  })
  return r.exitCode === 0
}

export function riskPathsTouched(files: readonly string[], patterns: readonly string[]): string[] {
  const globs = patterns.map((p) => new Bun.Glob(p))
  return files.filter((f) => globs.some((g) => g.match(f)))
}

const finishOf = (run: Run): AttemptFinish => (run.finish ?? null) as AttemptFinish

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
    // The merge queue may have rebased this run's head on the host; pushing it again would undo that.
    if (existing && (existing.headSha === run.headSha || existing.run === run.id)) {
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
    const base = run.baseSha || `${run.headSha}^`
    const changed = changedFiles(checkout, base, run.headSha)
    const risk = riskPathsTouched(changed, repo.risk_paths)
    const ui = riskPathsTouched(changed, repo.ui_paths ?? [])
    const requested = viewIssue(work.issue, config, { covered: true })?.mergeMode ?? 'manual'
    const unreviewed = cb.forcedManual(id) !== null
    const override = risk.length ? `risk paths: ${risk.join(', ')}` : unreviewed ? 'unreviewed' : null
    let mode: 'auto' | 'manual' = requested === 'auto' && override === null ? 'auto' : 'manual'
    if (requested === 'auto' && override)
      this.d.out?.(`${id}: merge mode auto overridden (${override}); using manual`)
    else if (requested === 'feature-branch')
      this.d.out?.(`${id}: merge mode ${requested} is not supported yet; using manual`)
    const branch = prBranch(id)
    const expected = existing ? (cb.continuedFrom(run) ?? existing.headSha) : undefined
    let headSha: string
    try {
      ;({ headSha } = await this.d.host.push({
        repository: run.repository,
        source: runRef(run.id),
        branch,
        ...(expected ? { expected } : {}),
      }))
    } catch (e) {
      if (!(e instanceof PushRejectedError)) throw e
      await cb.holdStage(
        id,
        INTEGRATION,
        'push_rejected',
        `Nightshift did not push to \`${e.branch}\`: the attempt continued from \`${e.expected}\`, but the branch is now at \`${e.actual || '(deleted)'}\`. The remote commit is kept. Bring the change into the branch by hand, or retry ${id} to continue from the new head.`,
      )
      return
    }
    const attempts = runs
      .filter((r) => r.attempt <= run.attempt && r.headSha)
      .filter((r) => r.id === run.id || isAncestor(checkout, r.headSha as string, run.headSha as string))
      .map((r) => ({ attempt: r.attempt, headSha: r.headSha as string, finish: finishOf(r) }))
    let shots: ScreenshotOutcome | undefined
    if (ui.length > 0)
      shots = this.d.screenshots
        ? await captureScreenshots(this.d.screenshots, {
            issue: id,
            run: run.id,
            repository: run.repository,
            gitDir: join(checkout, '.git'),
            base,
            head: run.headSha,
            config: repo.screenshots,
          })
        : { reason: 'screenshots are not available in this supervisor' }
    if (shots && 'reason' in shots) this.d.out?.(`${id}: no screenshots: ${shots.reason}`)
    const draft = risk.length > 0 || (shots !== undefined && 'reason' in shots)
    if (draft && mode === 'auto') {
      mode = 'manual'
      this.d.out?.(`${id}: merge mode auto overridden (no screenshots); using manual`)
    }
    const body = this.body(work, run, cb, risk, config, attempts, shots)
    const pr = await this.d.host.openPullRequest({
      repository: run.repository,
      branch,
      base: repo.base,
      title,
      body,
      draft,
    })
    await cb.pullRequestOpened(
      {
        ...pr,
        issue: id,
        run: run.id,
        headSha,
        title,
        body,
        mode,
        draft,
        ci: 'pending',
      },
      title,
    )
  }

  private body(
    work: StageWork,
    run: Run,
    cb: IntegrationCallbacks,
    risk: string[],
    config: Config,
    attempts: AttemptSummary[],
    screenshots: ScreenshotOutcome | undefined,
  ): string {
    const review = cb.log.since(null, { run: run.id, types: ['REVIEW_RECEIVED'] }).at(-1)?.data as
      | { verdict: 'pass' | 'fail'; findings: ReviewFinding[] }
      | undefined
    const phoenix = config.gateway.phoenix_url
    return pullRequestBody({
      issue: work.issue,
      runId: run.id,
      finish: finishOf(run),
      attempts,
      gates: cb.gateResults(run.id),
      review: review ?? null,
      unreviewed: review ? null : cb.forcedManual(work.issue.identifier),
      riskPaths: risk,
      ...(screenshots ? { screenshots } : {}),
      ...(phoenix ? { traceUrl: phoenix } : {}),
    })
  }
}
