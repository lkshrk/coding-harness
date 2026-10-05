import { type LinearDocument, type LinearRequest, LinearSdk } from '@linear/sdk'
import { type ApplyOp, describeOp, type LinearCustomView } from './plan'

export type CreatedObject = { op: ApplyOp; id: string }

export type ApplyResult = {
  applied: boolean
  created: CreatedObject[]
  failed: { op: ApplyOp; error: string } | null
  pending: ApplyOp[]
}

const PAGE_SIZE = 250

type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

export async function executeApply(
  ops: ApplyOp[],
  request: LinearRequest,
  opts: { confirm?: boolean } = {},
): Promise<ApplyResult> {
  if (!opts.confirm) return { applied: false, created: [], failed: null, pending: ops }
  const sdk = new LinearSdk(request)
  const groups: CreatedGroups = { issue: new Map(), project: new Map() }
  const created: CreatedObject[] = []
  for (const [i, op] of ops.entries()) {
    try {
      const id = await create(sdk, request, op, groups)
      if (op.kind === 'label_group') groups.issue.set(op.name, id)
      if (op.kind === 'project_label_group') groups.project.set(op.name, id)
      created.push({ op, id })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return { applied: true, created, failed: { op, error }, pending: ops.slice(i + 1) }
    }
  }
  return { applied: true, created, failed: null, pending: [] }
}

type CreatedGroups = { issue: Map<string, string>; project: Map<string, string> }

async function create(
  sdk: LinearSdk,
  request: LinearRequest,
  op: ApplyOp,
  groups: CreatedGroups,
): Promise<string> {
  switch (op.kind) {
    case 'label_group': {
      const p = await sdk.createIssueLabel({ name: op.name, isGroup: true })
      return confirmed(op, p.success, p.issueLabelId)
    }
    case 'label': {
      if (op.group === null) {
        const p = await sdk.createIssueLabel({ name: op.name })
        return confirmed(op, p.success, p.issueLabelId)
      }
      const parentId = op.parentId ?? groups.issue.get(op.group)
      if (!parentId) throw new Error(`label group ${op.group} not found`)
      const p = await sdk.createIssueLabel({ name: op.name, parentId })
      return confirmed(op, p.success, p.issueLabelId)
    }
    case 'project_label_group': {
      const p = await sdk.createProjectLabel({ name: op.name, isGroup: true })
      return confirmed(op, p.success, p.projectLabelId)
    }
    case 'project_label': {
      const parentId = op.parentId ?? groups.project.get(op.group)
      if (!parentId) throw new Error(`project label group ${op.group} not found`)
      const p = await sdk.createProjectLabel({ name: op.name, parentId })
      return confirmed(op, p.success, p.projectLabelId)
    }
    case 'status': {
      const position = op.after ? await positionAfter(request, op.teamId, op.after.id) : undefined
      const p = await sdk.createWorkflowState({
        teamId: op.teamId,
        name: op.name,
        type: op.type,
        color: op.color,
        ...(position === undefined ? {} : { position }),
      })
      return confirmed(op, p.success, p.workflowStateId)
    }
    case 'template': {
      const p = await sdk.createTemplate({
        name: op.name,
        type: op.type,
        templateData: { title: '', description: op.description },
      })
      return confirmed(op, p.success, p.templateId)
    }
    case 'view': {
      const p = await sdk.createCustomView({
        name: op.name,
        filterData: op.filter as LinearDocument.IssueFilter,
        shared: true,
      })
      return confirmed(op, p.success, p.customViewId)
    }
  }
}

function confirmed(op: ApplyOp, success: boolean, id: string | undefined): string {
  if (!success || !id) throw new Error(`Linear did not confirm: ${describeOp(op)}`)
  return id
}

async function positionAfter(request: LinearRequest, teamId: string, afterId: string): Promise<number> {
  const data = await request<
    { workflowStates: { nodes: { id: string; position: number }[] } },
    { teamId: string }
  >(
    `query nsStatePositions($teamId: ID!) {
      workflowStates(first: ${PAGE_SIZE}, filter: { team: { id: { eq: $teamId } } }) { nodes { id position } }
    }`,
    { teamId },
  )
  const states = data.workflowStates.nodes
  const after = states.find((s) => s.id === afterId)
  if (!after) throw new Error(`status ${afterId} not found in team ${teamId}`)
  const next = Math.min(...states.map((s) => s.position).filter((p) => p > after.position))
  return Number.isFinite(next) ? (after.position + next) / 2 : after.position + 1
}

export async function readCustomViews(request: LinearRequest): Promise<LinearCustomView[]> {
  const views: LinearCustomView[] = []
  let after: string | null = null
  do {
    const data: { customViews: Page<LinearCustomView> } = await request(
      `query nsCustomViews($after: String) {
        customViews(first: ${PAGE_SIZE}, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } }
      }`,
      { after },
    )
    views.push(...data.customViews.nodes.map((v) => ({ id: v.id, name: v.name })))
    after = data.customViews.pageInfo.hasNextPage ? data.customViews.pageInfo.endCursor : null
  } while (after)
  return views
}
