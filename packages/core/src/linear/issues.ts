import type { LinearRequest } from '@linear/sdk'

import {
  COMMENTS,
  HISTORY,
  ISSUE,
  ISSUE_BLOCKERS,
  ISSUE_LABELS,
  ISSUE_PAGE,
  ISSUES,
  labelName,
  notFound,
  type Page,
  PROJECT_INITIATIVES,
  PROJECT_LABELS,
  PROJECT_PAGE,
  PROJECT_TTL_MS,
  PROJECTS,
  type RawComment,
  type RawHistory,
  type RawIssue,
  type RawLabel,
  type RawProject,
  type RawRelation,
  rest,
  tooComplex,
} from './issue-queries'

export * from './issue-queries'

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

export type LinearChange = { actor: string; app: boolean; at: string; status?: string; labels?: string[] }

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

  async lastChange(identifier: string): Promise<LinearChange | null> {
    type Data = { issue: { history: Page<RawHistory> } }
    const page = (after: string | null) =>
      this.request<Data, { id: string; after: string | null }>(HISTORY, { id: identifier, after })
    let history: Page<RawHistory>
    try {
      history = (await page(null)).issue.history
    } catch (e) {
      if (notFound(e)) return null
      throw e
    }
    // History arrives newest first; the first page holding a status or label change holds the newest one.
    let newest: RawHistory | undefined
    for (;;) {
      newest = history.nodes
        .filter((h) => h.toState || h.addedLabels?.length || h.removedLabels?.length)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      if (newest || !history.pageInfo.hasNextPage || !history.pageInfo.endCursor) break
      history = (await page(history.pageInfo.endCursor)).issue.history
    }
    if (!newest) return null
    const labelChange = Boolean(newest.addedLabels?.length || newest.removedLabels?.length)
    return {
      actor: newest.actor?.name ?? newest.botActor?.name ?? 'unknown',
      app: Boolean(newest.actor?.app || newest.botActor),
      at: newest.createdAt,
      ...(newest.toState ? { status: newest.toState.name } : {}),
      ...(labelChange ? { labels: (newest.addedLabels ?? []).map(labelName) } : {}),
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
