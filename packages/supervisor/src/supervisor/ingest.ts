import { type IssueView, type ViewOptions, viewIssue } from '../policy/stages'
import type { IssueSnapshot, VaultIngest } from '../ports'
import { ControlError } from '../ports/control'
import type { Event } from '../state/events'
import { isTerminal, type Run } from '../state/runs'
import { type FinishLike, INGEST_AGENT, type SupervisorRuntime } from './runtime'

export type IngestPeers = {
  profileFor: (view: IssueView) => string
  end: (runId: string, to: 'done' | 'failed' | 'stopped', cause: Event) => Promise<Run>
  forgetStalls: (runId: string) => void
  observeIssue: (issue: IssueSnapshot) => void
  viewOptions: (issue: string) => ViewOptions
}

export class Ingest {
  private readonly ingesting = new Set<string>()

  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly peers: IngestPeers,
  ) {}

  async startIngest(view: IssueView): Promise<void> {
    const id = view.snapshot.identifier
    if (!this.enabled() || this.ingesting.has(id)) return
    if (this.rt.log.since(null, { issue: id, types: ['VAULT_INGEST_STARTED'] }).length) return
    this.ingesting.add(id)
    try {
      const started = this.rt.log.append({ type: 'VAULT_INGEST_STARTED', issue: id, data: {} })
      await this.launch(view, started, 1, this.rt.log.since(null, { issue: id }))
    } finally {
      this.ingesting.delete(id)
    }
  }

  async retryIngest(identifier: string): Promise<Run> {
    if (!this.enabled()) throw new ControlError('refused', `${identifier}: vault ingest is disabled`)
    const history = this.rt.log.since(null, {
      issue: identifier,
      types: ['VAULT_INGEST_STARTED', 'VAULT_INGEST_FAILED', 'VAULT_INGESTED'],
    })
    const first = history.find((e) => e.type === 'VAULT_INGEST_STARTED')
    if (history.some((e) => e.type === 'VAULT_INGESTED'))
      throw new ControlError('refused', `${identifier}: vault ingest already succeeded`)
    if (
      this.ingesting.has(identifier) ||
      history.at(-1)?.type === 'VAULT_INGEST_STARTED' ||
      this.rt.runs.active().some((r) => r.issue === identifier && r.agent === INGEST_AGENT)
    )
      throw new ControlError('refused', `${identifier}: vault ingest is running`)
    if (!first || history.at(-1)?.type !== 'VAULT_INGEST_FAILED')
      throw new ControlError('refused', `${identifier}: no failed vault ingest to retry`)
    const snapshot = await this.rt.deps.linear.issue(identifier)
    if (!snapshot) throw new ControlError('not_found', `unknown issue ${identifier}`)
    this.peers.observeIssue(snapshot)
    const view = viewIssue(snapshot, this.rt.config(), this.peers.viewOptions(identifier))
    if (!view) throw new ControlError('refused', `${identifier} is not managed by nightshift`)
    if (this.ingesting.has(identifier))
      throw new ControlError('refused', `${identifier}: vault ingest is running`)
    this.ingesting.add(identifier)
    try {
      const attempt = history.filter((e) => e.type === 'VAULT_INGEST_STARTED').length + 1
      const started = this.rt.log.append({
        type: 'VAULT_INGEST_STARTED',
        issue: identifier,
        data: { attempt },
      })
      const events = this.rt.log.since(null, { issue: identifier }).filter((e) => e.id <= first.id)
      const run = await this.launch(view, started, attempt, events, first.ts.slice(0, 10))
      const failed = this.rt.log
        .since(started.id, { issue: identifier, types: ['VAULT_INGEST_FAILED'] })
        .at(-1)
      if (!run || failed)
        throw new ControlError(
          'internal',
          `${identifier}: vault ingest failed: ${String(failed?.data.reason)}`,
        )
      return run
    } finally {
      this.ingesting.delete(identifier)
    }
  }

  private enabled(): boolean {
    return !!this.rt.deps.ingest && this.rt.config().stages.closeout?.ingest !== false
  }

  private async launch(
    view: IssueView,
    started: Event,
    attempt: number,
    events: Event[],
    date = this.rt.now().toISOString().slice(0, 10),
  ): Promise<Run | null> {
    const ingest = this.rt.deps.ingest as VaultIngest
    const id = view.snapshot.identifier
    let prepared: Awaited<ReturnType<VaultIngest['prepare']>>
    try {
      prepared = await ingest.prepare({
        issue: view.snapshot,
        repository: view.repository ?? '',
        date,
        events,
        pr: this.rt.pullRequests.get(id) ?? null,
      })
    } catch (e) {
      await this.ingestFailed(id, `prepare: ${(e as Error).message}`)
      return null
    }
    const profile = this.peers.profileFor(view)
    const run = this.rt.runs.create({
      issue: id,
      agent: INGEST_AGENT,
      profile,
      model: this.rt.deps.modelFor(INGEST_AGENT, profile, this.rt.config()),
      repository: prepared.repository,
      baseSha: prepared.baseSha,
      attempt,
    })
    const starting = this.rt.runs.transition(run.id, 'starting', started)
    try {
      await this.rt.deps.executor.start({
        run: starting,
        issue: view.snapshot,
        files: prepared.files,
        sourceFiles: prepared.sourceFiles,
      })
    } catch (e) {
      await this.ingestRunFailed(run.id, `start: ${(e as Error).message}`)
    }
    return this.rt.requireRun(run.id)
  }

  async ingestFinished(run: Run, event: Event, finish: FinishLike): Promise<void> {
    if (finish.status !== 'DONE' && finish.status !== 'DONE_WITH_CONCERNS') {
      await this.ingestRunFailed(run.id, `${finish.status}: ${finish.blocker?.reason ?? 'no reason'}`, event)
      return
    }
    // Publishing is the ingest gate (vault lints, rebase, push); there is no code review stage.
    this.rt.runs.transition(run.id, 'gating', event)
    let commits: string[]
    try {
      commits = await (this.rt.deps.ingest as VaultIngest).publish(this.rt.requireRun(run.id))
    } catch (e) {
      await this.ingestRunFailed(run.id, `publish: ${(e as Error).message}`, event)
      return
    }
    this.rt.runs.transition(run.id, 'reviewing', event)
    await this.peers.end(run.id, 'done', event)
    this.rt.log.append({ type: 'VAULT_INGESTED', issue: run.issue, data: { commits } })
  }

  async ingestRunFailed(runId: string, reason: string, cause?: Event): Promise<void> {
    const run = this.rt.requireRun(runId)
    if (!isTerminal(run.state)) {
      await this.peers.end(
        runId,
        'failed',
        cause ??
          this.rt.log.append({
            type: 'WORKER_FAILED',
            issue: run.issue,
            run: run.id,
            data: { reason: 'crash', detail: reason },
          }),
      )
    }
    this.peers.forgetStalls(runId)
    await this.ingestFailed(run.issue, reason)
  }

  async ingestFailed(issue: string, reason: string): Promise<void> {
    const last = this.rt.log
      .since(null, { issue, types: ['VAULT_INGEST_STARTED', 'VAULT_INGEST_FAILED', 'VAULT_INGESTED'] })
      .at(-1)
    if (last && last.type !== 'VAULT_INGEST_STARTED') return
    this.rt.log.append({ type: 'VAULT_INGEST_FAILED', issue, data: { reason } })
    await this.rt.notify('Vault ingest failed', issue, { kind: 'info', context: [reason] })
  }
}
