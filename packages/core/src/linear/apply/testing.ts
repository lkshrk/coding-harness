import { type Config, DEFAULT_STATUSES } from '../../config'
import type { LinearTeam } from '../workspace'
import type { ApplyWorkspace } from './plan'

const statuses = {
  triage: 'Triage',
  backlog: 'Backlog',
  ready: 'Todo',
  running: 'In Progress',
  review: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
  canceled: 'Canceled',
}

export function testConfig(over: { projects?: { repositories: string[] }[] } = {}): Config {
  return {
    linear: {
      act_on: { delegated: true, labels: ['autopilot'] },
      statuses,
      teams: [
        { key: 'FRG', statuses },
        { key: 'CIV', statuses: { ...statuses, blocked: 'Waiting', review: 'In Progress' } },
      ],
    },
    stages: {
      intake: { automatic: true },
      design: { automatic: false },
      implementation: { automatic: true },
    },
    projects: over.projects ?? [{ repositories: ['omni'] }],
  } as unknown as Config
}

export function basicTeam(key: string): LinearTeam {
  const s = (name: string, type: string) => ({ id: `${key}-${name}`, name, type })
  return {
    id: `t-${key}`,
    key,
    name: key,
    statuses: [
      s('Backlog', 'backlog'),
      s('Todo', 'unstarted'),
      s('In Progress', 'started'),
      s('Done', 'completed'),
      s('Canceled', 'canceled'),
      s('Duplicate', 'duplicate'),
      s('In Review', 'started'),
    ],
  }
}

export function basicWorkspace(over: Partial<ApplyWorkspace> = {}): ApplyWorkspace {
  return {
    organization: { id: 'o', name: 'h-cloud', urlKey: 'h-cloud', plan: 'basic' },
    teams: [basicTeam('FRG'), basicTeam('CIV')],
    labels: [
      { id: 'type', name: 'Type', isGroup: true, parentId: null, teamId: null },
      { id: 'bug', name: 'bug', isGroup: false, parentId: 'type', teamId: null },
    ],
    projectLabels: [],
    projects: [],
    initiatives: [],
    templates: [{ id: 'tb', name: 'Bug', type: 'issue', teamId: null }],
    customViews: [{ id: 'v1', name: 'Bugs' }],
    ...over,
  }
}

export function defaultConfig(): Config {
  const stages = [
    'intake',
    'discovery',
    'design',
    'decomposition',
    'implementation',
    'verification',
    'integration',
    'acceptance',
    'release',
  ]
  return {
    linear: { act_on: { delegated: true, labels: ['autopilot'] }, statuses: DEFAULT_STATUSES, teams: [] },
    stages: Object.fromEntries(stages.map((s) => [s, { automatic: true }])),
    projects: [{ repositories: ['omni'] }, { repositories: ['cms', 'cms-ui'] }],
  } as unknown as Config
}

export function currentWorkspace(): ApplyWorkspace {
  const group = (id: string, name: string, labels: string[]) => [
    { id, name, isGroup: true, parentId: null, teamId: null },
    ...labels.map((l) => ({ id: `${id}-${l}`, name: l, isGroup: false, parentId: id, teamId: null })),
  ]
  return basicWorkspace({
    teams: ['XXX', 'CIV', 'ROU', 'WEB'].map(basicTeam),
    labels: [
      ...group('repo', 'Repo', ['omni', 'cms']),
      ...group('type', 'Type', ['bug', 'feature', 'improvement']),
      ...group('llm', 'LLM', ['llm-ready', 'llm-refine']),
      ...group('page', 'Page', []),
    ],
    templates: ['EPIC', 'Improvements', 'Feature', 'Bug'].map((name) => ({
      id: name,
      name,
      type: 'issue',
      teamId: null,
    })),
    customViews: [],
  })
}
