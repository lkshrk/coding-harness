import { describe, expect, test } from 'bun:test'
import { doctorReport } from '../doctor'
import { optInFilter } from '../issues'
import type { LinearWorkspace } from '../workspace'
import { doctorExpectations, expectedObjects, TEMPLATE_SECTIONS } from './expected'
import { basicTeam, basicWorkspace, testConfig } from './testing'

const ws = basicWorkspace()

describe('expectedObjects', () => {
  test('a triage state sharing Backlog creates no triage status and keeps Backlog a backlog status', () => {
    const base = testConfig()
    const config = {
      ...base,
      linear: { ...base.linear, teams: [{ key: 'FRG', statuses: { triage: 'Backlog' } }] },
    }
    const frg = expectedObjects(config, ws).teams.find((t) => t.key === 'FRG')
    expect(frg?.statuses.filter((s) => s.name === 'Backlog')).toEqual([
      expect.objectContaining({ type: 'backlog' }),
    ])
    expect(frg?.statuses.some((s) => s.type === 'triage')).toBe(false)
  })

  test('maps every lifecycle status of each team to its Linear type, deduplicated by name', () => {
    const e = expectedObjects(testConfig(), ws)
    expect(e.teams.map((t) => t.key)).toEqual(['FRG', 'CIV'])
    expect(e.teams[0]?.statuses.map((s) => `${s.name}/${s.type}`)).toEqual([
      'Backlog/backlog',
      'Todo/unstarted',
      'In Progress/started',
      'In Review/started',
      'Blocked/started',
      'Done/completed',
      'Canceled/canceled',
      'Triage/triage',
    ])
    expect(e.teams[1]?.statuses.map((s) => s.name)).toEqual([
      'Backlog',
      'Todo',
      'In Progress',
      'Waiting',
      'Done',
      'Canceled',
      'Triage',
    ])
  })

  test('statuses are expected for every workspace team, with per-team overrides', () => {
    const e = expectedObjects(testConfig(), basicWorkspace({ teams: ['FRG', 'CIV', 'ROU'].map(basicTeam) }))
    const blocked = e.teams.map((t) => `${t.key}:${t.statuses.find((s) => s.color === '#eb5757')?.name}`)
    expect(blocked).toEqual(['FRG:Blocked', 'CIV:Waiting', 'ROU:Blocked'])
  })

  test('two lifecycle states sharing a name expect one status', () => {
    const civ = expectedObjects(testConfig(), ws).teams.find((t) => t.key === 'CIV')
    expect(civ?.statuses.filter((s) => s.name === 'In Progress')).toHaveLength(1)
  })

  test('issue label groups come from the configured stages; ai-merge is a project label group', () => {
    const e = expectedObjects(testConfig(), ws)
    expect(e.labelGroups).toEqual([{ name: 'ai-stage', labels: ['intake', 'design', 'implementation'] }])
    expect(e.projectLabelGroups).toEqual([{ name: 'ai-merge', labels: ['manual', 'auto', 'feature-branch'] }])
  })

  test('the act_on labels are plain workspace labels', () => {
    expect(expectedObjects(testConfig(), ws).labels).toEqual(['autopilot'])
  })

  test('the repo group holds only repositories of projects with several repositories', () => {
    const e = expectedObjects(
      testConfig({ projects: [{ repositories: ['omni'] }, { repositories: ['cms', 'cms-ui'] }] }),
      ws,
    )
    expect(e.labelGroups.find((g) => g.name === 'repo')).toEqual({
      name: 'repo',
      labels: ['cms', 'cms-ui'],
    })
  })

  test('the agent template carries every section heading with its hint in parentheses', () => {
    const { templates } = expectedObjects(testConfig(), ws)
    expect(templates.map((t) => `${t.type}:${t.name}`)).toEqual(['issue:Agent task'])
    const headings = templates[0]?.description.split('\n').filter((l) => l.startsWith('## '))
    expect(headings).toEqual(TEMPLATE_SECTIONS.map(([h, hint]) => `## ${h} (${hint})`))
    expect(templates[0]?.description).not.toContain('<!--')
  })

  test('views filter opted-in issues by the configured status names', () => {
    const views = expectedObjects(testConfig(), ws).views
    expect(views.map((v) => v.name)).toEqual(['Needs me', 'Running', 'Ready', 'In Review'])
    expect(views[0]?.filter).toEqual({
      and: [
        optInFilter({ delegated: true, labels: ['autopilot'] }),
        { state: { name: { in: ['Blocked', 'Waiting'] } } },
      ],
    })
  })

  test('manual mode creates no views', () => {
    const base = testConfig()
    const manual = { ...base, linear: { ...base.linear, act_on: { delegated: false, labels: [] } } }
    expect(expectedObjects(manual, ws).views).toEqual([])
  })

  test('doctorExpectations feeds doctorReport the same objects', () => {
    const empty: LinearWorkspace = {
      organization: { id: 'o', name: 'h-cloud', urlKey: 'h-cloud', plan: 'basic' },
      teams: [{ id: 't', key: 'FRG', name: 'Forge', statuses: [] }],
      labels: [],
      projectLabels: [],
      projects: [],
      initiatives: [],
      templates: [],
    }
    const e = expectedObjects(testConfig(), empty)
    const codes = doctorReport(empty, doctorExpectations(e)).findings.map((f) => f.code)
    expect(codes).toContain('status_missing')
    expect(codes).toContain('label_group_missing')
    expect(codes).toContain('project_label_group_missing')
    expect(codes).toContain('label_missing')
    expect(codes).toContain('template_missing')
    expect(doctorExpectations(e).teams[0]?.statuses).toContain('Blocked')
  })
})
