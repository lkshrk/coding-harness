import { describe, expect, test } from 'bun:test'
import { LinearError } from '@linear/sdk'
import { type FetchFn, LinearAuthError, type TokenProvider } from './auth'
import { createLinearReader, LINEAR_API_URL, linearRequest } from './client'

type GqlCall = { url: string; authorization: string; operation: string; variables: Record<string, unknown> }
type Handler = (variables: Record<string, unknown>) => { status?: number; body: unknown }

function fakeLinear(handlers: Record<string, Handler>): { fetch: FetchFn; calls: GqlCall[] } {
  const calls: GqlCall[] = []
  const fetch: FetchFn = async (url, init) => {
    const { query, variables = {} } = JSON.parse(String(init.body)) as {
      query: string
      variables?: Record<string, unknown>
    }
    const operation = /\b(?:query|mutation) (\w+)/.exec(query)?.[1] ?? ''
    const headers = new Headers(init.headers)
    calls.push({ url, authorization: headers.get('authorization') ?? '', operation, variables })
    const handler = handlers[operation]
    if (!handler) return new Response(JSON.stringify({ errors: [{ message: `no fake for ${operation}` }] }))
    const { status = 200, body } = handler(variables)
    return new Response(JSON.stringify(body), { status })
  }
  return { fetch, calls }
}

function fakeAuth(tokens: string[]): TokenProvider & { invalidations: number } {
  let i = 0
  return {
    invalidations: 0,
    async authorization() {
      return `Bearer ${tokens[Math.min(i, tokens.length - 1)]}`
    },
    invalidate() {
      this.invalidations++
      i++
    },
  }
}

const unauthenticated = {
  status: 401,
  body: {
    errors: [
      {
        message: 'Authentication required, not authenticated',
        extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR', statusCode: 401 },
      },
    ],
  },
}

const page = <T>(nodes: T[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, hasPreviousPage: false, startCursor: null, endCursor },
})

describe('linearRequest', () => {
  test('posts the document with the provider authorization and returns data', async () => {
    const { fetch, calls } = fakeLinear({
      viewer: () => ({ body: { data: { viewer: { id: 'u1' } } } }),
    })
    const request = linearRequest({ auth: fakeAuth(['t1']), fetch })
    const data = await request<{ viewer: { id: string } }, Record<string, unknown>>(
      'query viewer { viewer { id } }',
    )
    expect(data).toEqual({ viewer: { id: 'u1' } })
    expect(calls[0]).toMatchObject({ url: LINEAR_API_URL, authorization: 'Bearer t1', operation: 'viewer' })
  })

  test('a 401 invalidates the token and retries once with a new one', async () => {
    const { fetch, calls } = fakeLinear({
      viewer: () => (calls.length === 1 ? unauthenticated : { body: { data: { viewer: { id: 'u1' } } } }),
    })
    const auth = fakeAuth(['old', 'new'])
    const data = await linearRequest({ auth, fetch })('query viewer { viewer { id } }')
    expect(data).toEqual({ viewer: { id: 'u1' } })
    expect(auth.invalidations).toBe(1)
    expect(calls.map((c) => c.authorization)).toEqual(['Bearer old', 'Bearer new'])
  })

  test('a second 401 is an authentication error, not another retry', async () => {
    const { fetch, calls } = fakeLinear({ viewer: () => unauthenticated })
    const request = linearRequest({ auth: fakeAuth(['a', 'b', 'c']), fetch })
    await expect(request('query viewer { viewer { id } }')).rejects.toThrow(
      new LinearAuthError('linear.auth: Linear rejected the credentials'),
    )
    expect(calls).toHaveLength(2)
  })

  test('GraphQL errors surface as Linear SDK errors', async () => {
    const { fetch } = fakeLinear({
      viewer: () => ({
        status: 400,
        body: { errors: [{ message: 'Field does not exist', extensions: { type: 'graphql error' } }] },
      }),
    })
    const request = linearRequest({ auth: fakeAuth(['t']), fetch })
    await expect(request('query viewer { nope }')).rejects.toBeInstanceOf(LinearError)
    await expect(request('query viewer { nope }')).rejects.toThrow('Field does not exist')
  })
})

const team = (id: string, key: string, name: string) => ({ id, key, name, displayName: name })

function workspaceHandlers(): Record<string, Handler> {
  return {
    organization: () => ({
      body: {
        data: {
          organization: {
            id: 'org1',
            name: 'h-cloud',
            urlKey: 'h-cloud',
            subscription: { id: 's1', type: 'basic', seats: 1 },
            projectStatuses: [],
          },
        },
      },
    }),
    teams: () => ({
      body: { data: { teams: page([team('t2', 'CIV', 'Civora'), team('t1', 'FOR', 'Forge')]) } },
    }),
    workflowStates: (v) => ({
      body: {
        data: {
          workflowStates:
            v.after === 'c1'
              ? page([{ id: 's3', name: 'Todo', type: 'unstarted', position: 1, team: { id: 't1' } }])
              : page(
                  [
                    { id: 's2', name: 'Done', type: 'completed', position: 3, team: { id: 't1' } },
                    { id: 's1', name: 'Backlog', type: 'backlog', position: 0, team: { id: 't1' } },
                    { id: 's4', name: 'Triage', type: 'triage', position: 0, team: { id: 't2' } },
                  ],
                  'c1',
                ),
        },
      },
    }),
    issueLabels: () => ({
      body: {
        data: {
          issueLabels: page([
            { id: 'l1', name: 'ai-stage', isGroup: true },
            { id: 'l2', name: 'implementation', isGroup: false, parent: { id: 'l1' } },
            { id: 'l3', name: 'Bug', isGroup: false, team: { id: 't1' } },
          ]),
        },
      },
    }),
    projectLabels: (v) => ({
      body: {
        data: {
          projectLabels:
            v.after === 'pl1'
              ? page([{ id: 'pl2', name: 'manual', isGroup: false, parent: { id: 'pl1' } }])
              : page([{ id: 'pl1', name: 'ai-merge', isGroup: true }], 'pl1'),
        },
      },
    }),
    projects: () => ({
      body: {
        data: {
          projects: page([
            { id: 'p1', name: 'Omni', state: 'started' },
            { id: 'p2', name: 'Cluster', state: 'backlog' },
          ]),
        },
      },
    }),
    projectMilestones: () => ({
      body: {
        data: {
          projectMilestones: page([
            { id: 'm2', name: 'UI wired', sortOrder: 2, project: { id: 'p1' } },
            { id: 'm1', name: 'API ready', sortOrder: 1, project: { id: 'p1' } },
          ]),
        },
      },
    }),
    initiatives: () => ({ body: { data: { initiatives: page([{ id: 'i1', name: 'Omni' }]) } } }),
    templates: () => ({
      body: {
        data: {
          templates: [
            { id: 'tp1', name: 'Feature', type: 'project' },
            { id: 'tp2', name: 'Bug', type: 'issue', team: { id: 't1' } },
          ],
        },
      },
    }),
  }
}

describe('LinearReader.workspace', () => {
  test('builds a plain read model across pages', async () => {
    const { fetch } = fakeLinear(workspaceHandlers())
    const ws = await createLinearReader({ auth: fakeAuth(['t']), fetch }).workspace()
    expect(ws).toEqual({
      organization: { id: 'org1', name: 'h-cloud', urlKey: 'h-cloud', plan: 'basic' },
      teams: [
        {
          id: 't2',
          key: 'CIV',
          name: 'Civora',
          statuses: [{ id: 's4', name: 'Triage', type: 'triage' }],
        },
        {
          id: 't1',
          key: 'FOR',
          name: 'Forge',
          statuses: [
            { id: 's1', name: 'Backlog', type: 'backlog' },
            { id: 's3', name: 'Todo', type: 'unstarted' },
            { id: 's2', name: 'Done', type: 'completed' },
          ],
        },
      ],
      labels: [
        { id: 'l1', name: 'ai-stage', isGroup: true, parentId: null, teamId: null },
        { id: 'l2', name: 'implementation', isGroup: false, parentId: 'l1', teamId: null },
        { id: 'l3', name: 'Bug', isGroup: false, parentId: null, teamId: 't1' },
      ],
      projectLabels: [
        { id: 'pl1', name: 'ai-merge', isGroup: true, parentId: null, teamId: null },
        { id: 'pl2', name: 'manual', isGroup: false, parentId: 'pl1', teamId: null },
      ],
      projects: [
        {
          id: 'p1',
          name: 'Omni',
          state: 'started',
          milestones: [
            { id: 'm1', name: 'API ready' },
            { id: 'm2', name: 'UI wired' },
          ],
        },
        { id: 'p2', name: 'Cluster', state: 'backlog', milestones: [] },
      ],
      initiatives: [{ id: 'i1', name: 'Omni' }],
      templates: [
        { id: 'tp1', name: 'Feature', type: 'project', teamId: null },
        { id: 'tp2', name: 'Bug', type: 'issue', teamId: 't1' },
      ],
    })
    expect(JSON.parse(JSON.stringify(ws))).toEqual(ws)
  })

  test('project labels are read across pages', async () => {
    const { fetch, calls } = fakeLinear(workspaceHandlers())
    const ws = await createLinearReader({ auth: fakeAuth(['t']), fetch }).workspace()
    expect(ws.projectLabels.map((l) => l.id)).toEqual(['pl1', 'pl2'])
    expect(calls.filter((c) => c.operation === 'projectLabels').map((c) => c.variables.after)).toEqual([
      undefined,
      'pl1',
    ])
  })

  test('a workspace without a readable subscription has plan null', async () => {
    const handlers = workspaceHandlers()
    handlers.organization = () => ({
      body: {
        data: {
          organization: {
            id: 'org1',
            name: 'h-cloud',
            urlKey: 'h-cloud',
            subscription: null,
            projectStatuses: [],
          },
        },
      },
    })
    const { fetch } = fakeLinear(handlers)
    const ws = await createLinearReader({ auth: fakeAuth(['t']), fetch }).workspace()
    expect(ws.organization.plan).toBeNull()
  })

  test('initiatives the token may not read are null, not a failure', async () => {
    const handlers = workspaceHandlers()
    handlers.initiatives = () => ({
      status: 400,
      body: {
        errors: [
          {
            message: 'Invalid scope: `initiative:read` or `initiative:write` required',
            extensions: { type: 'forbidden', code: 'FORBIDDEN' },
          },
        ],
      },
    })
    const { fetch } = fakeLinear(handlers)
    const ws = await createLinearReader({ auth: fakeAuth(['t']), fetch }).workspace()
    expect(ws.initiatives).toBeNull()
    expect(ws.teams).toHaveLength(2)
  })

  test('other errors while reading initiatives still fail', async () => {
    const handlers = workspaceHandlers()
    handlers.initiatives = () => ({ status: 500, body: { errors: [{ message: 'boom' }] } })
    const { fetch } = fakeLinear(handlers)
    await expect(createLinearReader({ auth: fakeAuth(['t']), fetch }).workspace()).rejects.toThrow('boom')
  })

  test('only reads, never mutates', async () => {
    const { fetch, calls } = fakeLinear(workspaceHandlers())
    await createLinearReader({ auth: fakeAuth(['t']), fetch }).workspace()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => !c.operation.includes('Create') && !c.operation.includes('Update'))).toBe(true)
  })
})

describe('LinearReader', () => {
  test('viewer reports the app actor', async () => {
    const { fetch } = fakeLinear({
      viewer: () => ({
        body: { data: { viewer: { id: 'u1', name: 'Nightshift', displayName: 'nightshift', app: true } } },
      }),
    })
    const viewer = await createLinearReader({ auth: fakeAuth(['t']), fetch }).viewer()
    expect(viewer).toEqual({ id: 'u1', name: 'Nightshift', displayName: 'nightshift', app: true })
  })

  test('blockingRelations splits blocks and blockedBy, ignoring other relation types', async () => {
    const { fetch } = fakeLinear({
      issue_relations: () => ({
        body: {
          data: {
            issue: {
              relations: page([
                { id: 'r1', type: 'blocks', issue: { id: 'i1' }, relatedIssue: { id: 'i2' } },
                { id: 'r2', type: 'related', issue: { id: 'i1' }, relatedIssue: { id: 'i3' } },
              ]),
            },
          },
        },
      }),
      issue_inverseRelations: () => ({
        body: {
          data: {
            issue: {
              inverseRelations: page([
                { id: 'r3', type: 'blocks', issue: { id: 'i4' }, relatedIssue: { id: 'i1' } },
                { id: 'r4', type: 'duplicate', issue: { id: 'i5' }, relatedIssue: { id: 'i1' } },
              ]),
            },
          },
        },
      }),
    })
    const rel = await createLinearReader({ auth: fakeAuth(['t']), fetch }).blockingRelations('FOR-1')
    expect(rel).toEqual({ blocks: ['i2'], blockedBy: ['i4'] })
  })
})
