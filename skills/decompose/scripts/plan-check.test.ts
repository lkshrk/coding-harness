import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkPlan, type Plan } from './plan-check'

const dir = join(import.meta.dir, 'fixtures')
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Plan
const read = (p: string) => readFileSync(join(dir, p), 'utf8')

test('a valid plan with an ordered blocks edge passes', () => {
  expect(checkPlan(load('clean.json'), read)).toEqual({ errors: [], warnings: [] })
})

test('a blocks cycle is an error naming the loop', () => {
  expect(checkPlan(load('cycle.json'), read).errors).toEqual(['cycle: A → B → A'])
})

test('a missing estimate is an error; overlapping files without a blocks path are a warning', () => {
  const report = checkPlan(load('overlap.json'), read)
  expect(report.errors).toEqual(['C: no estimate'])
  expect(report.warnings).toEqual([
    'A and C touch overlapping files without a blocks path; they will run one after the other',
  ])
})

test('an invalid description and an unknown blocks target are errors', () => {
  const plan: Plan = {
    issues: [{ key: 'A', title: 't', description: 'bad.md', estimate: 1, blocks: ['Z'] }],
  }
  const report = checkPlan(plan, () => '## Goal\nx\n')
  expect(report.errors).toContain('A: blocks unknown issue Z')
  expect(report.errors.some((e) => e.startsWith('A: missing section'))).toBe(true)
})
