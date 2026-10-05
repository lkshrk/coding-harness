import type { DoctorFinding } from '../doctor'
import type { LinearLabel, LinearStatus, LinearWorkspace } from '../workspace'
import type { ApplyExpectations, ExpectedLabelGroup, StatusType, ViewFilter } from './expected'

export type LinearCustomView = { id: string; name: string }

export type ApplyWorkspace = LinearWorkspace & { customViews?: LinearCustomView[] }

export type ApplyOp =
  | {
      kind: 'status'
      team: string
      teamId: string
      name: string
      type: StatusType
      color: string
      after: LinearStatus | null
    }
  | { kind: 'label_group'; name: string }
  | { kind: 'label'; group: string | null; parentId: string | null; name: string }
  | { kind: 'project_label_group'; name: string }
  | { kind: 'project_label'; group: string; parentId: string | null; name: string }
  | { kind: 'template'; name: string; type: string; description: string }
  | { kind: 'view'; name: string; filter: ViewFilter }

export type ApplyPlan = { ops: ApplyOp[]; findings: DoctorFinding[] }

export function planApply(ws: ApplyWorkspace, expected: ApplyExpectations): ApplyPlan {
  const ops: ApplyOp[] = []
  const findings: DoctorFinding[] = []

  for (const t of expected.teams) {
    const team = ws.teams.find((x) => x.key === t.key)
    if (!team) {
      findings.push({
        severity: 'error',
        code: 'team_missing',
        message: `no team ${t.key} in workspace ${ws.organization.name}; doctor --apply does not create teams`,
      })
      continue
    }
    for (const s of t.statuses) {
      const existing = team.statuses.find((x) => x.name === s.name)
      if (existing) {
        if (existing.type !== s.type) {
          findings.push({
            severity: 'warning',
            code: 'status_conflict',
            message: `team ${t.key}: status ${s.name} is ${existing.type}, expected ${s.type}; left unchanged`,
          })
        }
        continue
      }
      if (s.type === 'triage') {
        findings.push({
          severity: 'error',
          code: 'status_not_creatable',
          message: `team ${t.key}: status ${s.name} (triage) missing`,
          fix: `enable Triage in the settings of team ${t.key}`,
        })
        continue
      }
      const after = team.statuses.findLast((x) => x.type === s.type) ?? null
      ops.push({ kind: 'status', team: t.key, teamId: team.id, ...s, after })
    }
  }

  for (const name of expected.labels) {
    const existing = ws.labels.filter((l) => same(l.name, name))
    if (existing.some((l) => !l.isGroup)) continue
    const group = existing[0]
    if (group) {
      findings.push({
        severity: 'warning',
        code: 'label_conflict',
        message: `label ${name} not created: ${labelPath(group, ws.labels)} already exists`,
      })
      continue
    }
    ops.push({ kind: 'label', group: null, parentId: null, name })
  }

  planGroups(
    { ops, findings },
    ws.labels,
    expected.labelGroups,
    'label',
    (name) => ({ kind: 'label_group', name }),
    (group, parentId, name) => ({ kind: 'label', group, parentId, name }),
  )
  planGroups(
    { ops, findings },
    ws.projectLabels,
    expected.projectLabelGroups,
    'project label',
    (name) => ({ kind: 'project_label_group', name }),
    (group, parentId, name) => ({ kind: 'project_label', group, parentId, name }),
  )

  for (const t of expected.templates) {
    const sameName = ws.templates.filter((x) => x.name === t.name)
    if (sameName.some((x) => x.type === t.type)) continue
    if (sameName.length > 0) {
      findings.push({
        severity: 'warning',
        code: 'template_conflict',
        message: `${t.type} template ${t.name} not created: a ${sameName[0]?.type} template has that name`,
      })
      continue
    }
    ops.push({ kind: 'template', ...t })
  }

  if (ws.customViews === undefined) {
    if (expected.views.length > 0) {
      findings.push({
        severity: 'info',
        code: 'views_unread',
        message: 'custom views not read; none planned',
      })
    }
  } else {
    for (const v of expected.views) {
      if (ws.customViews.some((x) => same(x.name, v.name))) continue
      ops.push({ kind: 'view', ...v })
    }
  }

  return { ops, findings }
}

export function describeOp(op: ApplyOp): string {
  switch (op.kind) {
    case 'status':
      return `create status ${op.name} (${op.type}) in team ${op.team}${op.after ? ` after ${op.after.name}` : ''}`
    case 'label_group':
      return `create label group ${op.name}`
    case 'label':
      return op.group === null ? `create label ${op.name}` : `create label ${op.group}:${op.name}`
    case 'project_label_group':
      return `create project label group ${op.name}`
    case 'project_label':
      return `create project label ${op.group}:${op.name}`
    case 'template':
      return `create ${op.type} template ${op.name}`
    case 'view':
      return `create custom view ${op.name}`
  }
}

function planGroups(
  plan: ApplyPlan,
  labels: LinearLabel[],
  groups: ExpectedLabelGroup[],
  noun: string,
  groupOp: (name: string) => ApplyOp,
  labelOp: (group: string, parentId: string | null, name: string) => ApplyOp,
): void {
  for (const g of groups) {
    const topLevel = labels.filter((l) => same(l.name, g.name) && l.parentId === null)
    const group = topLevel.find((l) => l.isGroup && l.teamId === null) ?? topLevel.find((l) => l.isGroup)
    if (!group && topLevel.length > 0) {
      plan.findings.push({
        severity: 'warning',
        code: 'label_conflict',
        message: `${noun} ${g.name} exists but is not a group; group and its labels not created`,
      })
      continue
    }
    if (!group) plan.ops.push(groupOp(g.name))
    for (const name of g.labels) {
      if (group && labels.some((l) => l.parentId === group.id && same(l.name, name))) continue
      const clash = labels.find((l) => same(l.name, name) && (!group || l.parentId !== group.id))
      if (clash) {
        plan.findings.push({
          severity: 'warning',
          code: 'label_conflict',
          message: `${noun} ${g.name}:${name} not created: ${labelPath(clash, labels)} already exists`,
        })
        continue
      }
      plan.ops.push(labelOp(g.name, group?.id ?? null, name))
    }
  }
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function labelPath(label: LinearLabel, labels: LinearLabel[]): string {
  const parent = labels.find((l) => l.id === label.parentId)
  return parent
    ? `${parent.name}:${label.name}`
    : label.isGroup
      ? `group ${label.name}`
      : `label ${label.name}`
}
