import { describe, expect, test } from 'bun:test'
import type { LinearWorkspace } from '../linear/workspace'
import type { Config } from './schema'
import { readFixture, setPath, testCatalog } from './testing'
import { validateConfig } from './validate'
import { validateAgainstWorkspace } from './workspace'

const statuses = (names: string[]) => names.map((name, i) => ({ id: `s${i}`, name, type: 'started' }))
const label = (name: string, teamId: string | null, isGroup = false) => ({
  id: name,
  name,
  isGroup,
  parentId: null,
  teamId,
})

function team(id: string, key: string, names: string[]) {
  return { id, key, name: key, statuses: statuses(names) }
}

const FRG = ['Triage', 'Backlog', 'Todo', 'In Progress', 'In Review', 'Blocked', 'Done', 'Canceled']
const CIV = ['Triage', 'Backlog', 'Ready', 'Doing', 'Review', 'Blocked', 'Done', 'Canceled']

function workspace(): LinearWorkspace {
  return {
    organization: { id: 'o', name: 'H Cloud', urlKey: 'h-cloud', plan: null },
    teams: [team('t1', 'FRG', FRG), team('t2', 'CIV', CIV)],
    labels: [label('business', null), label('frontend', 't1'), label('addon', 't2')],
    projectLabels: [],
    projects: [{ id: 'p', name: 'Omni', state: 'started', milestones: [] }],
    initiatives: [{ id: 'i', name: 'Platform' }],
    templates: [],
  }
}

function config(patch: (data: Record<string, unknown>) => void = () => {}): Config {
  const data = readFixture('valid/full.yaml')
  patch(data)
  const res = validateConfig(data, { catalog: testCatalog(), isGitRepo: () => true, home: '/home/me' })
  if (!res.ok) throw new Error(JSON.stringify(res.errors))
  return res.config
}

describe('validateAgainstWorkspace', () => {
  test('a config that matches the workspace has no errors', () => {
    expect(validateAgainstWorkspace(config(), workspace())).toEqual([])
  })

  test('a team key that does not exist', () => {
    const errors = validateAgainstWorkspace(
      config((d) => setPath(d, 'linear.teams.0.key', 'XXY')),
      workspace(),
    )
    expect(errors).toContainEqual({
      path: 'linear.teams[0].key',
      message: 'no team XXY in workspace h-cloud',
    })
  })

  test('a team without status overrides is checked against the global mapping', () => {
    const errors = validateAgainstWorkspace(
      config((d) => setPath(d, 'linear.teams', [{ key: 'FRG' }])),
      workspace(),
    )
    expect(errors).toEqual([])
  })

  test('a mapped status missing in its team', () => {
    const linear = workspace()
    linear.teams[0] = team(
      't1',
      'FRG',
      FRG.filter((s) => s !== 'Blocked'),
    )
    expect(validateAgainstWorkspace(config(), linear)).toEqual([
      {
        path: 'linear.teams[0].statuses.blocked',
        message: 'status Blocked not found',
        hint: 'nightshift doctor --apply creates it',
      },
    ])
  })

  test('matched initiatives, projects and labels must exist', () => {
    const linear = workspace()
    linear.initiatives = []
    linear.labels = linear.labels.filter((l) => l.name !== 'addon')
    const cfg = config((d) =>
      setPath(d, 'projects.2', {
        match: { team: 'FRG', project: 'Omnni' },
        repositories: ['omni'],
        pipeline: 'bug',
      }),
    )
    expect(validateAgainstWorkspace(cfg, linear)).toEqual([
      { path: 'projects[0].match.initiative', message: "no initiative 'Platform'" },
      { path: 'projects[1].match.label', message: "no label 'addon' in team CIV or the workspace" },
      { path: 'projects[2].match.project', message: "no project 'Omnni'" },
    ])
  })

  test('initiatives that cannot be read are not reported as missing', () => {
    const linear = workspace()
    linear.initiatives = null
    expect(validateAgainstWorkspace(config(), linear)).toEqual([])
  })

  test('a label of another team or a group label does not match', () => {
    const linear = workspace()
    linear.labels = [label('business', null), label('addon', 't1'), label('frontend', null, true)]
    const cfg = config((d) => setPath(d, 'linear.exclude_labels', ['frontend']))
    expect(validateAgainstWorkspace(cfg, linear)).toEqual([
      { path: 'linear.exclude_labels[0]', message: "no label 'frontend' in the workspace" },
      { path: 'projects[1].match.label', message: "no label 'addon' in team CIV or the workspace" },
    ])
  })

  test('a workspace-level label matches any team', () => {
    const cfg = config((d) => setPath(d, 'projects.1.match.label', 'business'))
    expect(validateAgainstWorkspace(cfg, workspace())).toEqual([])
  })

  test('a project matching a team that does not exist', () => {
    const cfg = config((d) => setPath(d, 'projects.1.match.team', 'NOPE'))
    expect(validateAgainstWorkspace(cfg, workspace())).toEqual([
      { path: 'projects[1].match.team', message: 'no team NOPE in workspace h-cloud' },
      { path: 'projects[1].match.label', message: "no label 'addon' in team NOPE or the workspace" },
    ])
  })

  test('exclude labels must exist', () => {
    const cfg = config((d) => setPath(d, 'linear.exclude_labels', ['business', 'legal']))
    expect(validateAgainstWorkspace(cfg, workspace())).toEqual([
      { path: 'linear.exclude_labels[1]', message: "no label 'legal' in the workspace" },
    ])
  })
})
