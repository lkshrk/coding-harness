import { describe, expect, test } from 'bun:test'
import { selectAgent } from './selection'
import { testConfig } from './testing'

const rules = testConfig().selection

describe('selectAgent', () => {
  test('first matching rule wins', () => {
    expect(selectAgent(rules, { stage: 'implementation', attempt: 1 })).toBe('implementer')
    expect(selectAgent(rules, { stage: 'implementation', issueType: 'bug', attempt: 1 })).toBe('fixer')
    expect(
      selectAgent(rules, {
        stage: 'implementation',
        issueType: 'bug',
        failureClass: 'implementation_defect',
        attempt: 2,
      }),
    ).toBe('repairer')
  })

  test('attempt comparisons', () => {
    expect(selectAgent(rules, { stage: 'implementation', attempt: 3 })).toBe('implementer-strong')
    expect(
      selectAgent([{ when: { attempt: '<=1' }, agent: 'a' }], { stage: 'x', attempt: 2 }),
    ).toBeUndefined()
    expect(selectAgent([{ when: { attempt: '==2' }, agent: 'a' }], { stage: 'x', attempt: 2 })).toBe('a')
  })

  test('a rule that names a failure class or issue type needs it to be present', () => {
    expect(
      selectAgent([{ when: { failure_class: 'environment' }, agent: 'a' }], { stage: 'x', attempt: 1 }),
    ).toBeUndefined()
    expect(
      selectAgent([{ when: { issue_type: ['bug', 'chore'] }, agent: 'a' }], {
        stage: 'x',
        issueType: 'chore',
        attempt: 1,
      }),
    ).toBe('a')
  })

  test('no rule for a stage gives undefined', () => {
    expect(selectAgent(rules, { stage: 'integration', attempt: 1 })).toBeUndefined()
  })
})
