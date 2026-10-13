import { describe, expect, test } from 'bun:test'
import type { BlockerRef } from '../ports'
import { issueBody, snapshot, testConfig } from '../testing/testing'
import { validatePlan } from './plan'

const config = testConfig()

const ref = (identifier: string, status = 'Todo'): BlockerRef => ({ identifier, team: 'FOR', status })

const issue = (identifier: string, over: Partial<Parameters<typeof snapshot>[0]> = {}) =>
  snapshot({ identifier, estimate: 2, description: issueBody([`src/${identifier}.ts`]), ...over })

describe('validatePlan', () => {
  test('a blocking cycle is one error starting at its smallest identifier; its issues wait', () => {
    const report = validatePlan(
      [
        issue('FOR-2', { blockedBy: [ref('FOR-1')] }),
        issue('FOR-1', { blockedBy: [ref('FOR-2')] }),
        issue('FOR-3'),
      ],
      config,
    )
    expect(report.errors).toEqual(['cycle: FOR-1 → FOR-2 → FOR-1'])
    expect(report.ready).toEqual(['FOR-3'])
    expect(report.waiting).toEqual(['FOR-1', 'FOR-2'])
  })

  test('a three-issue cycle and a self-block are reported once each', () => {
    const report = validatePlan(
      [
        issue('FOR-7', { blockedBy: [ref('FOR-9')] }),
        issue('FOR-8', { blockedBy: [ref('FOR-7')] }),
        issue('FOR-9', { blockedBy: [ref('FOR-8')] }),
        issue('FOR-10', { blockedBy: [ref('FOR-10')] }),
      ],
      config,
    )
    expect(report.errors).toEqual(['cycle: FOR-7 → FOR-8 → FOR-9 → FOR-7', 'cycle: FOR-10 → FOR-10'])
    expect(report.ready).toEqual([])
  })

  test.each([
    [
      'template error',
      { description: issueBody().replace(/## Verify[\s\S]*$/, '') },
      'FOR-1: missing section ## Verify',
    ],
    ['missing estimate', { estimate: null }, 'FOR-1: no estimate'],
  ])('%s is reported with the identifier', (_, over, error) => {
    const report = validatePlan([issue('FOR-1', over), issue('FOR-2')], config)
    expect(report.errors).toEqual([error])
  })

  test('a design-less issue is allowed', () => {
    const description = issueBody().replace(/\[design\]\([^)]*\) section 2/, 'none')
    expect(validatePlan([issue('FOR-1', { description })], config).errors).toEqual([])
  })

  test('closed issues are not checked', () => {
    const report = validatePlan(
      [
        issue('FOR-1', { status: 'Done', estimate: null, description: 'x' }),
        issue('FOR-2', { status: 'Canceled' }),
      ],
      config,
    )
    expect(report).toEqual({ errors: [], warnings: [], ready: [], waiting: [] })
  })

  test('two ready issues with overlapping files give one warning and no error', () => {
    const report = validatePlan(
      [
        issue('FOR-1', { description: issueBody(['src/sync/*.go']) }),
        issue('FOR-2', { description: issueBody(['src/sync/a.go']) }),
      ],
      config,
    )
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      'FOR-1 and FOR-2 both touch src/sync/*.go, src/sync/a.go; they will run one after the other',
    ])
  })

  test('no overlap warning for issues with a blocking path or template errors', () => {
    const files = issueBody(['src/a.ts'])
    const report = validatePlan(
      [
        issue('FOR-1', { description: files }),
        issue('FOR-4', { status: 'Done', blockedBy: [ref('FOR-1')] }),
        issue('FOR-2', { description: files, blockedBy: [ref('FOR-4', 'Done')] }),
        issue('FOR-3', { description: files.replace(/## Verify[\s\S]*$/, '') }),
      ],
      config,
    )
    expect(report.warnings).toEqual([])
  })

  test('blockers: done in the set or outside it count; review and open blockers do not', () => {
    const report = validatePlan(
      [
        issue('FOR-1', { status: 'Done' }),
        issue('FOR-2', { blockedBy: [ref('FOR-1', 'Todo')] }),
        issue('FOR-3', { blockedBy: [ref('OUT-1', 'Done')] }),
        issue('FOR-4', { blockedBy: [ref('OUT-2', 'In Review')] }),
        issue('FOR-5', { blockedBy: [ref('FOR-2')] }),
        issue('FOR-6', { status: 'In Review' }),
      ],
      config,
    )
    expect(report.ready).toEqual(['FOR-2', 'FOR-3', 'FOR-6'])
    expect(report.waiting).toEqual(['FOR-4', 'FOR-5'])
    expect(report.errors).toEqual([])
  })
})
