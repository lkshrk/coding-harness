import { describe, expect, test } from 'bun:test'
import type { FetchFn, TokenProvider } from './auth'
import { linearRequest } from './client'
import { LinearIssueReader } from './issues'
import type { LinearWorkspace } from './workspace'
import { LinearWriter } from './writes'

type Call = { operation: string; variables: Record<string, unknown> }
type Handler = (variables: Record<string, unknown>) => unknown

const auth: TokenProvider = {
  async authorization() {
    return 'Bearer t'
  },
  invalidate() {},
}

const conn = <T>(nodes: T[], endCursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
})

const group = (id: string, name: string, teamId: string | null = null) => ({
  id,
  name,
  isGroup: true,
  parentId: null,
  teamId,
})
const child = (id: string, name: string, parentId: string, teamId: string | null = null) => ({
  id,
  name,
  isGroup: false,
  parentId,
  teamId,
})

function workspace(): LinearWorkspace {
  return {
    organization: { id: 'o', name: 'h-cloud', urlKey: 'h-cloud', plan: 'basic' },
    teams: [
      {
        id: 't-FOR',
        key: 'FOR',
        name: 'Forge',
        statuses: [
          { id: 's-todo', name: 'Todo', type: 'unstarted' },
          { id: 's-prog', name: 'In Progress', type: 'started' },
        ],
      },
    ],
    labels: [
      group('g-ai-stage', 'ai-stage'),
      child('l-impl', 'implementation', 'g-ai-stage'),
      child('l-verif', 'verification', 'g-ai-stage'),
      group('g-ai-agent', 'ai-agent'),
      child('l-running', 'running', 'g-ai-agent'),
      child('l-failed', 'failed', 'g-ai-agent'),
      group('g-agent-team', 'ai-agent', 't-FOR'),
      child('l-running-team', 'running', 'g-agent-team', 't-FOR'),
    ],
    projectLabels: [],
    projects: [],
    initiatives: [],
    templates: [],
  }
}

const rawLabel = (id: string, name: string, groupName?: string) => ({
  id,
  name,
  parent: groupName ? { name: groupName } : null,
})

function fakeLinear(handlers: Record<string, Handler>, ws: () => LinearWorkspace = workspace) {
  const calls: Call[] = []
  let reads = 0
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
      return new Response(JSON.stringify({ data: handler(variables) }))
    } catch (e) {
      return new Response(JSON.stringify({ errors: [{ message: (e as Error).message }] }), { status: 400 })
    }
  }
  const request = linearRequest({ auth, fetch })
  const writer = new LinearWriter(request, new LinearIssueReader(request), async () => {
    reads++
    return ws()
  })
  return { writer, calls, workspaceReads: () => reads }
}

const target = (
  labels: ReturnType<typeof rawLabel>[],
  state = 's-todo',
  endCursor: string | null = null,
) => ({
  issue: { id: 'id-FOR-1', team: { key: 'FOR' }, state: { id: state }, labels: conn(labels, endCursor) },
})

const mutations = (calls: Call[]) => calls.filter((c) => c.operation === 'nsIssueUpdate')

describe('LinearWriter.update', () => {
  test('sets status and replaces a group label in one mutation, leaving other groups alone', async () => {
    const { writer, calls } = fakeLinear({
      nsIssueTarget: () =>
        target([
          rawLabel('l-impl', 'implementation', 'ai-stage'),
          rawLabel('l-failed', 'failed', 'ai-agent'),
        ]),
      nsIssueUpdate: () => ({ issueUpdate: { success: true } }),
    })
    const changed = await writer.update('FOR-1', () => ({
      status: 'In Progress',
      labels: [{ group: 'ai-agent', name: 'running' }],
    }))
    expect(changed).toBe(true)
    expect(mutations(calls).map((c) => c.variables)).toEqual([
      {
        id: 'id-FOR-1',
        input: { stateId: 's-prog', addedLabelIds: ['l-running'], removedLabelIds: ['l-failed'] },
      },
    ])
  })

  test('passes the issue team to the change', async () => {
    const teams: string[] = []
    const { writer } = fakeLinear({ nsIssueTarget: () => target([]) })
    await writer.update('FOR-1', (team) => {
      teams.push(team)
      return {}
    })
    expect(teams).toEqual(['FOR'])
  })

  test('a null value removes the group label', async () => {
    const { writer, calls } = fakeLinear({
      nsIssueTarget: () => target([rawLabel('l-failed', 'failed', 'ai-agent'), rawLabel('x', 'ux')]),
      nsIssueUpdate: () => ({ issueUpdate: { success: true } }),
    })
    await writer.update('FOR-1', () => ({ labels: [{ group: 'ai-agent', name: null }] }))
    expect(mutations(calls)[0]?.variables.input).toEqual({ removedLabelIds: ['l-failed'] })
  })

  test('no mutation when nothing differs', async () => {
    const { writer, calls } = fakeLinear({
      nsIssueTarget: () => target([rawLabel('l-impl', 'implementation', 'ai-stage')]),
    })
    const changed = await writer.update('FOR-1', () => ({
      status: 'Todo',
      labels: [
        { group: 'ai-stage', name: 'implementation' },
        { group: 'ai-agent', name: null },
      ],
    }))
    expect(changed).toBe(false)
    expect(mutations(calls)).toEqual([])
  })

  test('reads the issue labels beyond the first page', async () => {
    const { writer, calls } = fakeLinear({
      nsIssueTarget: () => target([rawLabel('x', 'ux')], 's-todo', 'c1'),
      nsIssueLabels: () => ({ issue: { labels: conn([rawLabel('l-failed', 'failed', 'ai-agent')]) } }),
      nsIssueUpdate: () => ({ issueUpdate: { success: true } }),
    })
    await writer.update('FOR-1', () => ({ labels: [{ group: 'ai-agent', name: null }] }))
    expect(mutations(calls)[0]?.variables.input).toEqual({ removedLabelIds: ['l-failed'] })
  })

  test('prefers the workspace label over a team label of the same name', async () => {
    const { writer, calls } = fakeLinear({
      nsIssueTarget: () => target([]),
      nsIssueUpdate: () => ({ issueUpdate: { success: true } }),
    })
    await writer.update('FOR-1', () => ({ labels: [{ group: 'ai-agent', name: 'running' }] }))
    expect(mutations(calls)[0]?.variables.input).toEqual({ addedLabelIds: ['l-running'] })
  })

  test('re-reads the workspace once for an unknown name, then fails with a doctor hint', async () => {
    const { writer, workspaceReads } = fakeLinear({ nsIssueTarget: () => target([]) })
    await expect(
      writer.update('FOR-1', () => ({ labels: [{ group: 'ai-agent', name: 'gates' }] })),
    ).rejects.toThrow('linear: no label ai-agent:gates in workspace (run nightshift doctor)')
    expect(workspaceReads()).toBe(2)
    await expect(writer.update('FOR-1', () => ({ status: 'Blocked' }))).rejects.toThrow(
      'linear: no status Blocked in team FOR',
    )
  })

  test('a label added since the last workspace read is found after the re-read', async () => {
    let ws = workspace()
    const { writer, calls } = fakeLinear(
      {
        nsIssueTarget: () => target([]),
        nsIssueUpdate: () => ({ issueUpdate: { success: true } }),
      },
      () => ws,
    )
    await writer.update('FOR-1', () => ({ labels: [{ group: 'ai-agent', name: 'running' }] }))
    ws = { ...ws, labels: [...ws.labels, child('l-gates', 'gates', 'g-ai-agent')] }
    await writer.update('FOR-1', () => ({ labels: [{ group: 'ai-agent', name: 'gates' }] }))
    expect(mutations(calls)[1]?.variables.input).toEqual({ addedLabelIds: ['l-gates'] })
  })

  test('an unknown issue fails', async () => {
    const { writer } = fakeLinear({
      nsIssueTarget: () => {
        throw new Error('Entity not found: Issue')
      },
    })
    await expect(writer.update('FOR-9', () => ({}))).rejects.toThrow('linear: no issue FOR-9')
  })

  test('an unconfirmed mutation fails', async () => {
    const { writer } = fakeLinear({
      nsIssueTarget: () => target([]),
      nsIssueUpdate: () => ({ issueUpdate: { success: false } }),
    })
    await expect(writer.update('FOR-1', () => ({ status: 'In Progress' }))).rejects.toThrow(
      'linear: issueUpdate FOR-1 not confirmed',
    )
  })
})

describe('LinearWriter.comment', () => {
  const stored = (id: string, body: string, parent: string | null = null) => ({
    id,
    body,
    createdAt: '2026-01-01T00:00:00.000Z',
    parent: parent ? { id: parent } : null,
    user: { name: 'nightshift' },
    botActor: null,
    externalUser: null,
  })

  test('creates a comment on the issue, as a reply when a parent is given', async () => {
    const { writer, calls } = fakeLinear({
      nsIssueComments: () => ({ issue: { id: 'id-FOR-1', comments: conn([]) } }),
      nsCommentCreate: (v) => ({
        commentCreate: {
          success: true,
          comment: stored('c9', (v.input as { body: string }).body, 'c1'),
        },
      }),
    })
    const c = await writer.comment('FOR-1', 'hello\n\n<!-- nightshift:01J -->', { parentId: 'c1' })
    expect(c).toEqual({
      id: 'c9',
      body: 'hello\n\n<!-- nightshift:01J -->',
      createdAt: '2026-01-01T00:00:00.000Z',
      parentId: 'c1',
      by: 'nightshift',
    })
    expect(calls.find((x) => x.operation === 'nsCommentCreate')?.variables).toEqual({
      input: { issueId: 'id-FOR-1', body: 'hello\n\n<!-- nightshift:01J -->', parentId: 'c1' },
    })
  })

  test('a comment whose marker already exists is not posted again', async () => {
    const { writer, calls } = fakeLinear({
      nsIssueComments: () => ({
        issue: {
          id: 'id-FOR-1',
          comments: conn([
            stored('c1', 'other\n\n<!-- nightshift:01JA -->'),
            stored('c2', 'x\n\n<!-- nightshift:01J -->'),
          ]),
        },
      }),
    })
    const c = await writer.comment('FOR-1', 'retry\n\n<!-- nightshift:01J -->')
    expect(c.id).toBe('c2')
    expect(calls.some((x) => x.operation === 'nsCommentCreate')).toBe(false)
  })

  test('commenting on an unknown issue fails', async () => {
    const { writer } = fakeLinear({
      nsIssueComments: () => {
        throw new Error('Entity not found: Issue')
      },
    })
    await expect(writer.comment('FOR-9', 'x')).rejects.toThrow('linear: no issue FOR-9')
  })
})

describe('LinearWriter.attachLink', () => {
  const issue = (urls: string[]) => ({
    issue: { id: 'id-FOR-1', attachments: { nodes: urls.map((url, i) => ({ id: `a${i}`, url })) } },
  })

  test('attaches the link once; an existing attachment with the same url is kept', async () => {
    const attached: string[] = []
    const { writer, calls } = fakeLinear({
      nsIssueAttachments: () => issue(attached),
      nsAttachmentCreate: (v) => {
        attached.push((v.input as { url: string }).url)
        return { attachmentCreate: { success: true } }
      },
    })
    const url = 'https://github.com/o/r/pull/7'
    expect(await writer.attachLink('FOR-1', url, 'FOR-1: PR #7')).toBe(true)
    expect(await writer.attachLink('FOR-1', url, 'FOR-1: PR #7')).toBe(false)
    expect(calls.filter((c) => c.operation === 'nsAttachmentCreate').map((c) => c.variables)).toEqual([
      { input: { issueId: 'id-FOR-1', url, title: 'FOR-1: PR #7' } },
    ])
  })

  test('an unconfirmed attachment fails', async () => {
    const { writer } = fakeLinear({
      nsIssueAttachments: () => issue([]),
      nsAttachmentCreate: () => ({ attachmentCreate: { success: false } }),
    })
    await expect(writer.attachLink('FOR-1', 'https://x', 't')).rejects.toThrow('not confirmed')
  })
})
