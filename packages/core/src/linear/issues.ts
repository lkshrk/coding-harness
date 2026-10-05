import { LinearError, type LinearRequest } from '@linear/sdk'

export type LinearBlocker = { identifier: string; team: string; status: string }

export type LinearIssueProject = { id: string; name: string; initiatives: string[]; labels: string[] }

export type LinearIssue = {
  id: string
  identifier: string
  title: string
  team: string
  status: string
  stateType?: string
  completedAt?: string | null
  canceledAt?: string | null
  labels: string[]
  delegated: boolean
  project: LinearIssueProject | null
  priority: number
  estimate: number | null
  createdAt: string
  updatedAt: string
  description: string
  blockedBy: LinearBlocker[]
}

export type LinearIssueComment = {
  id: string
  body: string
  createdAt: string
  parentId: string | null
  by: string
}

export type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

export type RawLabel = { id: string; name: string; parent: { name: string } | null }

type RawRelation = {
  type: string
  issue: { identifier: string; team: { key: string }; state: { name: string } }
}

type RawIssue = {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number
  estimate: number | null
  createdAt: string
  updatedAt: string
  team: { key: string }
  state: { name: string; type?: string }
  completedAt?: string | null
  canceledAt?: string | null
  project: { id: string } | null
  delegate?: { isMe: boolean } | null
  assignee?: { isMe: boolean } | null
  labels: Page<RawLabel>
  inverseRelations: Page<RawRelation>
}

type RawProject = { id: string; name: string; labels: Page<RawLabel>; initiatives: Page<{ name: string }> }

export type RawComment = {
  id: string
  body: string
  createdAt: string
  parent: { id: string } | null
  user: { name: string } | null
  botActor: { name: string | null } | null
  externalUser: { name: string } | null
}

const ISSUE_PAGE = 25
const NESTED_PAGE = 20
const COMMENT_PAGE = 100
const PROJECT_PAGE = 50
const PROJECT_TTL_MS = 10 * 60_000

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'
export const LABEL_FIELDS = `nodes { id name parent { name } } ${PAGE_INFO}`
export const COMMENT_FIELDS =
  'id body createdAt parent { id } user { name } botActor { name } externalUser { name }'
const RELATION_FIELDS = `nodes { type issue { identifier team { key } state { name } } } ${PAGE_INFO}`

const ISSUE_FIELDS = `id identifier title description priority estimate createdAt updatedAt completedAt canceledAt
  team { key } state { name type } project { id } delegate { isMe } assignee { isMe }
  labels(first: ${NESTED_PAGE}) { ${LABEL_FIELDS} }
  inverseRelations(first: ${NESTED_PAGE}) { ${RELATION_FIELDS} }`

const ISSUES = `query nsIssues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: createdAt) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} }
}`

const ISSUE = `query nsIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`

const ISSUE_LABELS = `query nsIssueLabels($id: String!, $after: String) {
  issue(id: $id) { labels(first: ${NESTED_PAGE}, after: $after) { ${LABEL_FIELDS} } }
}`

const ISSUE_BLOCKERS = `query nsIssueBlockers($id: String!, $after: String) {
  issue(id: $id) { inverseRelations(first: ${NESTED_PAGE}, after: $after) { ${RELATION_FIELDS} } }
}`

const PROJECTS = `query nsProjects($ids: [ID!], $first: Int!, $after: String) {
  projects(filter: { id: { in: $ids } }, first: $first, after: $after) {
    nodes {
      id name
      labels(first: ${NESTED_PAGE}) { ${LABEL_FIELDS} }
      initiatives(first: ${NESTED_PAGE}) { nodes { name } ${PAGE_INFO} }
    }
    ${PAGE_INFO}
  }
}`

const PROJECT_LABELS = `query nsProjectLabels($id: String!, $after: String) {
  project(id: $id) { labels(first: ${NESTED_PAGE}, after: $after) { ${LABEL_FIELDS} } }
}`

const PROJECT_INITIATIVES = `query nsProjectInitiatives($id: String!, $after: String) {
  project(id: $id) { initiatives(first: ${NESTED_PAGE}, after: $after) { nodes { name } ${PAGE_INFO} } }
}`

const COMMENTS = `query nsIssueComments($id: String!, $after: String) {
  issue(id: $id) {
    id
    comments(first: ${COMMENT_PAGE}, after: $after) {
      nodes { ${COMMENT_FIELDS} }
      ${PAGE_INFO}
    }
  }
}`

export async function rest<T>(first: Page<T>, next: (after: string) => Promise<Page<T>>): Promise<T[]> {
  const nodes = [...first.nodes]
  let info = first.pageInfo
  while (info.hasNextPage && info.endCursor) {
    const page = await next(info.endCursor)
    nodes.push(...page.nodes)
    info = page.pageInfo
  }
  return nodes
}

export function labelName(l: RawLabel): string {
  return l.parent ? `${l.parent.name.toLowerCase()}:${l.name}` : l.name
}

export function notFound(e: unknown): boolean {
  return e instanceof LinearError && /not found/i.test(e.message)
}

const tooComplex = (e: unknown) => e instanceof LinearError && /complex/i.test(e.message)

export type ActOn = { delegated: boolean; labels: readonly string[] }

export function optInFilter(actOn: ActOn): { or: Record<string, unknown>[] } {
  const routes: Record<string, unknown>[] = actOn.delegated
    ? [{ delegate: { isMe: { eq: true } } }, { assignee: { isMe: { eq: true } } }]
    : []
  for (const label of actOn.labels) routes.push({ labels: { some: { name: { eqIgnoreCase: label } } } })
  return { or: routes }
}

export class LinearIssueReader {
  private readonly projectCache = new Map<string, { project: LinearIssueProject; at: number }>()

  constructor(
    private readonly request: LinearRequest,
    private readonly now: () => number = Date.now,
  ) {}

  async issues(q: { actOn: ActOn; updatedSince?: string }): Promise<LinearIssue[]> {
    const optIn = optInFilter(q.actOn)
    if (optIn.or.length === 0) return []
    const filter = {
      and: [optIn, ...(q.updatedSince === undefined ? [] : [{ updatedAt: { gte: q.updatedSince } }])],
    }
    return this.complete(await this.list(filter))
  }

  async candidates(q: { team: string; project: string | null; closedSince: string }): Promise<LinearIssue[]> {
    const raw = await this.list({
      and: [
        { team: { key: { eq: q.team } } },
        { project: q.project === null ? { null: true } : { id: { eq: q.project } } },
        {
          or: [
            { state: { type: { nin: ['completed', 'canceled'] } } },
            { state: { type: { eq: 'completed' } }, completedAt: { gte: q.closedSince } },
            { state: { type: { eq: 'canceled' } }, canceledAt: { gte: q.closedSince } },
          ],
        },
      ],
    })
    return this.complete(
      raw.filter((i) => {
        if (i.team.key !== q.team || (i.project?.id ?? null) !== q.project) return false
        const closedAt =
          i.state.type === 'completed'
            ? i.completedAt
            : i.state.type === 'canceled'
              ? i.canceledAt
              : undefined
        return (
          (i.state.type !== 'completed' && i.state.type !== 'canceled') ||
          Boolean(closedAt && Date.parse(closedAt) >= Date.parse(q.closedSince))
        )
      }),
    )
  }

  private async list(filter: Record<string, unknown>): Promise<RawIssue[]> {
    const raw: RawIssue[] = []
    let first = ISSUE_PAGE
    let after: string | null = null
    for (;;) {
      let page: Page<RawIssue>
      try {
        page = (
          await this.request<{ issues: Page<RawIssue> }, Record<string, unknown>>(ISSUES, {
            filter,
            first,
            after,
          })
        ).issues
      } catch (e) {
        if (!tooComplex(e) || first === 1) throw e
        first = Math.floor(first / 2)
        continue
      }
      raw.push(...page.nodes)
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break
      after = page.pageInfo.endCursor
    }
    return raw
  }

  async issue(identifier: string): Promise<LinearIssue | null> {
    let data: { issue: RawIssue }
    try {
      data = await this.request<{ issue: RawIssue }, { id: string }>(ISSUE, { id: identifier })
    } catch (e) {
      if (notFound(e)) return null
      throw e
    }
    return (await this.complete([data.issue]))[0] ?? null
  }

  async comments(identifier: string): Promise<LinearIssueComment[]> {
    return (await this.thread(identifier))?.comments ?? []
  }

  async thread(identifier: string): Promise<{ issueId: string; comments: LinearIssueComment[] } | null> {
    type Data = { issue: { id: string; comments: Page<RawComment> } }
    const page = (after: string | null) =>
      this.request<Data, { id: string; after: string | null }>(COMMENTS, { id: identifier, after })
    let data: Data
    try {
      data = await page(null)
    } catch (e) {
      if (notFound(e)) return null
      throw e
    }
    const raw = await rest(data.issue.comments, async (after) => (await page(after)).issue.comments)
    return {
      issueId: data.issue.id,
      comments: raw.map(toComment).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }
  }

  async issueLabels(issueId: string, first: Page<RawLabel>): Promise<RawLabel[]> {
    return rest(
      first,
      async (after) => (await this.nested<'labels', RawLabel>(ISSUE_LABELS, issueId, after)).labels,
    )
  }

  private async complete(raw: RawIssue[]): Promise<LinearIssue[]> {
    const projects = await this.projects([...new Set(raw.flatMap((i) => i.project?.id ?? []))])
    return Promise.all(
      raw.map(async (i) => {
        const [labels, relations] = await Promise.all([
          this.issueLabels(i.id, i.labels),
          rest(
            i.inverseRelations,
            async (after) =>
              (await this.nested<'inverseRelations', RawRelation>(ISSUE_BLOCKERS, i.id, after))
                .inverseRelations,
          ),
        ])
        return {
          id: i.id,
          identifier: i.identifier,
          title: i.title,
          team: i.team.key,
          status: i.state.name,
          ...(i.state.type === undefined ? {} : { stateType: i.state.type }),
          ...(i.completedAt === undefined ? {} : { completedAt: i.completedAt }),
          ...(i.canceledAt === undefined ? {} : { canceledAt: i.canceledAt }),
          labels: labels.map(labelName),
          delegated: Boolean(i.delegate?.isMe || i.assignee?.isMe),
          project: i.project ? (projects.get(i.project.id) ?? null) : null,
          priority: i.priority,
          estimate: i.estimate ?? null,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
          description: i.description ?? '',
          blockedBy: relations
            .filter((r) => r.type === 'blocks')
            .map((r) => ({
              identifier: r.issue.identifier,
              team: r.issue.team.key,
              status: r.issue.state.name,
            })),
        }
      }),
    )
  }

  private async projects(all: string[]): Promise<Map<string, LinearIssueProject>> {
    const out = new Map<string, LinearIssueProject>()
    const ids: string[] = []
    for (const id of all) {
      const hit = this.projectCache.get(id)
      if (hit && this.now() - hit.at < PROJECT_TTL_MS) out.set(id, hit.project)
      else ids.push(id)
    }
    if (ids.length === 0) return out
    type Data = { projects: Page<RawProject> }
    // Linear charges nested connections by the requested page size, not by the rows returned.
    const first = Math.min(ids.length, PROJECT_PAGE)
    const page = (after: string | null) =>
      this.request<Data, { ids: string[]; first: number; after: string | null }>(PROJECTS, {
        ids,
        first,
        after,
      })
    const raw = await rest((await page(null)).projects, async (after) => (await page(after)).projects)
    for (const p of raw) {
      const [labels, initiatives] = await Promise.all([
        rest(
          p.labels,
          async (after) =>
            (await this.nested<'labels', RawLabel>(PROJECT_LABELS, p.id, after, 'project')).labels,
        ),
        rest(
          p.initiatives,
          async (after) =>
            (await this.nested<'initiatives', { name: string }>(PROJECT_INITIATIVES, p.id, after, 'project'))
              .initiatives,
        ),
      ])
      const project = {
        id: p.id,
        name: p.name,
        initiatives: initiatives.map((i) => i.name),
        labels: labels.map(labelName),
      }
      this.projectCache.set(p.id, { project, at: this.now() })
      out.set(p.id, project)
    }
    return out
  }

  private async nested<K extends string, T>(
    query: string,
    id: string,
    after: string,
    root: 'issue' | 'project' = 'issue',
  ): Promise<Record<K, Page<T>>> {
    const data = await this.request<Record<string, Record<K, Page<T>>>, { id: string; after: string }>(
      query,
      {
        id,
        after,
      },
    )
    const node = data[root]
    if (!node) throw new Error(`linear: ${root} ${id} missing from response`)
    return node
  }
}

export function toComment(c: RawComment): LinearIssueComment {
  return {
    id: c.id,
    body: c.body,
    createdAt: c.createdAt,
    parentId: c.parent?.id ?? null,
    by: c.user?.name ?? c.botActor?.name ?? c.externalUser?.name ?? 'unknown',
  }
}
