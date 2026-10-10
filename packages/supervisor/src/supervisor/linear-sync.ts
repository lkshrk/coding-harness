import { LABEL_GROUPS, teamStatuses } from '@nightshift/core'
import { labelValue, lifecycleOf, type ViewOptions, viewIssue } from '../policy/stages'
import { humanOutcome, type Intent, transition } from '../policy/transition'
import type { Awaiting, IssueSnapshot } from '../ports'
import { isTerminal, type Run } from '../state/runs'
import type { Waiting } from '../state/status'
import { INGEST_AGENT, type SupervisorRuntime } from './runtime'

export type LinearSyncPeers = {
  coveredSet: () => Set<string>
  uncover: (issue: string) => void
  viewOptions: (issue: string) => ViewOptions
  setAwaiting: (issue: string, value: Awaiting | null) => void
  stopRun: (runId: string, reason: string) => Promise<void>
}

export class LinearSync {
  private cursor: string | undefined

  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly peers: LinearSyncPeers,
  ) {}

  async sync(): Promise<void> {
    const issues = await this.rt.deps.linear.issues(
      this.cursor === undefined ? {} : { updatedSince: this.cursor },
    )
    const seen = new Set<string>()
    for (const issue of issues) {
      seen.add(issue.identifier)
      this.observeIssue(issue)
      if (this.cursor === undefined || issue.updatedAt > this.cursor) this.cursor = issue.updatedAt
    }
    // Covered and running issues may fall outside the opt-in query; re-read them so coverage and stops apply.
    const watched = [
      ...this.rt.runs.active().map((r) => r.issue),
      ...this.peers.coveredSet(),
      ...this.rt.pullRequests.all().map((p) => p.issue),
    ]
    for (const id of new Set(watched)) {
      if (seen.has(id)) continue
      const issue = await this.rt.deps.linear.issue(id)
      if (issue) this.observeIssue(issue)
    }
  }

  async refresh(identifier: string): Promise<void> {
    const issue = await this.rt.deps.linear.issue(identifier)
    if (issue) this.observeIssue(issue)
  }

  observeIssue(issue: IssueSnapshot): void {
    this.rt.cache.set(issue.identifier, issue)
    const lifecycle = lifecycleOf(this.rt.config(), issue.team, issue.status)
    if (lifecycle === 'done' || lifecycle === 'canceled') this.peers.uncover(issue.identifier)
  }

  // The only writer of an issue's status, stage label and hold.
  async applyIntent(identifier: string, intent: Intent): Promise<void> {
    if (intent.kind === 'stageEntered') {
      const data = { stage: intent.stage, ...(intent.from ? { from: intent.from } : {}) }
      this.rt.log.append({ type: 'STAGE_ENTERED', issue: identifier, data })
    }
    if (!this.rt.cache.has(identifier)) await this.refresh(identifier)
    const issue = this.rt.cache.get(identifier)
    if (!issue) return
    const cfg = this.rt.config()
    const view = viewIssue(issue, cfg, { ...this.peers.viewOptions(identifier), covered: true })
    if (!view) return
    // An operator change is judged against the running state the supervisor holds, not the new status.
    const human = intent.kind === 'humanChanged'
    const transitioned = transition(human ? { ...view, lifecycle: 'running' } : view, intent, { config: cfg })
    const next =
      human && transitioned.status === view.lifecycle ? { ...transitioned, status: undefined } : transitioned
    if (next.awaiting !== undefined) this.peers.setAwaiting(identifier, next.awaiting)
    if (next.status !== undefined || next.stage !== undefined)
      await this.rt.deps.linear.update(identifier, {
        ...(next.status !== undefined ? { status: next.status } : {}),
        ...(next.stage !== undefined ? { stage: next.stage } : {}),
      })
    if (next.runAction === 'stop' || next.runAction === 'stopKeepWip')
      for (const run of this.rt.runs.active())
        if (run.issue === identifier && run.agent !== INGEST_AGENT) await this.peers.stopRun(run.id, next.log)
    if (next.status === undefined && next.stage === undefined) return
    const prefix = `${LABEL_GROUPS.stage}:`
    const labels =
      next.stage === undefined
        ? issue.labels
        : [...issue.labels.filter((l) => !l.startsWith(prefix)), `${prefix}${next.stage}`]
    const status = next.status === undefined ? issue.status : teamStatuses(cfg, issue.team)[next.status]
    this.rt.cache.set(identifier, { ...issue, status, labels })
  }

  async enforceLinear(): Promise<string[]> {
    const stopped: string[] = []
    for (const run of this.rt.runs.active()) {
      const issue = this.rt.cache.get(run.issue)
      if (!issue || run.agent === INGEST_AGENT) continue
      const view = viewIssue(issue, this.rt.config(), this.peers.viewOptions(issue.identifier))
      if (view?.lifecycle === 'running') continue
      if (await this.resolveMismatch(run, issue)) stopped.push(run.issue)
    }
    return stopped
  }

  // A live run whose issue is no longer running in Linear: an operator change wins, our own is
  // re-asserted. Returns whether the run was stopped.
  async resolveMismatch(run: Run, issue: IssueSnapshot): Promise<boolean> {
    const cfg = this.rt.config()
    const id = issue.identifier
    const view = viewIssue(issue, cfg, this.peers.viewOptions(id))
    const lifecycle = view?.lifecycle ?? null
    const change = await this.rt.deps.linear.lastChange(id)
    const human = change !== null && !change.app
    // A status that still maps to running with no view means the opt-in or coverage was withdrawn,
    // not a status mismatch. Otherwise the actor decides first: our own status change is re-asserted
    // even when the issue has no view.
    const withdrawn = !view && lifecycleOf(cfg, issue.team, issue.status) === 'running'
    const action = withdrawn
      ? 'stop'
      : !human
        ? 'reassert'
        : lifecycle === null
          ? 'stop'
          : humanOutcome[lifecycle]
    const stage = labelValue(issue.labels, LABEL_GROUPS.stage)
    this.rt.log.append({
      type: 'MISMATCH_RESOLVED',
      issue: id,
      run: run.id,
      data: {
        linear: { status: issue.status, stage },
        expected: { status: teamStatuses(cfg, issue.team).running, stage },
        actor: change?.actor ?? 'unknown',
        app: change?.app ?? false,
        action,
      },
    })
    if (action === 'stop') await this.peers.stopRun(run.id, 'issue changed in Linear')
    else if (action === 'reassert') await this.applyIntent(id, { kind: 'dispatched' })
    else if (lifecycle !== null) await this.applyIntent(id, { kind: 'humanChanged', to: lifecycle })
    return isTerminal(this.rt.requireRun(run.id).state)
  }

  snapshotIssues(waiting: Waiting[]): void {
    const cfg = this.rt.config()
    const db = this.rt.deps.db
    const reasons = new Map(waiting.map((w) => [w.identifier, w.reason]))
    const insert = db.query(
      `INSERT INTO issues (identifier, title, project, stage, lifecycle, status, blockers, waiting, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    db.transaction(() => {
      db.query('DELETE FROM issues').run()
      for (const issue of this.rt.cache.values()) {
        const view = viewIssue(issue, cfg, this.peers.viewOptions(issue.identifier))
        if (!view) continue
        const blockers = issue.blockedBy
          .filter((b) => {
            const state = lifecycleOf(cfg, b.team, b.status)
            return state !== 'done' && state !== 'canceled'
          })
          .map((b) => b.identifier)
        const awaiting = view.awaiting ? `awaiting you (${view.awaiting.kind} ${view.awaiting.stage})` : null
        insert.run(
          issue.identifier,
          issue.title,
          issue.project?.name ?? null,
          view.stage,
          view.lifecycle,
          issue.status,
          JSON.stringify(blockers),
          reasons.get(issue.identifier) ?? awaiting,
          issue.updatedAt,
        )
      }
    })()
  }
}
