import { describe, expect, test } from 'bun:test'
import { type FetchFn, optInFilter, type TokenProvider } from '@nightshift/core'
import { FakeLinear, snapshot, testConfig } from '../../testing/testing'
import { createLinearPort } from './linear-adapter'

type Call = { operation: string; variables: Record<string, unknown> }
type Handler = (variables: Record<string, unknown>) => unknown

const auth: TokenProvider = {
  async authorization() {
    return 'Bearer t'
  },
  invalidate() {},
}

const conn = <T>(nodes: T[]) => ({
  nodes,
  pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
})

const status = (id: string, name: string, position: number) => ({
  id,
  name,
  type: 'started',
  position,
  team: { id: 't-FOR' },
})

const workspace: Record<string, Handler> = {
  organization: () => ({
    organization: { id: 'o', name: 'h-cloud', urlKey: 'h-cloud', subscription: null, projectStatuses: [] },
  }),
  teams: () => ({ teams: conn([{ id: 't-FOR', key: 'FOR', name: 'Forge', displayName: 'Forge' }]) }),
  workflowStates: () => ({
    workflowStates: conn([
      status('s-todo', 'Todo', 1),
      status('s-prog', 'In Progress', 2),
      status('s-blocked', 'Blocked', 3),
    ]),
  }),
  issueLabels: () => ({
    issueLabels: conn([
      { id: 'g-ai-stage', name: 'ai-stage', isGroup: true },
      { id: 'l-impl', name: 'implementation', isGroup: false, parent: { id: 'g-ai-stage' } },
      { id: 'l-verif', name: 'verification', isGroup: false, parent: { id: 'g-ai-stage' } },
    ]),
  }),
  projectLabels: () => ({ projectLabels: conn([]) }),
  projects: () => ({ projects: conn([]) }),
  projectMilestones: () => ({ projectMilestones: conn([]) }),
  initiatives: () => ({ initiatives: conn([]) }),
  templates: () => ({ templates: [] }),
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
    const handler = handlers[operation] ?? workspace[operation]
    if (!handler) return new Response(JSON.stringify({ errors: [{ message: `no fake for ${operation}` }] }))
    return new Response(JSON.stringify({ data: handler(variables) }))
  }
  const config = testConfig()
  return { port: createLinearPort({ config: () => config, auth, fetch }), calls }
}

const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })

const rawLabel = (id: string, name: string, group: string) => ({ id, name, parent: { name: group } })

const target = (labels: ReturnType<typeof rawLabel>[], state = 's-todo') => ({
  issue: { id: 'id-FOR-1', team: { key: 'FOR' }, state: { id: state }, labels: page(labels) },
})

const updates = (calls: Call[]) =>
  calls.filter((c) => c.operation === 'nsIssueUpdate').map((c) => c.variables.input)

describe('createLinearPort', () => {
  test('candidate reads do not require opt-in or perform writes', async () => {
    const { port, calls } = fakeLinear({ nsIssues: () => ({ issues: page([]) }) })
    expect(
      await port.candidates({ team: 'FOR', project: null, closedSince: '2026-01-01T00:00:00.000Z' }),
    ).toEqual([])
    expect(calls.map((c) => c.operation)).toEqual(['nsIssues'])
    expect(JSON.stringify(calls[0]?.variables.filter)).not.toMatch(/delegate|assignee|labels/)
  })

  test('fake candidates match team/project and closure window without writes', async () => {
    const linear = new FakeLinear(testConfig(), () => new Date('2026-02-01T00:00:00.000Z'))
    const since = '2026-01-01T00:00:00.000Z'
    linear.put(
      snapshot({ identifier: 'FOR-1', delegated: false, labels: [] }),
      snapshot({ identifier: 'FOR-2', status: 'Done', completedAt: since }),
      snapshot({ identifier: 'FOR-3', status: 'Canceled', canceledAt: since }),
      snapshot({ identifier: 'FOR-4', status: 'Done', completedAt: '2025-12-01T00:00:00.000Z' }),
      snapshot({ identifier: 'FOR-5', status: 'Done' }),
      snapshot({ identifier: 'FOR-6', project: null }),
      snapshot({ identifier: 'OTHER-1', team: 'OTHER' }),
    )
    expect(
      (await linear.candidates({ team: 'FOR', project: 'p-omni', closedSince: since })).map(
        (i) => i.identifier,
      ),
    ).toEqual(['FOR-1', 'FOR-2', 'FOR-3'])
    expect(linear.updates).toEqual([])
    expect(linear.threads.size).toBe(0)
    expect(linear.attachments.size).toBe(0)
  })

  test('issues returns snapshots of the managed teams', async () => {
    const { port, calls } = fakeLinear({
      nsIssues: () => ({
        issues: page([
          {
            id: 'id-FOR-1',
            identifier: 'FOR-1',
            title: 't',
            description: '## Goal',
            priority: 1,
            estimate: 2,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
            team: { key: 'FOR' },
            state: { name: 'Todo' },
            project: null,
            labels: page([rawLabel('l-impl', 'implementation', 'ai-stage')]),
            inverseRelations: page([]),
          },
        ]),
      }),
    })
    const issues = await port.issues({ updatedSince: '2026-01-01T00:00:00.000Z' })
    expect(issues.map((i) => [i.identifier, i.status, i.labels])).toEqual([
      ['FOR-1', 'Todo', ['ai-stage:implementation']],
    ])
    expect(calls[0]?.variables.filter).toEqual({
      and: [optInFilter(testConfig().linear.act_on), { updatedAt: { gte: '2026-01-01T00:00:00.000Z' } }],
    })
  })

  test('update maps the lifecycle to the team status and the stage to its group label', async () => {
    const { port, calls } = fakeLinear({
      nsIssueTarget: () => target([rawLabel('l-impl', 'implementation', 'ai-stage')]),
      nsIssueUpdate: () => ({ issueUpdate: { success: true } }),
    })
    await port.update('FOR-1', { status: 'running' })
    await port.update('FOR-1', { stage: 'verification' })
    expect(updates(calls)).toEqual([
      { stateId: 's-prog' },
      { addedLabelIds: ['l-verif'], removedLabelIds: ['l-impl'] },
    ])
  })

  test('update of an issue already in the wanted state sends nothing', async () => {
    const { port, calls } = fakeLinear({
      nsIssueTarget: () => target([rawLabel('l-impl', 'implementation', 'ai-stage')], 's-blocked'),
    })
    await port.update('FOR-1', { status: 'blocked', stage: 'implementation' })
    expect(updates(calls)).toEqual([])
  })

  test('lastChange maps the history actor and app flag', async () => {
    const { port, calls } = fakeLinear({
      nsIssueHistory: () => ({
        issue: {
          history: page([
            {
              createdAt: '2026-01-02T00:00:00.000Z',
              actor: { name: 'nightshift', app: true },
              botActor: null,
              toState: { name: 'In Progress' },
              addedLabels: [rawLabel('l-impl', 'implementation', 'ai-stage')],
              removedLabels: [],
            },
          ]),
        },
      }),
    })
    expect(await port.lastChange('FOR-1')).toEqual({
      actor: 'nightshift',
      app: true,
      at: '2026-01-02T00:00:00.000Z',
      status: 'In Progress',
      labels: ['ai-stage:implementation'],
    })
    expect(calls.map((c) => c.operation)).toEqual(['nsIssueHistory'])
  })

  test('fake lastChange records its own writes as app changes and is null otherwise', async () => {
    const linear = new FakeLinear(testConfig(), () => new Date('2026-02-01T00:00:00.000Z'))
    linear.put(snapshot({ identifier: 'FOR-1' }))
    expect(await linear.lastChange('FOR-1')).toBeNull()
    await linear.update('FOR-1', { status: 'running', stage: 'verification' })
    expect(await linear.lastChange('FOR-1')).toEqual({
      actor: 'nightshift',
      app: true,
      at: '2026-02-01T00:00:00.000Z',
      status: 'In Progress',
      labels: ['ai-stage:verification'],
    })
    linear.changes.set('FOR-1', { actor: 'You', app: false, at: '2026-02-01T00:00:01.000Z', status: 'Todo' })
    expect((await linear.lastChange('FOR-1'))?.actor).toBe('You')
  })

  test('comment is idempotent by marker and replies keep their parent', async () => {
    const posted: Record<string, unknown>[] = []
    const { port } = fakeLinear({
      nsIssueComments: () => ({
        issue: {
          id: 'id-FOR-1',
          comments: page(
            posted.map((input, i) => ({
              id: `c${i}`,
              body: input.body,
              createdAt: '2026-01-01T00:00:00.000Z',
              parent: input.parentId ? { id: input.parentId } : null,
              user: { name: 'nightshift' },
              botActor: null,
              externalUser: null,
            })),
          ),
        },
      }),
      nsCommentCreate: (v) => {
        const input = v.input as Record<string, unknown>
        posted.push(input)
        return {
          commentCreate: {
            success: true,
            comment: {
              id: `c${posted.length - 1}`,
              body: input.body,
              createdAt: '2026-01-01T00:00:00.000Z',
              parent: input.parentId ? { id: input.parentId } : null,
              user: { name: 'nightshift' },
              botActor: null,
              externalUser: null,
            },
          },
        }
      },
    })
    const first = await port.comment('FOR-1', 'hi\n\n<!-- nightshift:01J -->', { parentId: 'q1' })
    const again = await port.comment('FOR-1', 'hi\n\n<!-- nightshift:01J -->', { parentId: 'q1' })
    expect(again).toEqual(first)
    expect(first.parentId).toBe('q1')
    expect(posted).toHaveLength(1)
    expect((await port.comments('FOR-1')).map((c) => c.id)).toEqual(['c0'])
  })
})
