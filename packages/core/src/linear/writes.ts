import type { LinearRequest } from '@linear/sdk'
import {
  COMMENT_FIELDS,
  LABEL_FIELDS,
  type LinearIssueComment,
  type LinearIssueReader,
  notFound,
  type Page,
  type RawComment,
  type RawLabel,
  toComment,
} from './issues'
import type { LinearLabel, LinearWorkspace } from './workspace'

export type LabelChange = { group: string; name: string | null }

export type IssueChange = { status?: string; labels?: LabelChange[] }

type Target = { id: string; team: string; stateId: string; labels: RawLabel[] }

type IssueUpdateInput = { stateId?: string; addedLabelIds?: string[]; removedLabelIds?: string[] }

const MARKER = /<!-- nightshift:\S+? -->/

const TARGET = `query nsIssueTarget($id: String!) {
  issue(id: $id) { id team { key } state { id } labels(first: 20) { ${LABEL_FIELDS} } }
}`

const UPDATE = `mutation nsIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`

const CREATE_COMMENT = `mutation nsCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
}`

const ATTACHMENTS = `query nsIssueAttachments($id: String!) {
  issue(id: $id) { id attachments(first: 100) { nodes { id url } } }
}`

const CREATE_ATTACHMENT = `mutation nsAttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success }
}`

class UnknownName extends Error {}

export class LinearWriter {
  private ws: Promise<LinearWorkspace> | undefined

  constructor(
    private readonly request: LinearRequest,
    private readonly reader: LinearIssueReader,
    private readonly loadWorkspace: () => Promise<LinearWorkspace>,
  ) {}

  async update(identifier: string, change: (team: string) => IssueChange): Promise<boolean> {
    const target = await this.target(identifier)
    const wanted = change(target.team)
    let input: IssueUpdateInput
    try {
      input = planUpdate(target, wanted, await this.workspace())
    } catch (e) {
      if (!(e instanceof UnknownName)) throw e
      input = planUpdate(target, wanted, await this.workspace(true))
    }
    if (Object.keys(input).length === 0) return false
    const data = await this.request<
      { issueUpdate: { success: boolean } },
      { id: string; input: IssueUpdateInput }
    >(UPDATE, { id: target.id, input })
    if (!data.issueUpdate.success) throw new Error(`linear: issueUpdate ${identifier} not confirmed`)
    return true
  }

  async comment(
    identifier: string,
    body: string,
    opts: { parentId?: string } = {},
  ): Promise<LinearIssueComment> {
    const thread = await this.reader.thread(identifier)
    if (!thread) throw new Error(`linear: no issue ${identifier}`)
    const marker = MARKER.exec(body)?.[0]
    const existing = marker === undefined ? undefined : thread.comments.find((c) => c.body.includes(marker))
    if (existing) return existing
    const input = { issueId: thread.issueId, body, ...(opts.parentId ? { parentId: opts.parentId } : {}) }
    const data = await this.request<
      { commentCreate: { success: boolean; comment: RawComment | null } },
      { input: typeof input }
    >(CREATE_COMMENT, { input })
    if (!data.commentCreate.success || !data.commentCreate.comment)
      throw new Error(`linear: commentCreate ${identifier} not confirmed`)
    return toComment(data.commentCreate.comment)
  }

  async attachLink(identifier: string, url: string, title: string): Promise<boolean> {
    type Data = { issue: { id: string; attachments: { nodes: { id: string; url: string }[] } } }
    let data: Data
    try {
      data = await this.request<Data, { id: string }>(ATTACHMENTS, { id: identifier })
    } catch (e) {
      if (notFound(e)) throw new Error(`linear: no issue ${identifier}`)
      throw e
    }
    if (data.issue.attachments.nodes.some((a) => a.url === url)) return false
    const input = { issueId: data.issue.id, url, title }
    const created = await this.request<{ attachmentCreate: { success: boolean } }, { input: typeof input }>(
      CREATE_ATTACHMENT,
      { input },
    )
    if (!created.attachmentCreate.success)
      throw new Error(`linear: attachmentCreate ${identifier} not confirmed`)
    return true
  }

  private workspace(refresh = false): Promise<LinearWorkspace> {
    if (refresh || !this.ws) {
      const loading = this.loadWorkspace()
      this.ws = loading
      loading.catch(() => {
        if (this.ws === loading) this.ws = undefined
      })
    }
    return this.ws
  }

  private async target(identifier: string): Promise<Target> {
    type Data = {
      issue: { id: string; team: { key: string }; state: { id: string }; labels: Page<RawLabel> }
    }
    let data: Data
    try {
      data = await this.request<Data, { id: string }>(TARGET, { id: identifier })
    } catch (e) {
      if (notFound(e)) throw new Error(`linear: no issue ${identifier}`)
      throw e
    }
    const { issue } = data
    return {
      id: issue.id,
      team: issue.team.key,
      stateId: issue.state.id,
      labels: await this.reader.issueLabels(issue.id, issue.labels),
    }
  }
}

function planUpdate(target: Target, change: IssueChange, ws: LinearWorkspace): IssueUpdateInput {
  const team = ws.teams.find((t) => t.key === target.team)
  const input: IssueUpdateInput = {}
  if (change.status !== undefined) {
    const status = team?.statuses.find((s) => s.name === change.status)
    if (!status) throw new UnknownName(`linear: no status ${change.status} in team ${target.team}`)
    if (status.id !== target.stateId) input.stateId = status.id
  }
  const added: string[] = []
  const removed: string[] = []
  for (const { group, name } of change.labels ?? []) {
    const wanted = name === null ? null : findLabel(ws.labels, group, name, team?.id ?? null)
    for (const l of target.labels) {
      if (l.parent?.name.toLowerCase() === group.toLowerCase() && l.id !== wanted?.id) removed.push(l.id)
    }
    if (wanted && !target.labels.some((l) => l.id === wanted.id)) added.push(wanted.id)
  }
  if (added.length) input.addedLabelIds = added
  if (removed.length) input.removedLabelIds = removed
  return input
}

function findLabel(labels: LinearLabel[], group: string, name: string, teamId: string | null): LinearLabel {
  const scope = (l: LinearLabel) => (l.teamId === null ? 0 : l.teamId === teamId ? 1 : 2)
  const groups = labels
    .filter((l) => l.isGroup && l.parentId === null && l.name.toLowerCase() === group.toLowerCase())
    .filter((l) => scope(l) < 2)
    .sort((a, b) => scope(a) - scope(b))
  for (const g of groups) {
    const hit = labels.find((l) => l.parentId === g.id && l.name === name)
    if (hit) return hit
  }
  throw new UnknownName(`linear: no label ${group}:${name} in workspace (run nightshift doctor)`)
}
