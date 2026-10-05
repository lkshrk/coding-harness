import {
  Issue_InverseRelationsQuery,
  Issue_RelationsQuery,
  LinearError,
  LinearErrorType,
  type LinearGraphQLErrorRaw,
  type LinearRequest,
  LinearSdk,
  parseLinearError,
} from '@linear/sdk'
import { type FetchFn, LinearAuthError, type TokenProvider } from './auth'
import type { BlockingRelations, LinearViewer, LinearWorkspace } from './workspace'

export const LINEAR_API_URL = 'https://api.linear.app/graphql'
const PAGE_SIZE = 250

type GraphQLBody = { data?: unknown; errors?: LinearGraphQLErrorRaw[] }

type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean }; fetchNext(): Promise<unknown> }

export function linearRequest(opts: {
  auth: TokenProvider
  fetch?: FetchFn
  apiUrl?: string
}): LinearRequest {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init))
  const url = opts.apiUrl ?? LINEAR_API_URL
  const trace = process.env.NIGHTSHIFT_LINEAR_TRACE === '1'
  const send = async (query: string, variables: Record<string, unknown> | undefined) => {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: await opts.auth.authorization() },
      body: JSON.stringify({ query, variables }),
    })
    const body = (await res.json().catch(() => ({}))) as GraphQLBody
    if (trace)
      console.error(
        `linear ${/(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? query.slice(0, 40).replace(/\s+/g, ' ')} complexity=${res.headers.get('x-complexity')} remaining=${res.headers.get('x-ratelimit-complexity-remaining')}`,
      )
    return { res, body }
  }
  return async <R, V extends Record<string, unknown>>(query: string, variables?: V): Promise<R> => {
    let { res, body } = await send(query, variables)
    if (unauthenticated(res, body)) {
      opts.auth.invalidate()
      ;({ res, body } = await send(query, variables))
      if (unauthenticated(res, body))
        throw new LinearAuthError('linear.auth: Linear rejected the credentials')
    }
    if (!res.ok || body.errors?.length || !body.data) {
      throw parseLinearError({
        response: { ...body, status: res.status },
        request: { query, ...(variables ? { variables } : {}) },
      })
    }
    return body.data as R
  }
}

function unauthenticated(res: Response, body: GraphQLBody): boolean {
  return (
    res.status === 401 ||
    (body.errors ?? []).some(
      (e) => (e.extensions as { code?: string } | undefined)?.code === 'AUTHENTICATION_ERROR',
    )
  )
}

function forbiddenAsNull(e: unknown): null {
  if (e instanceof LinearError && e.type === LinearErrorType.Forbidden) return null
  throw e
}

async function all<T>(connection: Connection<T>): Promise<T[]> {
  while (connection.pageInfo.hasNextPage) await connection.fetchNext()
  return connection.nodes
}

export class LinearReader {
  private readonly sdk: LinearSdk

  constructor(private readonly request: LinearRequest) {
    this.sdk = new LinearSdk(request)
  }

  async viewer(): Promise<LinearViewer> {
    const v = await this.sdk.viewer
    return { id: v.id, name: v.name, displayName: v.displayName, app: v.app }
  }

  async workspace(): Promise<LinearWorkspace> {
    const first = { first: PAGE_SIZE }
    const [org, teams, states, labels, projectLabels, projects, milestones, initiatives, templates] =
      await Promise.all([
        this.sdk.organization,
        this.sdk.teams(first).then(all),
        this.sdk.workflowStates(first).then(all),
        this.sdk.issueLabels(first).then(all),
        this.sdk.projectLabels(first).then(all),
        this.sdk.projects(first).then(all),
        this.sdk.projectMilestones(first).then(all),
        this.sdk.initiatives(first).then(all, forbiddenAsNull),
        this.sdk.templates,
      ])
    const label = (l: (typeof labels)[number] | (typeof projectLabels)[number]) => ({
      id: l.id,
      name: l.name,
      isGroup: l.isGroup,
      parentId: l.parentId ?? null,
      teamId: l.teamId ?? null,
    })
    return {
      organization: { id: org.id, name: org.name, urlKey: org.urlKey, plan: org.subscription?.type ?? null },
      teams: teams.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        statuses: states
          .filter((s) => s.teamId === t.id)
          .sort((a, b) => a.position - b.position)
          .map((s) => ({ id: s.id, name: s.name, type: s.type })),
      })),
      labels: labels.map(label),
      projectLabels: projectLabels.map(label),
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
        milestones: milestones
          .filter((m) => m.projectId === p.id)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((m) => ({ id: m.id, name: m.name })),
      })),
      initiatives: initiatives?.map((i) => ({ id: i.id, name: i.name })) ?? null,
      templates: templates.map((t) => ({ id: t.id, name: t.name, type: t.type, teamId: t.teamId ?? null })),
    }
  }

  async blockingRelations(issueId: string): Promise<BlockingRelations> {
    const first = { first: PAGE_SIZE }
    const [relations, inverse] = await Promise.all([
      new Issue_RelationsQuery(this.request, issueId, first).fetch().then(all),
      new Issue_InverseRelationsQuery(this.request, issueId, first).fetch().then(all),
    ])
    return {
      blocks: relations.filter((r) => r.type === 'blocks').flatMap((r) => r.relatedIssueId ?? []),
      blockedBy: inverse.filter((r) => r.type === 'blocks').flatMap((r) => r.issueId ?? []),
    }
  }
}

export function createLinearReader(opts: {
  auth: TokenProvider
  fetch?: FetchFn
  apiUrl?: string
}): LinearReader {
  return new LinearReader(linearRequest(opts))
}
