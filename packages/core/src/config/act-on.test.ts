import { describe, expect, test } from 'bun:test'
import { formatError } from './errors'
import { teamStatuses } from './schema'
import { minimalCatalog, readFixture, setPath, unsetPath } from './testing'
import { type ValidateContext, validateConfig } from './validate'

const ctx: ValidateContext = { catalog: minimalCatalog(), isGitRepo: () => true, home: '/home/me' }

function load(edit: (data: Record<string, unknown>) => void = () => {}) {
  const data = readFixture('valid/minimal.yaml')
  edit(data)
  return validateConfig(data, ctx)
}

describe('linear.act_on', () => {
  test('defaults to delegated issues and the autopilot label', () => {
    const res = load()
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.config.linear.act_on).toEqual({ delegated: true, labels: ['autopilot'] })
  })

  test('labels only', () => {
    const res = load((d) => setPath(d, 'linear.act_on', { delegated: false, labels: ['ai-ready'] }))
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.config.linear.act_on).toEqual({ delegated: false, labels: ['ai-ready'] })
  })

  test('both routes off is manual mode and valid', () => {
    const res = load((d) => setPath(d, 'linear.act_on', { delegated: false, labels: [] }))
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.config.linear.act_on).toEqual({ delegated: false, labels: [] })
  })
})

describe('linear statuses', () => {
  test('teams may be omitted and every team uses the default mapping', () => {
    const res = load((d) => unsetPath(d, 'linear.teams'))
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(res.config.linear.teams).toEqual([])
    expect(teamStatuses(res.config, 'ANY')).toEqual({
      triage: 'Backlog',
      backlog: 'Backlog',
      ready: 'Todo',
      running: 'In Progress',
      review: 'In Review',
      blocked: 'Blocked',
      done: 'Done',
      canceled: 'Canceled',
    })
  })

  test('a team override replaces only the states it names', () => {
    const res = load((d) => setPath(d, 'linear.teams', [{ key: 'CIV', statuses: { blocked: 'Waiting' } }]))
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(teamStatuses(res.config, 'CIV').blocked).toBe('Waiting')
    expect(teamStatuses(res.config, 'CIV').ready).toBe('Todo')
    expect(teamStatuses(res.config, 'ROU').blocked).toBe('Blocked')
  })

  test('the default mapping itself can be changed', () => {
    const res = load((d) => setPath(d, 'linear.statuses', { ready: 'Ready' }))
    if (!res.ok) throw new Error(res.errors.map(formatError).join('\n'))
    expect(teamStatuses(res.config, 'ROU').ready).toBe('Ready')
    expect(teamStatuses(res.config, 'ROU').done).toBe('Done')
  })
})
