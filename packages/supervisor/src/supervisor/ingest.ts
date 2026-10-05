import type { IssueView } from '../policy/stages'
import type { VaultIngest } from '../ports'
import type { Event } from '../state/events'
import { isTerminal, type Run } from '../state/runs'
import { type FinishLike, INGEST_AGENT, type SupervisorRuntime } from './runtime'

export type IngestPeers = {
  profileFor: (view: IssueView) => string
  end: (runId: string, to: 'done' | 'failed' | 'stopped', cause: Event) => Promise<Run>
  forgetStalls: (runId: string) => void
}

export class Ingest {
  private readonly ingesting = new Set<string>()

  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly peers: IngestPeers,
  ) {}

  async startIngest(view: IssueView): Promise<void> {
    const ingest = this.rt.deps.ingest
    const cfg = this.rt.config()
    const id = view.snapshot.identifier
    if (!ingest || cfg.stages.closeout?.ingest === false || this.ingesting.has(id)) return
    if (this.rt.log.since(null, { issue: id, types: ['VAULT_INGEST_STARTED'] }).length) return
    this.ingesting.add(id)
    try {
      const started = this.rt.log.append({ type: 'VAULT_INGEST_STARTED', issue: id, data: {} })
      let prepared: Awaited<ReturnType<VaultIngest['prepare']>>
      try {
        prepared = await ingest.prepare({
          issue: view.snapshot,
          repository: view.repository ?? '',
          date: this.rt.now().toISOString().slice(0, 10),
          events: this.rt.log.since(null, { issue: id }),
          pr: this.rt.pullRequests.get(id) ?? null,
        })
      } catch (e) {
        await this.ingestFailed(id, `prepare: ${(e as Error).message}`)
        return
      }
      const profile = this.peers.profileFor(view)
      const run = this.rt.runs.create({
        issue: id,
        agent: INGEST_AGENT,
        profile,
        model: this.rt.deps.modelFor(INGEST_AGENT, profile, this.rt.config()),
        repository: prepared.repository,
        baseSha: prepared.baseSha,
        attempt: 1,
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
    } finally {
      this.ingesting.delete(id)
    }
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
    if (this.rt.log.since(null, { issue, types: ['VAULT_INGEST_FAILED', 'VAULT_INGESTED'] }).length) return
    this.rt.log.append({ type: 'VAULT_INGEST_FAILED', issue, data: { reason } })
    await this.rt.notify('Vault ingest failed', issue, { kind: 'info', context: [reason] })
  }
}
