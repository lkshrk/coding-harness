import { LABEL_GROUPS, teamStatuses } from '@nightshift/core'
import { lifecycleOf, type ViewOptions, viewIssue } from '../policy/stages'
import { type Intent, transition } from '../policy/transition'
import type { Awaiting, IssueSnapshot } from '../ports'
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
  private readonly ownWrites = new Map<string, { status: string; previous: string; before: string }>()
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
    const own = this.ownWrites.get(issue.identifier)
    // A read that still carries the pre-write updatedAt is Linear lagging our own write, not a change.
    if (own && issue.updatedAt === own.before && issue.status === own.previous) {
      this.rt.cache.set(issue.identifier, { ...issue, status: own.status })
      return
    }
    this.ownWrites.delete(issue.identifier)
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
    const next = transition(view, intent, { config: cfg })
    if (next.awaiting !== undefined) this.peers.setAwaiting(identifier, next.awaiting)
    if (next.status === undefined && next.stage === undefined) return
    await this.rt.deps.linear.update(identifier, {
      ...(next.status !== undefined ? { status: next.status } : {}),
      ...(next.stage !== undefined ? { stage: next.stage } : {}),
    })
    const prefix = `${LABEL_GROUPS.stage}:`
    const labels =
      next.stage === undefined
        ? issue.labels
        : [...issue.labels.filter((l) => !l.startsWith(prefix)), `${prefix}${next.stage}`]
    const status = next.status === undefined ? issue.status : teamStatuses(cfg, issue.team)[next.status]
    if (next.status !== undefined)
      this.ownWrites.set(identifier, { status, previous: issue.status, before: issue.updatedAt })
    this.rt.cache.set(identifier, { ...issue, status, labels })
  }

  async enforceLinear(): Promise<string[]> {
    const stopped: string[] = []
    for (const run of this.rt.runs.active()) {
      const issue = this.rt.cache.get(run.issue)
      if (!issue || run.agent === INGEST_AGENT) continue
      const view = viewIssue(issue, this.rt.config(), this.peers.viewOptions(issue.identifier))
      if (view?.lifecycle === 'running') continue
      await this.peers.stopRun(run.id, 'issue changed in Linear')
      stopped.push(run.issue)
    }
    return stopped
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
