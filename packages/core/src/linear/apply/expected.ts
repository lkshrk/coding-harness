import { type Config, LIFECYCLE_STATES, teamStatuses } from '../../config/schema'
import type { DoctorExpectations } from '../doctor'
import { optInFilter } from '../issues'
import { LABEL_GROUPS } from '../labels'
import type { LinearWorkspace } from '../workspace'

export type StatusType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'

export type ExpectedStatus = { name: string; type: StatusType; color: string }

export type ExpectedTemplate = { name: string; type: 'issue'; description: string }

export type ViewFilter = Record<string, unknown>

export type ExpectedView = { name: string; filter: ViewFilter }

export type ExpectedLabelGroup = { name: string; labels: string[] }

export type ApplyExpectations = {
  teams: { key: string; statuses: ExpectedStatus[] }[]
  labelGroups: ExpectedLabelGroup[]
  projectLabelGroups: ExpectedLabelGroup[]
  labels: string[]
  templates: ExpectedTemplate[]
  views: ExpectedView[]
}

type Lifecycle = (typeof LIFECYCLE_STATES)[number]

export const LIFECYCLE_STATUS: Record<Lifecycle, { type: StatusType; color: string }> = {
  triage: { type: 'triage', color: '#fc7840' },
  backlog: { type: 'backlog', color: '#bec2c8' },
  ready: { type: 'unstarted', color: '#e2e2e2' },
  running: { type: 'started', color: '#f2c94c' },
  review: { type: 'started', color: '#0f783c' },
  blocked: { type: 'started', color: '#eb5757' },
  done: { type: 'completed', color: '#5e6ad2' },
  canceled: { type: 'canceled', color: '#95a2b3' },
}

export const MERGE_MODES = ['manual', 'auto', 'feature-branch']

export const ISSUE_TEMPLATES = ['Agent task']

export const TEMPLATE_SECTIONS: [string, string][] = [
  ['Goal', 'the change, one or two sentences'],
  ['Why', 'the reason, linked to the feature or report'],
  ['Design excerpt', 'link to the design document and section, or none for a small fix'],
  ['Interfaces in', 'consumed interfaces, or none'],
  ['Interfaces out', 'provided interfaces, or none'],
  ['Files', 'one list item per repository-relative path or glob'],
  ['Constraints', 'rules to keep, or none'],
  ['Out of scope', 'what to leave alone, or none'],
  ['Acceptance criteria', 'list items'],
  ['Tests expected', 'list items'],
  ['Verify', 'exact commands in a fenced code block'],
]

export function expectedObjects(config: Config, ws: LinearWorkspace): ApplyExpectations {
  const statusNames = (state: Lifecycle) => [
    ...new Set([config.linear.statuses[state], ...ws.teams.map((t) => teamStatuses(config, t.key)[state])]),
  ]
  const optIn = optInFilter(config.linear.act_on)
  const view = (name: string, state: Lifecycle) => ({
    name,
    filter: { and: [optIn, { state: { name: { in: statusNames(state) } } }] },
  })
  const multiRepo = config.projects.filter((p) => p.repositories.length > 1).flatMap((p) => p.repositories)

  return {
    teams: ws.teams.map((t) => ({
      key: t.key,
      statuses: dedupe(
        [...LIFECYCLE_STATES.filter((s) => s !== 'triage'), 'triage' as const].map((state) => ({
          name: teamStatuses(config, t.key)[state],
          ...LIFECYCLE_STATUS[state],
        })),
      ),
    })),
    labelGroups: [
      { name: LABEL_GROUPS.stage, labels: Object.keys(config.stages) },
      { name: LABEL_GROUPS.repo, labels: [...new Set(multiRepo)] },
    ].filter((g) => g.labels.length > 0),
    projectLabelGroups: [{ name: LABEL_GROUPS.merge, labels: MERGE_MODES }],
    labels: [...new Set(config.linear.act_on.labels)],
    templates: ISSUE_TEMPLATES.map((name) => ({ name, type: 'issue', description: templateBody() })),
    views:
      optIn.or.length === 0
        ? []
        : [
            view('Needs me', 'blocked'),
            view('Running', 'running'),
            view('Ready', 'ready'),
            view('In Review', 'review'),
          ],
  }
}

export function doctorExpectations(expected: ApplyExpectations): DoctorExpectations {
  return {
    teams: expected.teams.map((t) => ({ key: t.key, statuses: t.statuses.map((s) => s.name) })),
    labelGroups: expected.labelGroups,
    projectLabelGroups: expected.projectLabelGroups,
    labels: expected.labels,
    templates: expected.templates.map((t) => ({ name: t.name, type: t.type })),
  }
}

function templateBody(): string {
  return TEMPLATE_SECTIONS.map(([heading, hint]) => `## ${heading} (${hint})\n`).join('\n')
}

function dedupe(statuses: ExpectedStatus[]): ExpectedStatus[] {
  return statuses.filter((s, i) => statuses.findIndex((x) => x.name === s.name) === i)
}
