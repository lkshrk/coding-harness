import { describe, expect, test } from 'bun:test'
import type { FetchFn, TokenProvider } from './auth'
import { linearRequest } from './client'
import { LinearIssueReader } from './issues'

type Call = { operation: string; variables: Record<string, unknown>; query: string }
type Handler = (variables: Record<string, unknown>) => unknown

const auth: TokenProvider = {
  async authorization() {
    return 'Bearer t'
  },
  invalidate() {},
}

function fakeLinear(handlers: Record<string, Handler>, now?: () => number) {
  const calls: Call[] = []
  const fetch: FetchFn = async (_url, init) => {
    const { query, variables = {} } = JSON.parse(String(init.body)) as {
      query: string
      variables?: Record<string, unknown>
    }
    const operation = /\b(?:query|mutation) (\w+)/.exec(query)?.[1] ?? ''
    calls.push({ operation, variables, query })
    const handler = handlers[operation]
    try {
      if (!handler) throw new Error(`no fake for ${operation}`)
      return new Response(JSON.stringify({ data: handler(variables) }))
    } catch (e) {
      return new Response(JSON.stringify({ errors: [{ message: (e as Error).message }] }), { status: 400 })
    }
  }
  return { reader: new LinearIssueReader(linearRequest({ auth, fetch }), now), calls }
}

const conn = <T>(nodes: T[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
})

const label = (id: string, name: string, group?: string) => ({
  id,
  name,
  parent: group ? { name: group } : null,
})

const blocker = (identifier: string, status: string, type = 'blocks') => ({
  type,
  issue: { identifier, team: { key: identifier.split('-')[0] }, state: { name: status } },
})

function rawIssue(identifier: string, over: Record<string, unknown> = {}) {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `issue ${identifier}`,
    description: null,
    priority: 2,
    estimate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    team: { key: identifier.split('-')[0] },
    state: { name: 'Todo' },
    project: null,
    delegate: null,
    assignee: null,
    labels: conn([]),
    inverseRelations: conn([]),
    ...over,
  }
}

const actOn = { delegated: true, labels: ['autopilot', 'ai-ready'] }
const optIn = {
  or: [
    { delegate: { isMe: { eq: true } } },
    { assignee: { isMe: { eq: true } } },
    { labels: { some: { name: { eqIgnoreCase: 'autopilot' } } } },
    { labels: { some: { name: { eqIgnoreCase: 'ai-ready' } } } },
  ],
}

describe('LinearIssueReader.issues', () => {
  test('manual mode (no route) sends no query and returns nothing', async () => {
    const { reader, calls } = fakeLinear({})
    expect(await reader.issues({ actOn: { delegated: false, labels: [] } })).toEqual([])
    expect(calls).toEqual([])
  })

  test('an issue delegated or assigned to the app is marked delegated; labels-only opt-in drops those routes', async () => {
    const { reader, calls } = fakeLinear({
      nsIssues: () => ({
        issues: conn([
          rawIssue('FOR-7', { delegate: { isMe: true } }),
          rawIssue('FOR-8', { assignee: { isMe: true } }),
          rawIssue('FOR-9', { assignee: { isMe: false } }),
        ]),
      }),
    })
    const issues = await reader.issues({ actOn })
    expect(issues.map((i) => [i.identifier, i.delegated])).toEqual([
      ['FOR-7', true],
      ['FOR-8', true],
      ['FOR-9', false],
    ])
    await reader.issues({ actOn: { delegated: false, labels: ['autopilot'] } })
    expect(calls.at(-1)?.variables.filter).toEqual({
      and: [{ or: [{ labels: { some: { name: { eqIgnoreCase: 'autopilot' } } } }] }],
    })
  })

  test('maps issues to snapshots with grouped labels, blockers and projects', async () => {
    const { reader, calls } = fakeLinear({
      nsIssues: () => ({
        issues: conn([
          rawIssue('FOR-1', {
            description: '## Goal',
            estimate: 3,
            project: { id: 'p1' },
            labels: conn([
              label('l1', 'implementation', 'ai-stage'),
              label('l2', 'Bug', 'Type'),
              label('l3', 'ux'),
            ]),
            inverseRelations: conn([blocker('CIV-3', 'Done'), blocker('FOR-9', 'Todo', 'related')]),
          }),
        ]),
      }),
      nsProjects: () => ({
        projects: conn([
          {
            id: 'p1',
            name: 'Omni',
            labels: conn([label('pl1', 'auto', 'ai-merge')]),
            initiatives: conn([{ name: 'Omni' }]),
          },
        ]),
      }),
    })
    const issues = await reader.issues({ actOn })
    expect(issues).toEqual([
      {
        id: 'id-FOR-1',
        identifier: 'FOR-1',
        title: 'issue FOR-1',
        team: 'FOR',
        status: 'Todo',
        labels: ['ai-stage:implementation', 'type:Bug', 'ux'],
        delegated: false,
        project: { id: 'p1', name: 'Omni', initiatives: ['Omni'], labels: ['ai-merge:auto'] },
        priority: 2,
        estimate: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        description: '## Goal',
        blockedBy: [{ identifier: 'CIV-3', team: 'CIV', status: 'Done' }],
      },
    ])
    expect(calls[0]?.variables.filter).toEqual({ and: [optIn] })
    expect(calls[1]?.variables.ids).toEqual(['p1'])
    expect(calls[1]?.variables.first).toBe(1)
  })

  test('reuses project details for ten minutes', async () => {
    let t = 0
    const { reader, calls } = fakeLinear(
      {
        nsIssue: () => ({ issue: rawIssue('FOR-1', { project: { id: 'p1' } }) }),
        nsProjects: () => ({
          projects: conn([{ id: 'p1', name: 'Omni', labels: conn([]), initiatives: conn([]) }]),
        }),
      },
      () => t,
    )
    const projectReads = () => calls.filter((c) => c.operation === 'nsProjects').length
    expect((await reader.issue('FOR-1'))?.project?.name).toBe('Omni')
    t += 9 * 60_000
    expect((await reader.issue('FOR-1'))?.project?.name).toBe('Omni')
    expect(projectReads()).toBe(1)
    t += 2 * 60_000
    await reader.issue('FOR-1')
    expect(projectReads()).toBe(2)
  })

  test('filters by updatedSince and follows every page', async () => {
    const { reader, calls } = fakeLinear({
      nsIssues: (v) =>
        v.after === 'c1'
          ? { issues: conn([rawIssue('FOR-2')]) }
          : { issues: conn([rawIssue('FOR-1')], 'c1') },
    })
    const issues = await reader.issues({ actOn, updatedSince: '2026-01-01T00:00:00.000Z' })
    expect(issues.map((i) => i.identifier)).toEqual(['FOR-1', 'FOR-2'])
    expect(calls.map((c) => c.variables.after)).toEqual([null, 'c1'])
    expect(calls[0]?.variables.filter).toEqual({
      and: [optIn, { updatedAt: { gte: '2026-01-01T00:00:00.000Z' } }],
    })
    expect(calls.some((c) => c.operation === 'nsProjects')).toBe(false)
  })

  test('fetches nested labels and blockers beyond the first page', async () => {
    const { reader, calls } = fakeLinear({
      nsIssues: () => ({
        issues: conn([
          rawIssue('FOR-1', {
            labels: conn([label('l1', 'a')], 'lc1'),
            inverseRelations: conn([blocker('FOR-2', 'Todo')], 'rc1'),
          }),
        ]),
      }),
      nsIssueLabels: (v) => ({
        issue: {
          labels: v.after === 'lc1' ? conn([label('l2', 'b')], 'lc2') : conn([label('l3', 'c')]),
        },
      }),
      nsIssueBlockers: () => ({ issue: { inverseRelations: conn([blocker('FOR-3', 'Done')]) } }),
    })
    const [issue] = await reader.issues({ actOn })
    expect(issue?.labels).toEqual(['a', 'b', 'c'])
    expect(issue?.blockedBy.map((b) => b.identifier)).toEqual(['FOR-2', 'FOR-3'])
    expect(calls.filter((c) => c.operation === 'nsIssueLabels').map((c) => c.variables)).toEqual([
      { id: 'id-FOR-1', after: 'lc1' },
      { id: 'id-FOR-1', after: 'lc2' },
    ])
  })

  test('fetches project labels and initiatives beyond the first page', async () => {
    const { reader } = fakeLinear({
      nsIssues: () => ({ issues: conn([rawIssue('FOR-1', { project: { id: 'p1' } })]) }),
      nsProjects: () => ({
        projects: conn([
          {
            id: 'p1',
            name: 'Omni',
            labels: conn([label('pl1', 'auto', 'ai-merge')], 'x'),
            initiatives: conn([{ name: 'A' }], 'y'),
          },
        ]),
      }),
      nsProjectLabels: () => ({ project: { labels: conn([label('pl2', 'web')]) } }),
      nsProjectInitiatives: () => ({ project: { initiatives: conn([{ name: 'B' }]) } }),
    })
    const [issue] = await reader.issues({ actOn })
    expect(issue?.project).toEqual({
      id: 'p1',
      name: 'Omni',
      initiatives: ['A', 'B'],
      labels: ['ai-merge:auto', 'web'],
    })
  })

  test('a too-complex query halves the page size and retries the same page', async () => {
    let rejected = false
    const { reader, calls } = fakeLinear({
      nsIssues: (v) => {
        if (!rejected) {
          rejected = true
          throw new Error('Query too complex')
        }
        return { issues: conn([rawIssue(`FOR-${v.first}`)]) }
      },
    })
    const issues = await reader.issues({ actOn })
    expect(issues.map((i) => i.identifier)).toEqual(['FOR-12'])
    expect(calls.map((c) => c.variables.first)).toEqual([25, 12])
  })

  test('other errors are not retried', async () => {
    const { reader, calls } = fakeLinear({
      nsIssues: () => {
        throw new Error('Field does not exist')
      },
    })
    await expect(reader.issues({ actOn })).rejects.toThrow('Field does not exist')
    expect(calls).toHaveLength(1)
  })

  test('queries stay inside the complexity budget', async () => {
    const { reader, calls } = fakeLinear({ nsIssues: () => ({ issues: conn([]) }) })
    await reader.issues({ actOn })
    expect(calls[0]?.query).toContain('labels(first: 20')
    expect(calls[0]?.query).toContain('inverseRelations(first: 20')
    expect(calls[0]?.variables.first).toBe(25)
  })
})

describe('LinearIssueReader.candidates', () => {
  test('reads all pages without opt-in and filters scope and actual closure dates', async () => {
    const since = '2026-01-01T00:00:00.000Z'
    const { reader, calls } = fakeLinear({
      nsIssues: (v) => ({
        issues: v.after
          ? conn([
              rawIssue('FOR-2', { state: { name: 'Shipped', type: 'completed' }, completedAt: since }),
              rawIssue('FOR-3', { state: { name: 'Dropped', type: 'canceled' }, canceledAt: since }),
              rawIssue('FOR-4', {
                state: { name: 'Done', type: 'completed' },
                completedAt: '2025-12-31T23:59:59.999Z',
              }),
              rawIssue('FOR-5', { state: { name: 'Done', type: 'completed' } }),
              rawIssue('OTHER-1'),
              rawIssue('FOR-6', { project: { id: 'other' } }),
            ])
          : conn([rawIssue('FOR-1', { state: { name: 'Todo', type: 'unstarted' } })], 'next'),
      }),
    })
    const result = await reader.candidates({ team: 'FOR', project: null, closedSince: since })
    expect(result.map((i) => i.identifier)).toEqual(['FOR-1', 'FOR-2', 'FOR-3'])
    expect(result[1]).toMatchObject({ stateType: 'completed', completedAt: since })
    expect(calls.map((c) => c.variables.after)).toEqual([null, 'next'])
    expect(calls[0]?.variables.filter).toEqual({
      and: [
        { team: { key: { eq: 'FOR' } } },
        { project: { null: true } },
        {
          or: [
            { state: { type: { nin: ['completed', 'canceled'] } } },
            { state: { type: { eq: 'completed' } }, completedAt: { gte: since } },
            { state: { type: { eq: 'canceled' } }, canceledAt: { gte: since } },
          ],
        },
      ],
    })
    expect(calls.every((c) => c.query.startsWith('query '))).toBe(true)
  })

  test('filters an assigned project by ID', async () => {
    const { reader, calls } = fakeLinear({ nsIssues: () => ({ issues: conn([]) }) })
    await reader.candidates({ team: 'FOR', project: 'p1', closedSince: '2026-01-01T00:00:00.000Z' })
    expect(calls[0]?.variables.filter).toMatchObject({
      and: [{ team: { key: { eq: 'FOR' } } }, { project: { id: { eq: 'p1' } } }, expect.anything()],
    })
  })
})

describe('LinearIssueReader.issue', () => {
  test('reads one issue by identifier', async () => {
    const { reader, calls } = fakeLinear({ nsIssue: () => ({ issue: rawIssue('FOR-1') }) })
    expect((await reader.issue('FOR-1'))?.identifier).toBe('FOR-1')
    expect(calls[0]?.variables).toEqual({ id: 'FOR-1' })
  })

  test('an unknown issue is null', async () => {
    const { reader } = fakeLinear({
      nsIssue: () => {
        throw new Error('Entity not found: Issue')
      },
    })
    expect(await reader.issue('FOR-999')).toBeNull()
  })
})

describe('LinearIssueReader.comments', () => {
  const comment = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
    id,
    body: `body ${id}`,
    createdAt,
    parent: null,
    user: { name: 'nightshift' },
    botActor: null,
    externalUser: null,
    ...over,
  })

  test('returns the whole thread oldest first with parent and author', async () => {
    const { reader } = fakeLinear({
      nsIssueComments: (v) => ({
        issue: {
          id: 'id-FOR-1',
          comments:
            v.after === 'k'
              ? conn([comment('c1', '2026-01-01T00:00:00.000Z')])
              : conn(
                  [
                    comment('c3', '2026-01-03T00:00:00.000Z', { user: null, botActor: { name: 'GitHub' } }),
                    comment('c2', '2026-01-02T00:00:00.000Z', {
                      parent: { id: 'c1' },
                      user: { name: 'You' },
                    }),
                  ],
                  'k',
                ),
        },
      }),
    })
    expect(await reader.comments('FOR-1')).toEqual([
      { id: 'c1', body: 'body c1', createdAt: '2026-01-01T00:00:00.000Z', parentId: null, by: 'nightshift' },
      { id: 'c2', body: 'body c2', createdAt: '2026-01-02T00:00:00.000Z', parentId: 'c1', by: 'You' },
      { id: 'c3', body: 'body c3', createdAt: '2026-01-03T00:00:00.000Z', parentId: null, by: 'GitHub' },
    ])
  })

  test('an unknown issue has no comments', async () => {
    const { reader } = fakeLinear({
      nsIssueComments: () => {
        throw new Error('Entity not found: Issue')
      },
    })
    expect(await reader.comments('FOR-999')).toEqual([])
  })
})

describe('LinearIssueReader.lastChange', () => {
  const entry = (createdAt: string, over: Record<string, unknown> = {}) => ({
    createdAt,
    actor: null,
    botActor: null,
    toState: null,
    addedLabels: null,
    removedLabels: null,
    ...over,
  })

  test('returns the newest status change with its actor', async () => {
    const { reader, calls } = fakeLinear({
      nsIssueHistory: () => ({
        issue: {
          history: conn([
            entry('2026-01-03T00:00:00.000Z', { actor: { name: 'You', app: false }, toTitle: 'x' }),
            entry('2026-01-02T00:00:00.000Z', {
              actor: { name: 'You', app: false },
              toState: { name: 'In Progress' },
            }),
            entry('2026-01-01T00:00:00.000Z', {
              actor: { name: 'nightshift', app: true },
              toState: { name: 'Todo' },
            }),
          ]),
        },
      }),
    })
    expect(await reader.lastChange('FOR-1')).toEqual({
      actor: 'You',
      app: false,
      at: '2026-01-02T00:00:00.000Z',
      status: 'In Progress',
    })
    expect(calls.map((c) => c.variables)).toEqual([{ id: 'FOR-1', after: null }])
    expect(calls[0]?.query).toContain('history(first: 5')
  })

  test('returns a label-only change with the added grouped labels', async () => {
    const { reader } = fakeLinear({
      nsIssueHistory: () => ({
        issue: {
          history: conn([
            entry('2026-01-02T00:00:00.000Z', {
              actor: { name: 'nightshift', app: true },
              addedLabels: [label('l1', 'verification', 'ai-stage')],
              removedLabels: [label('l2', 'implementation', 'ai-stage')],
            }),
          ]),
        },
      }),
    })
    expect(await reader.lastChange('FOR-1')).toEqual({
      actor: 'nightshift',
      app: true,
      at: '2026-01-02T00:00:00.000Z',
      labels: ['ai-stage:verification'],
    })
  })

  test('pages past five unrelated entries to the newest status or label change', async () => {
    const { reader, calls } = fakeLinear({
      nsIssueHistory: (v) => ({
        issue: {
          history:
            v.after === 'h1'
              ? conn([
                  entry('2026-01-01T00:00:00.000Z', {
                    actor: { name: 'You', app: false },
                    toState: { name: 'Blocked' },
                  }),
                ])
              : conn(
                  [5, 4, 3, 2, 1].map((n) =>
                    entry(`2026-01-0${n + 1}T00:00:00.000Z`, { actor: { name: 'You', app: false } }),
                  ),
                  'h1',
                ),
        },
      }),
    })
    expect(await reader.lastChange('FOR-1')).toEqual({
      actor: 'You',
      app: false,
      at: '2026-01-01T00:00:00.000Z',
      status: 'Blocked',
    })
    expect(calls.map((c) => c.variables)).toEqual([
      { id: 'FOR-1', after: null },
      { id: 'FOR-1', after: 'h1' },
    ])
  })

  test('stops after the first page that holds a change', async () => {
    const { reader, calls } = fakeLinear({
      nsIssueHistory: () => ({
        issue: {
          history: conn(
            [
              entry('2026-01-02T00:00:00.000Z', {
                actor: { name: 'You', app: false },
                toState: { name: 'Done' },
              }),
            ],
            'h1',
          ),
        },
      }),
    })
    expect((await reader.lastChange('FOR-1'))?.status).toBe('Done')
    expect(calls).toHaveLength(1)
  })

  test('an integration bot counts as an app', async () => {
    const { reader } = fakeLinear({
      nsIssueHistory: () => ({
        issue: {
          history: conn([
            entry('2026-01-02T00:00:00.000Z', { botActor: { name: 'GitHub' }, toState: { name: 'Done' } }),
          ]),
        },
      }),
    })
    expect(await reader.lastChange('FOR-1')).toMatchObject({ actor: 'GitHub', app: true, status: 'Done' })
  })

  test('is null without a status or label change or for an unknown issue', async () => {
    const { reader } = fakeLinear({
      nsIssueHistory: (v) => {
        if (v.id === 'FOR-999') throw new Error('Entity not found: Issue')
        return { issue: { history: conn([entry('2026-01-02T00:00:00.000Z', { addedLabels: [] })]) } }
      },
    })
    expect(await reader.lastChange('FOR-1')).toBeNull()
    expect(await reader.lastChange('FOR-999')).toBeNull()
  })
})
