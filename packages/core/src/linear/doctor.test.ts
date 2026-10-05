import { describe, expect, test } from 'bun:test'
import { type DoctorExpectations, doctorReport } from './doctor'
import type { LinearTeam, LinearWorkspace } from './workspace'

const team = (key: string, names: string[] = []): LinearTeam => ({
  id: `t-${key}`,
  key,
  name: key,
  statuses: names.map((name) => ({ id: `s-${name}`, name, type: 'started' })),
})

function workspace(over: Partial<LinearWorkspace> = {}): LinearWorkspace {
  return {
    organization: { id: 'o', name: 'h-cloud', urlKey: 'h-cloud', plan: 'basic' },
    teams: [team('FOR', ['Backlog', 'Todo', 'In Progress', 'Blocked', 'Done'])],
    labels: [
      { id: 'g1', name: 'ai-stage', isGroup: true, parentId: null, teamId: null },
      { id: 'l1', name: 'implementation', isGroup: false, parentId: 'g1', teamId: null },
      { id: 'l2', name: 'review', isGroup: false, parentId: null, teamId: null },
    ],
    projectLabels: [],
    projects: [{ id: 'p1', name: 'Omni', state: 'started', milestones: [] }],
    initiatives: [],
    templates: [{ id: 'tp1', name: 'Task', type: 'issue', teamId: 't-FOR' }],
    ...over,
  }
}

const expected: DoctorExpectations = {
  teams: [{ key: 'FOR', statuses: ['Backlog', 'Todo', 'Blocked'] }],
  labelGroups: [{ name: 'ai-stage', labels: ['implementation'] }],
  projectLabelGroups: [],
  labels: [],
  templates: [{ name: 'Task', type: 'issue' }],
}

const codes = (r: ReturnType<typeof doctorReport>) => r.findings.map((f) => f.code)

describe('doctorReport', () => {
  test('a complete workspace is ok and summarised', () => {
    const r = doctorReport(workspace(), expected)
    expect(r.ok).toBe(true)
    expect(r.findings.filter((f) => f.severity !== 'info')).toEqual([])
    expect(r.findings).toContainEqual({
      severity: 'info',
      code: 'summary',
      message: 'workspace h-cloud: 1 team, 1 project, 0 initiatives, 3 labels, 1 template',
    })
  })

  test('reports the plan and what it lacks', () => {
    const r = doctorReport(workspace(), expected)
    const plan = r.findings.find((f) => f.code === 'plan')
    expect(plan?.severity).toBe('info')
    expect(plan?.message).toStartWith('plan basic: up to 5 teams; not available:')
    expect(plan?.message).toContain('releases')
  })

  test('billing variants of a plan map to the plan family', () => {
    const teams = ['FOR', 'A', 'B', 'C', 'D', 'E'].map((k) => team(k, ['Backlog', 'Todo', 'Blocked']))
    const r = doctorReport(
      workspace({ teams, organization: { id: 'o', name: 'h', urlKey: 'h', plan: 'basic_monthly_12' } }),
      expected,
    )
    expect(r.findings.find((f) => f.code === 'plan')?.message).toStartWith(
      'plan basic_monthly_12: up to 5 teams',
    )
    expect(r.findings).toContainEqual({
      severity: 'error',
      code: 'team_limit',
      message: '6 teams exceed the 5-team limit of plan basic_monthly_12',
    })
  })

  test('an unreadable plan is a warning and skips the team limit', () => {
    const r = doctorReport(
      workspace({ organization: { id: 'o', name: 'h', urlKey: 'h', plan: null } }),
      expected,
    )
    expect(r.ok).toBe(true)
    expect(r.findings).toContainEqual({
      severity: 'warning',
      code: 'plan_unknown',
      message: 'plan not readable; team limit not checked',
    })
    expect(codes(r)).not.toContain('team_limit')
  })

  test('a plan nightshift has no table for is a warning', () => {
    const r = doctorReport(
      workspace({ organization: { id: 'o', name: 'h', urlKey: 'h', plan: 'business' } }),
      expected,
    )
    expect(r.findings).toContainEqual({
      severity: 'warning',
      code: 'plan_unknown',
      message: 'plan business: features unknown to nightshift; team limit not checked',
    })
  })

  test('at the 5-team limit warns that no team can be added', () => {
    const teams = ['FOR', 'A', 'B', 'C', 'D'].map((k) => team(k, ['Backlog', 'Todo', 'Blocked']))
    const r = doctorReport(workspace({ teams }), expected)
    expect(r.ok).toBe(true)
    expect(r.findings).toContainEqual({
      severity: 'warning',
      code: 'team_limit',
      message: '5 of 5 teams on plan basic: adding a team needs a plan upgrade',
    })
  })

  test('over the team limit is an error', () => {
    const teams = ['FOR', 'A', 'B', 'C', 'D', 'E'].map((k) => team(k, ['Backlog', 'Todo', 'Blocked']))
    const r = doctorReport(workspace({ teams }), expected)
    expect(r.ok).toBe(false)
    expect(r.findings).toContainEqual({
      severity: 'error',
      code: 'team_limit',
      message: '6 teams exceed the 5-team limit of plan basic',
    })
  })

  test('a configured team missing from the workspace is an error', () => {
    const r = doctorReport(workspace(), { ...expected, teams: [{ key: 'XXY', statuses: ['Todo'] }] })
    expect(r.ok).toBe(false)
    expect(r.findings).toContainEqual({
      severity: 'error',
      code: 'team_missing',
      message: 'no team XXY in workspace h-cloud',
    })
  })

  test('a missing status says doctor --apply creates it', () => {
    const r = doctorReport(workspace({ teams: [team('FOR', ['Backlog', 'Todo', 'Done'])] }), expected)
    expect(r.ok).toBe(false)
    expect(r.findings).toContainEqual({
      severity: 'error',
      code: 'status_missing',
      message: 'team FOR: status Blocked missing',
      fix: 'nightshift doctor --apply creates it',
    })
  })

  test('status names match exactly', () => {
    const r = doctorReport(workspace({ teams: [team('FOR', ['Backlog', 'Todo', 'blocked'])] }), expected)
    expect(codes(r)).toContain('status_missing')
  })

  test('a missing label group is reported once, not per label', () => {
    const r = doctorReport(workspace({ labels: [] }), {
      ...expected,
      labelGroups: [{ name: 'ai-agent', labels: ['running', 'human'] }],
    })
    expect(r.findings.filter((f) => f.severity === 'error')).toEqual([
      {
        severity: 'error',
        code: 'label_group_missing',
        message: 'label group ai-agent missing (labels running, human)',
        fix: 'nightshift doctor --apply creates it',
      },
    ])
  })

  test('a label outside its group counts as missing', () => {
    const r = doctorReport(workspace(), {
      ...expected,
      labelGroups: [{ name: 'ai-stage', labels: ['implementation', 'review'] }],
    })
    expect(r.findings).toContainEqual({
      severity: 'error',
      code: 'label_missing',
      message: 'label ai-stage:review missing',
      fix: 'nightshift doctor --apply creates it',
    })
  })

  test('a label with the group name that is not a group does not count', () => {
    const labels = [{ id: 'x', name: 'ai-stage', isGroup: false, parentId: null, teamId: null }]
    const r = doctorReport(workspace({ labels }), expected)
    expect(codes(r)).toContain('label_group_missing')
  })

  test('label groups and their labels match case-insensitively', () => {
    const labels = [
      { id: 'g', name: 'Repo', isGroup: true, parentId: null, teamId: null },
      { id: 'o', name: 'Omni', isGroup: false, parentId: 'g', teamId: null },
    ]
    const r = doctorReport(workspace({ labels }), {
      ...expected,
      labelGroups: [{ name: 'repo', labels: ['omni'] }],
    })
    expect(r.ok).toBe(true)
  })

  test('a missing project label group is reported; an issue label group of that name does not count', () => {
    const labels = [{ id: 'g', name: 'ai-merge', isGroup: true, parentId: null, teamId: null }]
    const r = doctorReport(workspace({ labels }), {
      ...expected,
      labelGroups: [],
      projectLabelGroups: [{ name: 'ai-merge', labels: ['manual', 'auto'] }],
    })
    expect(r.findings.filter((f) => f.severity === 'error')).toEqual([
      {
        severity: 'error',
        code: 'project_label_group_missing',
        message: 'project label group ai-merge missing (labels manual, auto)',
        fix: 'nightshift doctor --apply creates it',
      },
    ])
  })

  test('a missing project label is reported', () => {
    const projectLabels = [
      { id: 'g', name: 'AI-Merge', isGroup: true, parentId: null, teamId: null },
      { id: 'm', name: 'manual', isGroup: false, parentId: 'g', teamId: null },
    ]
    const r = doctorReport(workspace({ projectLabels }), {
      ...expected,
      projectLabelGroups: [{ name: 'ai-merge', labels: ['manual', 'auto'] }],
    })
    expect(r.findings.filter((f) => f.severity === 'error')).toEqual([
      {
        severity: 'error',
        code: 'project_label_missing',
        message: 'project label ai-merge:auto missing',
        fix: 'nightshift doctor --apply creates it',
      },
    ])
  })

  test('the opt-in label is reported when missing and found under any case', () => {
    const missing = doctorReport(workspace(), { ...expected, labels: ['autopilot'] })
    expect(missing.findings).toContainEqual({
      severity: 'error',
      code: 'label_missing',
      message: 'label autopilot missing',
      fix: 'nightshift doctor --apply creates it',
    })
    const labels = [{ id: 'a', name: 'Autopilot', isGroup: false, parentId: null, teamId: null }]
    expect(
      doctorReport(workspace({ labels }), { ...expected, labelGroups: [], labels: ['autopilot'] }).ok,
    ).toBe(true)
  })

  test('a missing template is an error; type must match', () => {
    const r = doctorReport(workspace(), { ...expected, templates: [{ name: 'Task', type: 'project' }] })
    expect(r.findings).toContainEqual({
      severity: 'error',
      code: 'template_missing',
      message: 'project template Task missing',
      fix: 'nightshift doctor --apply creates it',
    })
  })

  test('unreadable initiatives are a warning naming the missing scope', () => {
    const r = doctorReport(workspace({ initiatives: null }), expected)
    expect(r.ok).toBe(true)
    expect(r.findings).toContainEqual({
      severity: 'warning',
      code: 'initiatives_unreadable',
      message: 'initiatives not readable: the token lacks scope initiative:read',
      fix: 'add initiative:read to linear.auth.scopes',
    })
    expect(r.findings.find((f) => f.code === 'summary')?.message).toContain('initiatives not readable')
  })

  test('errors come before warnings before info', () => {
    const r = doctorReport(
      workspace({ organization: { id: 'o', name: 'h', urlKey: 'h', plan: null }, labels: [] }),
      expected,
    )
    const order = r.findings.map((f) => f.severity)
    expect(order).toEqual([...order].sort((a, b) => rank(a) - rank(b)))
  })
})

function rank(s: string): number {
  return ['error', 'warning', 'info'].indexOf(s)
}
