import type { Config } from '@nightshift/core'
import type { AgentKind } from '../policy/stages'
import type {
  Classifier,
  GitHost,
  IssueSnapshot,
  LinearComment,
  LinearPort,
  Notification,
  Notifier,
  OutboxDirs,
  RemediationHandler,
  RepoInspector,
  RunExecutor,
  SandboxDriver,
  StageHandler,
  VaultIngest,
  WorkerDriver,
} from '../ports'
import type { PullRequestStore } from '../stages/integration/records'
import type { Db } from '../state/db'
import type { EventLog } from '../state/events'
import type { Run, RunStore } from '../state/runs'

export const INGEST_AGENT = 'ingester'

export type SupervisorDeps = {
  config: Config
  db: Db
  linear: LinearPort
  executor: RunExecutor
  sandbox: Pick<SandboxDriver, 'status' | 'list' | 'destroy'>
  worker: Pick<WorkerDriver, 'alive'>
  repos: RepoInspector
  notifier: Notifier
  outbox: OutboxDirs
  agentKind: (agent: string) => AgentKind | undefined
  modelFor: (agent: string, profile: string, config: Config) => string
  classifier?: Classifier
  remediation?: RemediationHandler
  stageHandler?: StageHandler
  gitHost?: GitHost
  ingest?: VaultIngest
  secretsLocked?: () => Promise<boolean>
  now?: () => Date
  instanceId?: string
  leaseTtlMs?: number
  retry?: { baseMs: number; maxMs: number }
}

export type FinishLike = {
  status?: unknown
  blocker?: { needs?: string; reason?: string; question?: string; options?: string[] }
}

export class SupervisorRuntime {
  constructor(
    readonly deps: SupervisorDeps,
    readonly config: () => Config,
    readonly log: EventLog,
    readonly runs: RunStore,
    readonly pullRequests: PullRequestStore,
    readonly cache: Map<string, IssueSnapshot>,
    readonly now: () => Date,
  ) {}

  requireRun(id: string): Run {
    const run = this.runs.get(id)
    if (!run) throw new Error(`no run ${id}`)
    return run
  }

  meta(key: string): string | undefined {
    return this.deps.db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)
      ?.value
  }

  setMeta(key: string, value: string): void {
    this.deps.db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  metaMap<T>(key: string): Record<string, T> {
    const raw = this.meta(key)
    return raw ? (JSON.parse(raw) as Record<string, T>) : {}
  }

  async postOnce(identifier: string, marker: string, body: string): Promise<LinearComment> {
    const tag = `<!-- nightshift:${marker} -->`
    const existing = (await this.deps.linear.comments(identifier)).find((c) => c.body.includes(tag))
    return existing ?? this.deps.linear.comment(identifier, `${body}\n\n${tag}`)
  }

  async notify(
    title: string,
    issue?: string,
    extra: Omit<Notification, 'title' | 'issue'> = {},
  ): Promise<void> {
    const subject = issue ? this.cache.get(issue)?.title : undefined
    const channel = await this.deps.notifier.notify({
      title,
      ...(issue ? { issue } : {}),
      ...(subject ? { subject } : {}),
      ...extra,
    })
    if (channel) {
      this.log.append({ type: 'NOTIFICATION_SENT', data: { channel, title, ...(issue ? { issue } : {}) } })
    }
  }
}
