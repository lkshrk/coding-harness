import type { Config, LinearWorkspace } from '@nightshift/core'
import { optedIn } from '../policy/stages'
import type { IssueSnapshot, IssueUpdate, LinearChange, LinearComment, LinearPort } from '../ports'
import { issueBody, testWorkspace } from './config'

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
    parent: null,
    ...over,
  }
}

export class FakeLinear implements LinearPort {
  readonly store = new Map<string, IssueSnapshot>()
  readonly threads = new Map<string, LinearComment[]>()
  readonly updates: { identifier: string; change: IssueUpdate }[] = []
  readonly attachments = new Map<string, { url: string; title: string }[]>()
  readonly changes = new Map<string, LinearChange>()
  readonly uploads: { name: string; contentType: string; size: number }[] = []
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
    // A patch from a test is an operator edit; update() records its own app change after this.
    if (over.status !== undefined || over.labels !== undefined)
      this.changes.set(identifier, {
        actor: 'You',
        app: false,
        at: this.now().toISOString(),
        ...(over.status === undefined ? {} : { status: over.status }),
        ...(over.labels === undefined ? {} : { labels: over.labels }),
      })
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

  async lastChange(identifier: string): Promise<LinearChange | null> {
    return this.changes.get(identifier) ?? null
  }

  async comment(
    identifier: string,
    body: string,
    opts: { parentId?: string; replace?: boolean } = {},
  ): Promise<LinearComment> {
    const marker = /<!-- nightshift:\S+? -->/.exec(body)?.[0]
    const thread = this.threads.get(identifier) ?? []
    const existing = opts.replace && marker ? thread.find((c) => c.body.includes(marker)) : undefined
    if (existing) {
      const updated = { ...existing, body }
      this.threads.set(
        identifier,
        thread.map((c) => (c.id === existing.id ? updated : c)),
      )
      return updated
    }
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

  async createChild(parent: string, issue: { title: string; description: string }): Promise<string> {
    const p = this.get(parent)
    const existing = [...this.store.values()].find(
      (i) => i.parent === parent && i.title === issue.title && i.description === issue.description,
    )
    if (existing) return existing.identifier
    const identifier = `${p.team}-${100 + this.store.size}`
    this.put({
      ...p,
      id: `id-${identifier}`,
      identifier,
      title: issue.title,
      description: issue.description,
      status: this.config.linear.teams.find((t) => t.key === p.team)?.statuses.backlog ?? p.status,
      labels: [],
      blockedBy: [],
      parent,
      createdAt: this.now().toISOString(),
    })
    return identifier
  }

  async addBlocks(blocker: string, blocked: string): Promise<void> {
    const b = this.get(blocker)
    const target = this.get(blocked)
    if (target.blockedBy.some((r) => r.identifier === blocker)) return
    this.patch(blocked, {
      blockedBy: [...target.blockedBy, { identifier: blocker, team: b.team, status: b.status }],
    })
  }

  async uploadFile(name: string, contentType: string, bytes: Uint8Array): Promise<string> {
    this.uploads.push({ name, contentType, size: bytes.byteLength })
    return `https://uploads.linear.test/${this.uploads.length}/${name}`
  }

  reply(identifier: string, parentId: string, body: string, by = 'you'): void {
    this.ids += 1
    const c = { id: `c${this.ids}`, body, createdAt: this.now().toISOString(), parentId, by }
    this.threads.set(identifier, [...(this.threads.get(identifier) ?? []), c])
  }

  react(identifier: string, commentId: string, emoji: string): void {
    const thread = this.threads.get(identifier) ?? []
    const at = this.now().toISOString()
    this.threads.set(
      identifier,
      thread.map((c) =>
        c.id === commentId ? { ...c, reactions: [...(c.reactions ?? []), { emoji, at }] } : c,
      ),
    )
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
      labels = [
        ...labels.filter((l) => !l.startsWith('ai-stage:')),
        ...(change.stage === null ? [] : [`ai-stage:${change.stage}`]),
      ]
    this.patch(identifier, { status, labels })
    if (change.status !== undefined || change.stage !== undefined)
      this.changes.set(identifier, {
        actor: 'nightshift',
        app: true,
        at: this.now().toISOString(),
        ...(change.status === undefined ? {} : { status }),
        ...(change.stage === undefined ? {} : { labels }),
      })
  }
}
