import type { LinearWorkspace } from '@nightshift/core'

export type LifecycleState =
  | 'triage'
  | 'backlog'
  | 'ready'
  | 'running'
  | 'review'
  | 'blocked'
  | 'done'
  | 'canceled'

export type MergeMode = 'manual' | 'auto' | 'feature-branch'

export type Awaiting = { kind: 'before' | 'after' | 'escalated'; stage: string; reason?: string }

export type BlockerRef = { identifier: string; team: string; status: string }

export type IssueSnapshot = {
  id: string
  identifier: string
  title: string
  team: string
  status: string
  stateType?: string
  completedAt?: string | null
  canceledAt?: string | null
  // grouped labels as `<group>:<name>` with the group lowercased (stage:implementation, agent:human, repo:omni)
  labels: string[]
  delegated: boolean
  project: { id: string; name: string; initiatives: string[]; labels: string[] } | null
  priority: number
  estimate: number | null
  createdAt: string
  updatedAt: string
  description: string
  blockedBy: BlockerRef[]
  parent: string | null
}

export type LinearComment = {
  id: string
  body: string
  createdAt: string
  parentId: string | null
  by: string
}

export type LinearChange = { actor: string; app: boolean; at: string; status?: string; labels?: string[] }

export type IssueUpdate = {
  status?: LifecycleState
  stage?: string
}

export interface LinearPort {
  workspace(): Promise<LinearWorkspace>
  issues(q: { updatedSince?: string }): Promise<IssueSnapshot[]>
  candidates(q: { team: string; project: string | null; closedSince: string }): Promise<IssueSnapshot[]>
  issue(identifier: string): Promise<IssueSnapshot | null>
  comments(identifier: string): Promise<LinearComment[]>
  lastChange(identifier: string): Promise<LinearChange | null>
  update(identifier: string, change: IssueUpdate): Promise<void>
  comment(identifier: string, body: string, opts?: { parentId?: string }): Promise<LinearComment>
  attachLink(identifier: string, url: string, title: string): Promise<void>
}
