export type LinearStatus = { id: string; name: string; type: string }

export type LinearTeam = { id: string; key: string; name: string; statuses: LinearStatus[] }

export type LinearLabel = {
  id: string
  name: string
  isGroup: boolean
  parentId: string | null
  teamId: string | null
}

export type LinearMilestone = { id: string; name: string }

export type LinearProject = { id: string; name: string; state: string; milestones: LinearMilestone[] }

export type LinearInitiative = { id: string; name: string }

export type LinearTemplate = { id: string; name: string; type: string; teamId: string | null }

export type LinearWorkspace = {
  organization: { id: string; name: string; urlKey: string; plan: string | null }
  teams: LinearTeam[]
  labels: LinearLabel[]
  projectLabels: LinearLabel[]
  projects: LinearProject[]
  initiatives: LinearInitiative[] | null
  templates: LinearTemplate[]
}

export type LinearViewer = { id: string; name: string; displayName: string; app: boolean }

export type BlockingRelations = { blocks: string[]; blockedBy: string[] }
