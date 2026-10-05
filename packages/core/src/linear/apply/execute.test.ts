import { describe, expect, test } from 'bun:test'
import type { FetchFn, TokenProvider } from '../auth'
import { linearRequest } from '../client'
import { executeApply, readCustomViews } from './execute'
import { expectedObjects } from './expected'
import { type ApplyOp, planApply } from './plan'
import { basicWorkspace, testConfig } from './testing'

type Call = { operation: string; variables: Record<string, unknown> }
type Handler = (variables: Record<string, unknown>, calls: Call[]) => unknown

const auth: TokenProvider = {
  async authorization() {
    return 'Bearer t'
  },
  invalidate() {},
}

function fakeLinear(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  const fetch: FetchFn = async (_url, init) => {
    const { query, variables = {} } = JSON.parse(String(init.body)) as {
      query: string
      variables?: Record<string, unknown>
    }
    const operation = /\b(?:query|mutation) (\w+)/.exec(query)?.[1] ?? ''
    calls.push({ operation, variables })
    const handler = handlers[operation]
    try {
      if (!handler) throw new Error(`no fake for ${operation}`)
      return new Response(JSON.stringify({ data: handler(variables, calls) }))
    } catch (e) {
      return new Response(JSON.stringify({ errors: [{ message: (e as Error).message }] }))
    }
  }
  return { request: linearRequest({ auth, fetch }), calls }
}

const payload = (field: string, id: string, success = true) => ({ lastSyncId: 1, success, [field]: { id } })

const created = {
  createIssueLabel: (v: Record<string, unknown>) => ({
    issueLabelCreate: payload('issueLabel', `id-${(v.input as { name: string }).name}`),
  }),
  createProjectLabel: (v: Record<string, unknown>) => ({
    projectLabelCreate: payload('projectLabel', `id-${(v.input as { name: string }).name}`),
  }),
  createWorkflowState: (v: Record<string, unknown>) => ({
    workflowStateCreate: payload('workflowState', `id-${(v.input as { name: string }).name}`),
  }),
  createTemplate: (v: Record<string, unknown>) => ({
    templateCreate: payload('template', `id-${(v.input as { name: string }).name}`),
  }),
  createCustomView: (v: Record<string, unknown>) => ({
    customViewCreate: payload('customView', `id-${(v.input as { name: string }).name}`),
  }),
  nsStatePositions: (v: Record<string, unknown>) => {
    const key = String(v.teamId).replace('t-', '')
    return {
      workflowStates: {
        nodes: [
          { id: `${key}-In Progress`, position: 2 },
          { id: `${key}-Done`, position: 3 },
          { id: `${key}-In Review`, position: 1002 },
        ],
      },
    }
  },
}

const inputs = (calls: Call[], operation: string) =>
  calls.filter((c) => c.operation === operation).map((c) => c.variables.input)

const plan = () => planApply(basicWorkspace(), expectedObjects(testConfig(), basicWorkspace())).ops

describe('executeApply', () => {
  test('without confirm it is a dry run: no request, every op pending', async () => {
    const { request, calls } = fakeLinear({})
    const ops = plan()
    expect(await executeApply(ops, request)).toEqual({
      applied: false,
      created: [],
      failed: null,
      pending: ops,
    })
    expect(calls).toEqual([])
  })

  test('with confirm it creates every op in order and parents labels to the new group', async () => {
    const { request, calls } = fakeLinear(created)
    const ops = plan()
    const r = await executeApply(ops, request, { confirm: true })
    expect(r.applied).toBe(true)
    expect(r.failed).toBeNull()
    expect(r.created.map((c) => c.id)).toEqual(ops.map((op) => `id-${op.name}`))
    const labels = inputs(calls, 'createIssueLabel')
    expect(labels.slice(0, 3)).toEqual([
      { name: 'autopilot' },
      { name: 'ai-stage', isGroup: true },
      { name: 'intake', parentId: 'id-ai-stage' },
    ])
    expect(labels.map((l) => (l as { name: string }).name)).not.toContain('ai-merge')
  })

  test('a project label group is created before its labels, which are parented to it', async () => {
    const { request, calls } = fakeLinear(created)
    const ops = plan().filter((op) => op.kind === 'project_label_group' || op.kind === 'project_label')
    const r = await executeApply(ops, request, { confirm: true })
    expect(r.failed).toBeNull()
    expect(inputs(calls, 'createProjectLabel')).toEqual([
      { name: 'ai-merge', isGroup: true },
      { name: 'manual', parentId: 'id-ai-merge' },
      { name: 'auto', parentId: 'id-ai-merge' },
      { name: 'feature-branch', parentId: 'id-ai-merge' },
    ])
  })

  test('a project label failing mid-way reports the created group and the pending labels', async () => {
    const { request } = fakeLinear({
      ...created,
      createProjectLabel: (v, all) => {
        if (all.filter((c) => c.operation === 'createProjectLabel').length === 3) throw new Error('taken')
        return created.createProjectLabel(v)
      },
    })
    const ops = plan().filter((op) => op.kind === 'project_label_group' || op.kind === 'project_label')
    const r = await executeApply(ops, request, { confirm: true })
    expect(r.created.map((c) => c.id)).toEqual(['id-ai-merge', 'id-manual'])
    expect(r.failed?.op).toEqual(ops[2] as ApplyOp)
    expect(r.pending).toEqual(ops.slice(3))
  })

  test('a status is placed after its anchor: midpoint before the next status, otherwise one past it', async () => {
    const { request, calls } = fakeLinear(created)
    const status = (afterId: string): ApplyOp => ({
      kind: 'status',
      team: 'FRG',
      teamId: 't-FRG',
      name: 'Blocked',
      type: 'started',
      color: '#eb5757',
      after: { id: afterId, name: afterId, type: 'started' },
    })
    await executeApply([status('FRG-In Review'), status('FRG-In Progress')], request, { confirm: true })
    expect(inputs(calls, 'createWorkflowState')).toEqual([
      { teamId: 't-FRG', name: 'Blocked', type: 'started', color: '#eb5757', position: 1003 },
      { teamId: 't-FRG', name: 'Blocked', type: 'started', color: '#eb5757', position: 2.5 },
    ])
    expect(calls.find((c) => c.operation === 'nsStatePositions')?.variables).toEqual({ teamId: 't-FRG' })
  })

  test('templates carry the description and views are shared with their filter', async () => {
    const { request, calls } = fakeLinear(created)
    const ops = plan().filter((op) => op.kind === 'template' || op.kind === 'view')
    await executeApply(ops, request, { confirm: true })
    const [task] = inputs(calls, 'createTemplate') as { templateData: { description: string } }[]
    expect(task).toMatchObject({ name: 'Agent task', type: 'issue', templateData: { title: '' } })
    expect(task?.templateData.description).toStartWith('## Goal')
    expect(inputs(calls, 'createCustomView')[0]).toMatchObject({ name: 'Needs me', shared: true })
  })

  test('stops at the first error and reports what was created and what is left', async () => {
    const { request, calls } = fakeLinear({
      ...created,
      createIssueLabel: (v, all) => {
        if (all.filter((c) => c.operation === 'createIssueLabel').length === 2) {
          throw new Error('label name taken')
        }
        return created.createIssueLabel(v)
      },
    })
    const ops = plan()
    const r = await executeApply(ops, request, { confirm: true })
    expect(r.created.map((c) => c.id)).toEqual(['id-Blocked', 'id-Waiting', 'id-autopilot'])
    expect(r.failed?.op).toEqual(ops[3] as ApplyOp)
    expect(r.failed?.error).toContain('label name taken')
    expect(r.pending).toEqual(ops.slice(4))
    expect(calls.filter((c) => c.operation === 'createIssueLabel')).toHaveLength(2)
  })

  test('an unconfirmed payload is a failure', async () => {
    const { request } = fakeLinear({
      createIssueLabel: () => ({ issueLabelCreate: payload('issueLabel', 'x', false) }),
    })
    const r = await executeApply([{ kind: 'label_group', name: 'ai-stage' }], request, { confirm: true })
    expect(r.failed?.error).toBe('Linear did not confirm: create label group ai-stage')
    expect(r.created).toEqual([])
  })

  test('a re-plan after a successful apply creates nothing', async () => {
    const { request } = fakeLinear(created)
    const ws = basicWorkspace()
    const expected = expectedObjects(testConfig(), ws)
    const r = await executeApply(planApply(ws, expected).ops, request, { confirm: true })
    const groupId = (kind: string, name: string | null) =>
      r.created.find((c) => c.op.kind === kind && c.op.name === name)?.id ?? null
    for (const { op, id } of r.created) {
      if (op.kind === 'status') {
        ws.teams.find((t) => t.key === op.team)?.statuses.push({ id, name: op.name, type: op.type })
      }
      if (op.kind === 'label_group')
        ws.labels.push({ id, name: op.name, isGroup: true, parentId: null, teamId: null })
      if (op.kind === 'label') {
        ws.labels.push({
          id,
          name: op.name,
          isGroup: false,
          parentId: groupId('label_group', op.group),
          teamId: null,
        })
      }
      if (op.kind === 'project_label_group')
        ws.projectLabels.push({ id, name: op.name, isGroup: true, parentId: null, teamId: null })
      if (op.kind === 'project_label') {
        ws.projectLabels.push({
          id,
          name: op.name,
          isGroup: false,
          parentId: groupId('project_label_group', op.group),
          teamId: null,
        })
      }
      if (op.kind === 'template') ws.templates.push({ id, name: op.name, type: op.type, teamId: null })
      if (op.kind === 'view') ws.customViews?.push({ id, name: op.name })
    }
    expect(planApply(ws, expected).ops).toEqual([])
  })
})

describe('readCustomViews', () => {
  test('reads every page of custom views', async () => {
    const { request, calls } = fakeLinear({
      nsCustomViews: (v) => ({
        customViews:
          v.after === null
            ? { nodes: [{ id: 'v1', name: 'Bugs' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } }
            : { nodes: [{ id: 'v2', name: 'Rewrite' }], pageInfo: { hasNextPage: false, endCursor: null } },
      }),
    })
    expect(await readCustomViews(request)).toEqual([
      { id: 'v1', name: 'Bugs' },
      { id: 'v2', name: 'Rewrite' },
    ])
    expect(calls.map((c) => c.variables.after)).toEqual([null, 'c1'])
  })
})
