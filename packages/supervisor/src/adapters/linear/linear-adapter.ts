import {
  type Config,
  type FetchFn,
  type IssueChange,
  LABEL_GROUPS,
  type LabelChange,
  LinearIssueReader,
  LinearReader,
  LinearWriter,
  linearRequest,
  type TokenProvider,
  teamStatuses,
} from '@nightshift/core'
import type { IssueUpdate, LinearPort } from '../../ports'

export type LinearPortOptions = {
  config: () => Config
  auth: TokenProvider
  fetch?: FetchFn
  apiUrl?: string
}

export function createLinearPort(opts: LinearPortOptions): LinearPort {
  const { config, ...connection } = opts
  const request = linearRequest(connection)
  const reader = new LinearReader(request)
  const issues = new LinearIssueReader(request)
  const writer = new LinearWriter(request, issues, () => reader.workspace())
  return {
    workspace: () => reader.workspace(),
    issues: (q) => issues.issues({ ...q, actOn: config().linear.act_on }),
    candidates: (q) => issues.candidates(q),
    issue: (identifier) => issues.issue(identifier),
    comments: (identifier) => issues.comments(identifier),
    lastChange: (identifier) => issues.lastChange(identifier),
    async update(identifier, change) {
      await writer.update(identifier, (team) => issueChange(config(), team, change))
    },
    comment: (identifier, body, opts) => writer.comment(identifier, body, opts),
    async attachLink(identifier, url, title) {
      await writer.attachLink(identifier, url, title)
    },
  }
}

function issueChange(config: Config, team: string, change: IssueUpdate): IssueChange {
  const labels: LabelChange[] = []
  if (change.stage !== undefined) labels.push({ group: LABEL_GROUPS.stage, name: change.stage })
  if (change.status === undefined) return { labels }
  return { status: teamStatuses(config, team)[change.status], labels }
}
