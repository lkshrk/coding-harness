import { describe, expect, test } from 'bun:test'
import { type ApplyExpectations, expectedObjects } from './expected'
import { type ApplyOp, describeOp, planApply } from './plan'
import { basicTeam, basicWorkspace, currentWorkspace, defaultConfig, testConfig } from './testing'

const expected = expectedObjects(testConfig(), basicWorkspace())

const only = (e: Partial<ApplyExpectations>): ApplyExpectations => ({
  teams: [],
  labelGroups: [],
  projectLabelGroups: [],
  labels: [],
  templates: [],
  views: [],
  ...e,
})

const described = (ops: ApplyOp[]) => ops.map(describeOp)

describe('planApply', () => {
  test('a basic workspace gets statuses, labels, label groups, templates and views, in that order', () => {
    const { ops, findings } = planApply(basicWorkspace(), expected)
    expect(described(ops)).toEqual([
      'create status Blocked (started) in team FRG after In Review',
      'create status Waiting (started) in team CIV after In Review',
      'create label autopilot',
      'create label group ai-stage',
      'create label ai-stage:intake',
      'create label ai-stage:design',
      'create label ai-stage:implementation',
      'create project label group ai-merge',
      'create project label ai-merge:manual',
      'create project label ai-merge:auto',
      'create project label ai-merge:feature-branch',
      'create issue template Agent task',
      'create custom view Needs me',
      'create custom view Running',
      'create custom view Ready',
      'create custom view In Review',
    ])
    expect(findings.map((f) => `${f.code}: ${f.message}`)).toEqual([
      'status_not_creatable: team FRG: status Triage (triage) missing',
      'status_not_creatable: team CIV: status Triage (triage) missing',
    ])
  })

  test('a status op carries team id, type, color and the last status of the same type', () => {
    const op = planApply(basicWorkspace(), only({ teams: expected.teams.slice(0, 1) })).ops[0]
    expect(op).toEqual({
      kind: 'status',
      team: 'FRG',
      teamId: 't-FRG',
      name: 'Blocked',
      type: 'started',
      color: '#eb5757',
      after: { id: 'FRG-In Review', name: 'In Review', type: 'started' },
    })
  })

  test('a status type the team has none of is created without a position anchor', () => {
    const team = { ...basicTeam('FRG'), statuses: [] }
    const ops = planApply(
      basicWorkspace({ teams: [team] }),
      only({ teams: [{ key: 'FRG', statuses: [{ name: 'Blocked', type: 'started', color: '#eb5757' }] }] }),
    ).ops
    expect(ops[0]).toMatchObject({ kind: 'status', after: null })
  })

  test('an existing status with another type is a finding and is left alone', () => {
    const team = basicTeam('FRG')
    team.statuses.push({ id: 'b', name: 'Blocked', type: 'unstarted' })
    const r = planApply(basicWorkspace({ teams: [team] }), only({ teams: expected.teams.slice(0, 1) }))
    expect(r.ops).toEqual([])
    expect(r.findings.map((f) => f.code)).toEqual(['status_conflict', 'status_not_creatable'])
  })

  test('a missing team is a finding, not an action', () => {
    const r = planApply(basicWorkspace({ teams: [basicTeam('FRG')] }), only({ teams: expected.teams }))
    expect(r.findings.map((f) => f.code)).toContain('team_missing')
    expect(r.ops.every((op) => op.kind === 'status' && op.team === 'FRG')).toBe(true)
  })

  test('an existing group gets only its missing labels, parented to the existing id', () => {
    const ws = basicWorkspace({
      labels: [
        { id: 'g', name: 'ai-merge', isGroup: true, parentId: null, teamId: null },
        { id: 'm', name: 'manual', isGroup: false, parentId: 'g', teamId: null },
      ],
    })
    const r = planApply(ws, only({ labelGroups: [{ name: 'ai-merge', labels: ['manual', 'auto'] }] }))
    expect(r.ops).toEqual([{ kind: 'label', group: 'ai-merge', parentId: 'g', name: 'auto' }])
  })

  test('an existing group matches its expected name case-insensitively', () => {
    const ws = basicWorkspace({
      labels: [{ id: 'g', name: 'Repo', isGroup: true, parentId: null, teamId: null }],
    })
    const r = planApply(ws, only({ labelGroups: [{ name: 'repo', labels: ['omni'] }] }))
    expect(r.ops).toEqual([{ kind: 'label', group: 'repo', parentId: 'g', name: 'omni' }])
  })

  test('the 2026-10-04 workspace with the default config gets one Blocked per team and the missing objects', () => {
    const ws = currentWorkspace()
    const { ops, findings } = planApply(ws, expectedObjects(defaultConfig(), ws))
    expect(described(ops)).toEqual([
      'create status Blocked (started) in team XXX after In Review',
      'create status Blocked (started) in team CIV after In Review',
      'create status Blocked (started) in team ROU after In Review',
      'create status Blocked (started) in team WEB after In Review',
      'create label autopilot',
      'create label group ai-stage',
      ...[
        'intake',
        'discovery',
        'design',
        'decomposition',
        'implementation',
        'verification',
        'integration',
        'acceptance',
        'release',
      ].map((s) => `create label ai-stage:${s}`),
      'create label repo:cms-ui',
      'create project label group ai-merge',
      'create project label ai-merge:manual',
      'create project label ai-merge:auto',
      'create project label ai-merge:feature-branch',
      'create issue template Agent task',
      'create custom view Needs me',
      'create custom view Running',
      'create custom view Ready',
      'create custom view In Review',
    ])
    expect(findings).toEqual([])
  })

  test('labels inside an existing group match case-insensitively', () => {
    const ws = basicWorkspace({
      labels: [
        { id: 'g', name: 'Repo', isGroup: true, parentId: null, teamId: null },
        { id: 'o', name: 'Omni', isGroup: false, parentId: 'g', teamId: null },
      ],
    })
    expect(planApply(ws, only({ labelGroups: [{ name: 'repo', labels: ['omni'] }] }))).toEqual({
      ops: [],
      findings: [],
    })
  })

  test('the opt-in label is planned once, and not at all when it exists under any case', () => {
    const plain = (name: string) => ({ id: name, name, isGroup: false, parentId: null, teamId: null })
    expect(planApply(basicWorkspace(), only({ labels: ['autopilot'] })).ops).toEqual([
      { kind: 'label', group: null, parentId: null, name: 'autopilot' },
    ])
    const ws = basicWorkspace({ labels: [plain('Autopilot')] })
    expect(planApply(ws, only({ labels: ['autopilot'] }))).toEqual({ ops: [], findings: [] })
  })

  test('an opt-in label clashing with a group is a finding', () => {
    const ws = basicWorkspace({
      labels: [{ id: 'g', name: 'autopilot', isGroup: true, parentId: null, teamId: null }],
    })
    const r = planApply(ws, only({ labels: ['autopilot'] }))
    expect(r.ops).toEqual([])
    expect(r.findings[0]?.message).toBe('label autopilot not created: group autopilot already exists')
  })

  test('ai-merge is planned as a project label group; an issue label group of that name does not count', () => {
    const ws = basicWorkspace({
      labels: [{ id: 'g', name: 'ai-merge', isGroup: true, parentId: null, teamId: null }],
    })
    const r = planApply(ws, only({ projectLabelGroups: expected.projectLabelGroups }))
    expect(r.ops).toEqual([
      { kind: 'project_label_group', name: 'ai-merge' },
      { kind: 'project_label', group: 'ai-merge', parentId: null, name: 'manual' },
      { kind: 'project_label', group: 'ai-merge', parentId: null, name: 'auto' },
      { kind: 'project_label', group: 'ai-merge', parentId: null, name: 'feature-branch' },
    ])
  })

  test('an existing project label group gets only its missing labels', () => {
    const ws = basicWorkspace({
      projectLabels: [
        { id: 'pg', name: 'AI-Merge', isGroup: true, parentId: null, teamId: null },
        { id: 'pm', name: 'Manual', isGroup: false, parentId: 'pg', teamId: null },
      ],
    })
    const r = planApply(ws, only({ projectLabelGroups: expected.projectLabelGroups }))
    expect(described(r.ops)).toEqual([
      'create project label ai-merge:auto',
      'create project label ai-merge:feature-branch',
    ])
    expect(r.ops[0]).toMatchObject({ parentId: 'pg' })
  })

  test('a plain label with a group name is a finding and blocks the group', () => {
    const ws = basicWorkspace({
      labels: [{ id: 'x', name: 'ai-stage', isGroup: false, parentId: null, teamId: null }],
    })
    const r = planApply(ws, only({ labelGroups: [{ name: 'ai-stage', labels: ['design'] }] }))
    expect(r.ops).toEqual([])
    expect(r.findings[0]?.code).toBe('label_conflict')
  })

  test('a label name used elsewhere is a finding; the rest of the group is still created', () => {
    const r = planApply(basicWorkspace(), only({ labelGroups: [{ name: 'repo', labels: ['bug', 'omni'] }] }))
    expect(described(r.ops)).toEqual(['create label group repo', 'create label repo:omni'])
    expect(r.findings[0]?.message).toBe('label repo:bug not created: Type:bug already exists')
  })

  test('a template name used by another template type is a finding', () => {
    const ws = basicWorkspace({ templates: [{ id: 'p', name: 'Agent task', type: 'project', teamId: null }] })
    const r = planApply(ws, only({ templates: expected.templates.slice(0, 1) }))
    expect(r.ops).toEqual([])
    expect(r.findings[0]?.code).toBe('template_conflict')
  })

  test('views are not planned when custom views were not read', () => {
    const { customViews: _, ...ws } = basicWorkspace()
    const r = planApply(ws, only({ views: expected.views }))
    expect(r.ops).toEqual([])
    expect(r.findings.map((f) => f.code)).toEqual(['views_unread'])
  })

  test('a workspace holding every object plans nothing', () => {
    const team = (key: string) => ({
      ...basicTeam(key),
      statuses: [
        ...basicTeam(key).statuses,
        { id: `${key}-tr`, name: 'Triage', type: 'triage' },
        { id: `${key}-b`, name: key === 'FRG' ? 'Blocked' : 'Waiting', type: 'started' },
      ],
    })
    const grouped = (groups: { name: string; labels: string[] }[]) =>
      groups.flatMap((g) => [
        { id: g.name, name: g.name, isGroup: true, parentId: null, teamId: null },
        ...g.labels.map((l) => ({
          id: `${g.name}:${l}`,
          name: l,
          isGroup: false,
          parentId: g.name,
          teamId: null,
        })),
      ])
    const ws = basicWorkspace({
      teams: [team('FRG'), team('CIV')],
      labels: [
        ...grouped(expected.labelGroups),
        { id: 'a', name: 'autopilot', isGroup: false, parentId: null, teamId: null },
      ],
      projectLabels: grouped(expected.projectLabelGroups),
      templates: expected.templates.map((t) => ({ id: t.name, name: t.name, type: t.type, teamId: null })),
      customViews: expected.views.map((v) => ({ id: v.name, name: v.name })),
    })
    expect(planApply(ws, expected)).toEqual({ ops: [], findings: [] })
  })
})
