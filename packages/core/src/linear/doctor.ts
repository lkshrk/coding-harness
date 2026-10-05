import type { LinearLabel, LinearWorkspace } from './workspace'

export type DoctorExpectations = {
  teams: { key: string; statuses: string[] }[]
  labelGroups: { name: string; labels: string[] }[]
  projectLabelGroups: { name: string; labels: string[] }[]
  labels: string[]
  templates: { name: string; type: string }[]
}

export type DoctorFinding = {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  fix?: string
}

export type DoctorReport = { ok: boolean; findings: DoctorFinding[] }

export type LinearPlan = { teamLimit: number; unavailable: string[] }

export const LINEAR_PLANS: Record<string, LinearPlan> = {
  basic: {
    teamLimit: 5,
    unavailable: [
      'triage rules',
      'triage responsibility',
      'releases',
      'sub-initiatives',
      'team project labels',
      'insights',
    ],
  },
}

const APPLY = 'nightshift doctor --apply creates it'
const SEVERITY_ORDER = ['error', 'warning', 'info']

export function doctorReport(
  ws: LinearWorkspace,
  expected: DoctorExpectations,
  plans: Record<string, LinearPlan> = LINEAR_PLANS,
): DoctorReport {
  const findings: DoctorFinding[] = [
    {
      severity: 'info',
      code: 'summary',
      message: `workspace ${ws.organization.name}: ${count(ws.teams, 'team')}, ${count(ws.projects, 'project')}, ${ws.initiatives ? count(ws.initiatives, 'initiative') : 'initiatives not readable'}, ${count(ws.labels, 'label')}, ${count(ws.templates, 'template')}`,
    },
    ...planFindings(ws, plans),
  ]
  if (ws.initiatives === null) {
    findings.push({
      severity: 'warning',
      code: 'initiatives_unreadable',
      message: 'initiatives not readable: the token lacks scope initiative:read',
      fix: 'add initiative:read to linear.auth.scopes',
    })
  }

  for (const t of expected.teams) {
    const team = ws.teams.find((x) => x.key === t.key)
    if (!team) {
      findings.push({
        severity: 'error',
        code: 'team_missing',
        message: `no team ${t.key} in workspace ${ws.organization.name}`,
      })
      continue
    }
    for (const status of t.statuses) {
      if (team.statuses.some((s) => s.name === status)) continue
      findings.push({
        severity: 'error',
        code: 'status_missing',
        message: `team ${t.key}: status ${status} missing`,
        fix: APPLY,
      })
    }
  }

  for (const name of expected.labels) {
    if (ws.labels.some((l) => !l.isGroup && same(l.name, name))) continue
    findings.push({ severity: 'error', code: 'label_missing', message: `label ${name} missing`, fix: APPLY })
  }
  findings.push(
    ...groupFindings(ws.labels, expected.labelGroups, 'label'),
    ...groupFindings(ws.projectLabels, expected.projectLabelGroups, 'project_label'),
  )

  for (const t of expected.templates) {
    if (ws.templates.some((x) => x.name === t.name && x.type === t.type)) continue
    findings.push({
      severity: 'error',
      code: 'template_missing',
      message: `${t.type} template ${t.name} missing`,
      fix: APPLY,
    })
  }

  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
  return { ok: findings.every((f) => f.severity !== 'error'), findings }
}

function groupFindings(
  labels: LinearLabel[],
  groups: { name: string; labels: string[] }[],
  kind: 'label' | 'project_label',
): DoctorFinding[] {
  const noun = kind.replace('_', ' ')
  const findings: DoctorFinding[] = []
  for (const g of groups) {
    const group = labels.find((l) => l.isGroup && l.parentId === null && same(l.name, g.name))
    if (!group) {
      findings.push({
        severity: 'error',
        code: `${kind}_group_missing`,
        message: `${noun} group ${g.name} missing (labels ${g.labels.join(', ')})`,
        fix: APPLY,
      })
      continue
    }
    for (const name of g.labels) {
      if (labels.some((l) => l.parentId === group.id && same(l.name, name))) continue
      findings.push({
        severity: 'error',
        code: `${kind}_missing`,
        message: `${noun} ${g.name}:${name} missing`,
        fix: APPLY,
      })
    }
  }
  return findings
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function planFindings(ws: LinearWorkspace, plans: Record<string, LinearPlan>): DoctorFinding[] {
  const name = ws.organization.plan
  if (name === null) {
    return [
      { severity: 'warning', code: 'plan_unknown', message: 'plan not readable; team limit not checked' },
    ]
  }
  const plan = plans[name] ?? plans[name.split('_')[0] ?? name]
  if (!plan) {
    return [
      {
        severity: 'warning',
        code: 'plan_unknown',
        message: `plan ${name}: features unknown to nightshift; team limit not checked`,
      },
    ]
  }
  const findings: DoctorFinding[] = [
    {
      severity: 'info',
      code: 'plan',
      message: `plan ${name}: up to ${plan.teamLimit} teams; not available: ${plan.unavailable.join(', ')}`,
    },
  ]
  const teams = ws.teams.length
  if (teams > plan.teamLimit) {
    findings.push({
      severity: 'error',
      code: 'team_limit',
      message: `${teams} teams exceed the ${plan.teamLimit}-team limit of plan ${name}`,
    })
  } else if (teams === plan.teamLimit) {
    findings.push({
      severity: 'warning',
      code: 'team_limit',
      message: `${teams} of ${plan.teamLimit} teams on plan ${name}: adding a team needs a plan upgrade`,
    })
  }
  return findings
}

function count(items: unknown[], noun: string): string {
  return `${items.length} ${noun}${items.length === 1 ? '' : 's'}`
}
