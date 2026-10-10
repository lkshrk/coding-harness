import type { MergeMode } from './linear'

export type PullRequest = {
  url: string
  number: number
  repository: string
  repo: string
  branch: string
  base: string
  account: string
}

export type CiFailure = { name: string; url: string; log: string }

export type CiState = {
  state: 'pending' | 'passed' | 'failed'
  failedChecks: string[]
  failures: CiFailure[]
  url: string
}

export type PullRequestState = { state: 'open' | 'merged' | 'closed'; mergeSha?: string; headSha?: string }

export type ReviewComment = { id: number; author: string; body: string }

export type ReviewThread = {
  id: string
  resolved: boolean
  outdated: boolean
  path: string
  line: number | null
  comments: ReviewComment[]
}

export class PushRejectedError extends Error {
  constructor(
    readonly branch: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`push to ${branch} rejected: expected it at ${expected}, but it is at ${actual || '(deleted)'}`)
  }
}

export interface GitHost {
  accountFor(repository: string): string
  push(o: {
    repository: string
    source: string
    branch: string
    expected?: string
  }): Promise<{ headSha: string }>
  openPullRequest(o: {
    repository: string
    branch: string
    base: string
    title: string
    body: string
    draft: boolean
  }): Promise<PullRequest>
  ci(pr: PullRequest): Promise<CiState>
  state(pr: PullRequest): Promise<PullRequestState>
  merge(pr: PullRequest, method: 'squash' | 'merge' | 'rebase'): Promise<{ sha: string }>
  reviewThreads(pr: PullRequest): Promise<ReviewThread[]>
  replyToThread(pr: PullRequest, commentId: number, body: string): Promise<{ id: number }>
  resolveThread(pr: PullRequest, threadId: string): Promise<void>
}

export interface RepoInspector {
  baseSha(repository: string): Promise<string>
  fetchPullRequest?(repository: string, pr: Pick<PullRequest, 'number' | 'branch'>): Promise<string>
}

export type PullRequestRecord = PullRequest & {
  issue: string
  run: string
  headSha: string
  mode: MergeMode
  draft: boolean
  ci: 'pending' | 'passed' | 'failed'
  title?: string
  body?: string
  mergeSha?: string
}
