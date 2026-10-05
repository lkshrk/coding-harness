import { type Config, type LinearWorkspace, parseConfig } from '@nightshift/core'
import { optedIn } from '../policy/stages'
import type {
  ExecutorStart,
  IssueSnapshot,
  IssueUpdate,
  LinearComment,
  LinearPort,
  Notification,
  Notifier,
  OutboxDirs,
  RunExecutor,
  SandboxDriver,
  SandboxHandle,
  SandboxStatus,
  WorkerDriver,
  WorkerSession,
} from '../ports'
import type { Run } from '../state/runs'

const statuses = {
  triage: 'Triage',
  backlog: 'Backlog',
  ready: 'Todo',
  running: 'In Progress',
  review: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
  canceled: 'Canceled',
}

export function testConfig(): Config {
  return parseConfig({
    version: 1,
    paths: { state: '/tmp/ns/state', cache: '/tmp/ns/cache', vault: '/tmp/ns/vault' },
    gateway: {
      base_url: 'http://gateway.test',
      api_key: 'env:NS_GATEWAY_KEY',
      worker_key: 'env:NS_WORKER_KEY',
    },
    linear: {
      auth: { mode: 'api_key', api_key: 'env:NS_LINEAR_KEY' },
      exclude_labels: ['business'],
      teams: [{ key: 'FOR', statuses }],
    },
    github: { accounts: { me: { token: 'env:GH_TOKEN' } } },
    repositories: {
      omni: {
        path: '/tmp/omni',
        remote: 'origin',
        base: 'main',
        stacks: 'auto',
        checks: [{ name: 'test', run: 'bun test', timeout: '15m' }],
        risk_paths: [],
        macos_only: false,
      },
      web: {
        path: '/tmp/web',
        remote: 'origin',
        base: 'main',
        stacks: 'auto',
        checks: [{ name: 'test', run: 'bun test', timeout: '15m' }],
        risk_paths: [],
        macos_only: false,
      },
    },
    projects: [
      { match: { team: 'FOR', project: 'Omni' }, repositories: ['omni'], pipeline: 'feature' },
      { match: { team: 'FOR', label: 'bug' }, repositories: ['omni', 'web'], pipeline: 'bug' },
    ],
    pipelines: {
      feature: [
        'intake',
        'discovery',
        'design',
        'decomposition',
        'implementation',
        'verification',
        'integration',
        'acceptance',
      ],
      bug: ['intake', 'implementation', 'verification', 'integration'],
    },
    stages: {
      intake: { automatic: true, human_checkpoint: 'none' },
      discovery: { automatic: false, human_checkpoint: 'none' },
      design: { automatic: false, human_checkpoint: 'after' },
      decomposition: { automatic: false, human_checkpoint: 'after' },
      implementation: { automatic: true, human_checkpoint: 'none' },
      verification: { automatic: true, human_checkpoint: 'none' },
      integration: { automatic: true, human_checkpoint: 'none' },
      acceptance: { automatic: true, human_checkpoint: 'after' },
      release: { automatic: true, human_checkpoint: 'none' },
    },
    selection: [
      { when: { stage: 'intake' }, agent: 'intake' },
      { when: { stage: 'verification' }, agent: 'reviewer' },
      { when: { stage: 'acceptance' }, agent: 'acceptor' },
      { when: { stage: 'implementation', failure_class: 'implementation_defect' }, agent: 'repairer' },
      { when: { stage: 'implementation', issue_type: 'bug' }, agent: 'fixer' },
      { when: { stage: 'implementation', attempt: '>=3' }, agent: 'implementer-strong' },
      { when: { stage: 'implementation' }, agent: 'implementer' },
    ],
    profiles: {
      active: 'default',
      memory_budget_gb: 100,
      default: {
        roles: { worker: 'ns/worker', reviewer: 'ns/reviewer' },
        models: {
          'ns/worker': { model: 'qwen-coder', family: 'qwen', size_gb: 10, phases: ['implementation'] },
          'ns/reviewer': { model: 'glm', family: 'glm', size_gb: 10, phases: ['implementation'] },
        },
      },
    },
    limits: {
      concurrency: 2,
      worker: { wall_clock: '45m', tokens: '2M', steps: 200 },
      repair_rounds: 2,
      best_of: 2,
    },
    sandbox: { driver: 'docker', resources: { cpus: 4, memory: '8g' } },
    notifications: { macos: true, ntfy: null },
    policies: { deny: {} },
    secrets: { rbw_profile: 'nightshift' },
  })
}

let seq = 0

export function snapshot(over: Partial<IssueSnapshot> & { identifier: string }): IssueSnapshot {
  seq += 1
  return {
    id: `id-${over.identifier}`,
    title: `issue ${over.identifier}`,
    team: 'FOR',
    status: 'Todo',
    labels: ['ai-stage:implementation'],
    delegated: true,
    project: { id: 'p-omni', name: 'Omni', initiatives: [], labels: ['ai-merge:auto'] },
    priority: 0,
    estimate: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(),
    description: issueBody(),
    blockedBy: [],
    ...over,
  }
}

export class FakeLinear implements LinearPort {
  readonly store = new Map<string, IssueSnapshot>()
  readonly threads = new Map<string, LinearComment[]>()
  readonly updates: { identifier: string; change: IssueUpdate }[] = []
  readonly attachments = new Map<string, { url: string; title: string }[]>()
  workspaceValue: LinearWorkspace = testWorkspace()
  stale: Map<string, IssueSnapshot> | null = null
  private ids = 0
  private lastStamp = 0

  constructor(
    private readonly config: Config,
    private readonly now: () => Date,
  ) {}

  put(...issues: IssueSnapshot[]): void {
    for (const i of issues) this.store.set(i.identifier, { ...i, updatedAt: this.stamp() })
  }

  patch(identifier: string, over: Partial<IssueSnapshot>): void {
    const cur = this.store.get(identifier)
    if (!cur) throw new Error(`no issue ${identifier}`)
    this.store.set(identifier, { ...cur, ...over, updatedAt: this.stamp() })
  }

  get(identifier: string): IssueSnapshot {
    const cur = this.store.get(identifier)
    if (!cur) throw new Error(`no issue ${identifier}`)
    return cur
  }

  async workspace(): Promise<LinearWorkspace> {
    return this.workspaceValue
  }

  // Linear never gives two writes the same updatedAt, even within one millisecond.
  private stamp(): string {
    this.lastStamp = Math.max(this.now().getTime(), this.lastStamp + 1)
    return new Date(this.lastStamp).toISOString()
  }

  freezeReads(): void {
    this.stale = new Map([...this.store].map(([k, v]) => [k, { ...v }]))
  }

  async issues(q: { updatedSince?: string }): Promise<IssueSnapshot[]> {
    return [...(this.stale ?? this.store).values()]
      .filter(
        (i) => optedIn(i, this.config) && (q.updatedSince === undefined || i.updatedAt >= q.updatedSince),
      )
      .map((i) => this.live(i))
  }

  async issue(identifier: string): Promise<IssueSnapshot | null> {
    const cur = (this.stale ?? this.store).get(identifier)
    return cur ? this.live(cur) : null
  }

  async candidates(q: {
    team: string
    project: string | null
    closedSince: string
  }): Promise<IssueSnapshot[]> {
    return [...this.store.values()]
      .filter((i) => {
        if (i.team !== q.team || (i.project?.id ?? null) !== q.project) return false
        const statuses = this.config.linear.teams.find((t) => t.key === i.team)?.statuses
        const type =
          i.stateType ??
          (i.status === statuses?.done
            ? 'completed'
            : i.status === statuses?.canceled
              ? 'canceled'
              : 'started')
        const closedAt = type === 'completed' ? i.completedAt : type === 'canceled' ? i.canceledAt : undefined
        return (
          (type !== 'completed' && type !== 'canceled') ||
          Boolean(closedAt && Date.parse(closedAt) >= Date.parse(q.closedSince))
        )
      })
      .map((i) => this.live(i))
  }

  private live(issue: IssueSnapshot): IssueSnapshot {
    const blockedBy = issue.blockedBy.map((b) => {
      const blocker = this.store.get(b.identifier)
      return blocker ? { ...b, status: blocker.status } : b
    })
    return { ...issue, blockedBy }
  }

  async comments(identifier: string): Promise<LinearComment[]> {
    return this.threads.get(identifier) ?? []
  }

  async comment(identifier: string, body: string, opts: { parentId?: string } = {}): Promise<LinearComment> {
    this.ids += 1
    const c = {
      id: `c${this.ids}`,
      body,
      createdAt: this.now().toISOString(),
      parentId: opts.parentId ?? null,
      by: 'nightshift',
    }
    this.threads.set(identifier, [...(this.threads.get(identifier) ?? []), c])
    return c
  }

  async attachLink(identifier: string, url: string, title: string): Promise<void> {
    const list = this.attachments.get(identifier) ?? []
    if (!list.some((a) => a.url === url)) this.attachments.set(identifier, [...list, { url, title }])
  }

  reply(identifier: string, parentId: string, body: string, by = 'you'): void {
    this.ids += 1
    const c = { id: `c${this.ids}`, body, createdAt: this.now().toISOString(), parentId, by }
    this.threads.set(identifier, [...(this.threads.get(identifier) ?? []), c])
  }

  async update(identifier: string, change: IssueUpdate): Promise<void> {
    this.updates.push({ identifier, change })
    const cur = this.get(identifier)
    let labels = [...cur.labels]
    let status = cur.status
    if (change.status !== undefined) {
      const team = this.config.linear.teams.find((t) => t.key === cur.team)
      status = team?.statuses[change.status] ?? status
    }
    if (change.stage !== undefined)
      labels = [...labels.filter((l) => !l.startsWith('ai-stage:')), `ai-stage:${change.stage}`]
    this.patch(identifier, { status, labels })
  }
}

export function testWorkspace(): LinearWorkspace {
  return {
    organization: { id: 'o', name: 'h-cloud', urlKey: 'h-cloud', plan: 'basic' },
    teams: [
      {
        id: 't-FOR',
        key: 'FOR',
        name: 'Forge',
        statuses: Object.values(statuses).map((name) => ({ id: `s-${name}`, name, type: 'started' })),
      },
    ],
    labels: [
      { id: 'l-bug', name: 'bug', isGroup: false, parentId: null, teamId: null },
      { id: 'l-business', name: 'business', isGroup: false, parentId: null, teamId: null },
    ],
    projectLabels: [],
    projects: [{ id: 'p-omni', name: 'Omni', state: 'started', milestones: [] }],
    initiatives: [],
    templates: [],
  }
}

export class FakeExecutor implements RunExecutor {
  readonly calls: { op: string; run: string; detail?: string }[] = []
  readonly starts: ExecutorStart[] = []
  readonly heads = new Map<string, string>()
  failStart: string | Error | undefined

  async start(s: ExecutorStart): Promise<void> {
    this.calls.push({ op: 'start', run: s.run.id })
    this.starts.push(s)
    if (this.failStart) throw this.failStart instanceof Error ? this.failStart : new Error(this.failStart)
  }

  async reattach(run: Run): Promise<void> {
    this.calls.push({ op: 'reattach', run: run.id })
  }

  async runStep(run: Run): Promise<void> {
    this.calls.push({ op: 'runStep', run: run.id, detail: run.state })
  }

  async nudge(run: Run, message: string): Promise<void> {
    this.calls.push({ op: 'nudge', run: run.id, detail: message })
  }

  async stop(run: Run, reason: string): Promise<void> {
    this.calls.push({ op: 'stop', run: run.id, detail: reason })
  }

  detach(): void {
    this.calls.push({ op: 'detach', run: '*' })
  }

  async captureHead(run: Run): Promise<string | undefined> {
    this.calls.push({ op: 'captureHead', run: run.id, detail: run.sandbox ?? '' })
    return this.heads.get(run.id)
  }

  ops(op: string): string[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.run)
  }
}

export class FakeSandbox implements Pick<SandboxDriver, 'status' | 'list' | 'destroy'> {
  readonly sandboxes = new Map<string, { handle: SandboxHandle; status: SandboxStatus }>()
  readonly destroyed: string[] = []

  add(name: string, status: SandboxStatus = 'running'): SandboxHandle {
    const handle: SandboxHandle = { driver: 'docker', id: `sb-${name}`, name }
    this.sandboxes.set(handle.id, { handle, status })
    return handle
  }

  async status(h: SandboxHandle): Promise<SandboxStatus> {
    return this.sandboxes.get(h.id)?.status ?? 'gone'
  }

  async list(): Promise<SandboxHandle[]> {
    return [...this.sandboxes.values()].map((s) => s.handle)
  }

  async destroy(h: SandboxHandle): Promise<void> {
    this.sandboxes.delete(h.id)
    this.destroyed.push(h.id)
  }
}

export class FakeWorker implements Pick<WorkerDriver, 'alive'> {
  readonly sessions = new Set<string>()

  async alive(s: WorkerSession): Promise<boolean> {
    return this.sessions.has(s.id)
  }
}

export class FakeNotifier implements Notifier {
  readonly sent: Notification[] = []

  async notify(n: Notification): Promise<'macos'> {
    this.sent.push(n)
    return 'macos'
  }
}

export class FakeOutbox implements OutboxDirs {
  readonly dirs = new Set<string>()

  list(): string[] {
    return [...this.dirs]
  }

  remove(run: string): void {
    this.dirs.delete(run)
  }
}

export function issueBody(files: string[] = ['src/a.ts']): string {
  return [
    '## Goal',
    'Do the thing.',
    '## Why',
    'Because.',
    '## Design excerpt',
    '[design](https://linear.app/h-cloud/document/design-1) section 2',
    '## Interfaces in',
    'none',
    '## Interfaces out',
    'none',
    '## Files',
    ...files.map((f) => `- \`${f}\``),
    '## Constraints',
    'none',
    '## Out of scope',
    'none',
    '## Acceptance criteria',
    '- it works',
    '## Tests expected',
    '- a unit test',
    '## Verify',
    '- `bun test`',
    '',
  ].join('\n')
}
