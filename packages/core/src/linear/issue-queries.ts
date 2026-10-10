import { LinearError } from '@linear/sdk'

export type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

export type RawLabel = { id: string; name: string; parent: { name: string } | null }

export type RawRelation = {
  type: string
  issue: { identifier: string; team: { key: string }; state: { name: string } }
}

export type RawIssue = {
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

export type RawProject = {
  id: string
  name: string
  labels: Page<RawLabel>
  initiatives: Page<{ name: string }>
}

export type RawComment = {
  id: string
  body: string
  createdAt: string
  parent: { id: string } | null
  user: { name: string } | null
  botActor: { name: string | null } | null
  externalUser: { name: string } | null
}

export type RawHistory = {
  createdAt: string
  actor: { name: string; app: boolean } | null
  botActor: { name: string | null } | null
  toState: { name: string } | null
  addedLabels: RawLabel[] | null
  removedLabels: RawLabel[] | null
}

export const ISSUE_PAGE = 25

const NESTED_PAGE = 20

const COMMENT_PAGE = 100

export const PROJECT_PAGE = 50

export const PROJECT_TTL_MS = 10 * 60_000

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'

export const LABEL_FIELDS = `nodes { id name parent { name } } ${PAGE_INFO}`

export const COMMENT_FIELDS =
  'id body createdAt parent { id } user { name } botActor { name } externalUser { name }'

const RELATION_FIELDS = `nodes { type issue { identifier team { key } state { name } } } ${PAGE_INFO}`

const ISSUE_FIELDS = `id identifier title description priority estimate createdAt updatedAt completedAt canceledAt
  team { key } state { name type } project { id } delegate { isMe } assignee { isMe }
  labels(first: ${NESTED_PAGE}) { ${LABEL_FIELDS} }
  inverseRelations(first: ${NESTED_PAGE}) { ${RELATION_FIELDS} }`

export const ISSUES = `query nsIssues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: createdAt) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} }
}`

export const ISSUE = `query nsIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`

export const ISSUE_LABELS = `query nsIssueLabels($id: String!, $after: String) {
  issue(id: $id) { labels(first: ${NESTED_PAGE}, after: $after) { ${LABEL_FIELDS} } }
}`

export const ISSUE_BLOCKERS = `query nsIssueBlockers($id: String!, $after: String) {
  issue(id: $id) { inverseRelations(first: ${NESTED_PAGE}, after: $after) { ${RELATION_FIELDS} } }
}`

export const PROJECTS = `query nsProjects($ids: [ID!], $first: Int!, $after: String) {
  projects(filter: { id: { in: $ids } }, first: $first, after: $after) {
    nodes {
      id name
      labels(first: ${NESTED_PAGE}) { ${LABEL_FIELDS} }
      initiatives(first: ${NESTED_PAGE}) { nodes { name } ${PAGE_INFO} }
    }
    ${PAGE_INFO}
  }
}`

export const PROJECT_LABELS = `query nsProjectLabels($id: String!, $after: String) {
  project(id: $id) { labels(first: ${NESTED_PAGE}, after: $after) { ${LABEL_FIELDS} } }
}`

export const PROJECT_INITIATIVES = `query nsProjectInitiatives($id: String!, $after: String) {
  project(id: $id) { initiatives(first: ${NESTED_PAGE}, after: $after) { nodes { name } ${PAGE_INFO} } }
}`

export const COMMENTS = `query nsIssueComments($id: String!, $after: String) {
  issue(id: $id) {
    id
    comments(first: ${COMMENT_PAGE}, after: $after) {
      nodes { ${COMMENT_FIELDS} }
      ${PAGE_INFO}
    }
  }
}`

export const HISTORY_PAGE = 5

export const HISTORY = `query nsIssueHistory($id: String!) {
  issue(id: $id) {
    history(first: ${HISTORY_PAGE}) {
      nodes {
        createdAt actor { name app } botActor { name } toState { name }
        addedLabels { id name parent { name } } removedLabels { id name parent { name } }
      }
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

export const tooComplex = (e: unknown) => e instanceof LinearError && /complex/i.test(e.message)
