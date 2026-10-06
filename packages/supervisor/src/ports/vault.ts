import type { PullRequestRecord } from './git-host'
import type { IssueSnapshot } from './linear'
import type { Event, Run } from './records'

export type VaultIngestPrepared = {
  repository: string
  baseSha: string
  files: string[]
  sourceFiles: { path: string; content: string }[]
}

export interface VaultIngest {
  prepare(input: {
    issue: IssueSnapshot
    repository: string
    date: string
    events: Event[]
    pr: PullRequestRecord | null
    reuse?: boolean
  }): Promise<VaultIngestPrepared>
  publish(run: Run): Promise<string[]>
}
