import { describe, expect, test } from 'bun:test'
import { issueBody, snapshot, testConfig } from '../testing/testing'
import { blockersSatisfied, filesOverlap, planDispatch } from './ready'
import { viewIssue } from './stages'

const config = testConfig()

const view = (over: Parameters<typeof snapshot>[0]) => {
  const v = viewIssue(snapshot(over), config)
  if (!v) throw new Error('unmanaged')
  return v
}

const files = (...f: string[]) => issueBody(f)

describe('filesOverlap', () => {
  test.each([
    [['src/a.ts'], ['src/a.ts'], true],
    [['src/a.ts'], ['src/b.ts'], false],
    [['src/sync/*.go'], ['src/sync/store.go'], true],
    [['src/sync/*.go'], ['src/ui/view.ts'], false],
    [['src/sync'], ['src/sync/store.go'], true],
    [['src/**'], ['docs/x.md', 'src/deep/y.ts'], true],
    [['src/sync/*.go'], ['src/sync/**/*.go'], true],
    [[], ['src/a.ts'], true],
  ])('%p vs %p → %p', (a, b, expected) => {
    expect(filesOverlap(a, b)).toBe(expected)
    expect(filesOverlap(b, a)).toBe(expected)
  })
})

describe('blockersSatisfied', () => {
  const blocker = (status: string) => ({ identifier: 'FOR-9', team: 'FOR', status })

  test('auto and feature-branch need the blocker done', () => {
    expect(blockersSatisfied(view({ identifier: 'FOR-1', blockedBy: [blocker('Done')] }), config)).toEqual([])
    expect(
      blockersSatisfied(view({ identifier: 'FOR-1', blockedBy: [blocker('In Review')] }), config),
    ).toEqual(['FOR-9'])
  })

  test('manual accepts a blocker in review', () => {
    const project = { id: 'p', name: 'Omni', initiatives: [], labels: ['ai-merge:manual'] }
    expect(
      blockersSatisfied(view({ identifier: 'FOR-1', project, blockedBy: [blocker('In Review')] }), config),
    ).toEqual([])
    expect(
      blockersSatisfied(view({ identifier: 'FOR-1', project, blockedBy: [blocker('In Progress')] }), config),
    ).toEqual(['FOR-9'])
  })

  test('a blocker in another team uses the default mapping; an unknown status is not satisfied', () => {
    expect(
      blockersSatisfied(
        view({
          identifier: 'FOR-1',
          blockedBy: [
            { identifier: 'ABC-1', team: 'ABC', status: 'Done' },
            { identifier: 'ABC-2', team: 'ABC', status: 'Shipped' },
          ],
        }),
        config,
      ),
    ).toEqual(['ABC-2'])
  })
})

describe('planDispatch', () => {
  test('orders by priority, then estimate, then age, and stops at the free slots', () => {
    const a = view({ identifier: 'FOR-1', priority: 3, description: files('a') })
    const b = view({ identifier: 'FOR-2', priority: 1, description: files('b') })
    const c = view({ identifier: 'FOR-3', priority: 3, estimate: 1, description: files('c') })
    const d = view({ identifier: 'FOR-4', priority: 0, description: files('d') })
    const plan = planDispatch({ candidates: [a, b, c, d], running: [], slots: 3, config })
    expect(plan.dispatch.map((v) => v.snapshot.identifier)).toEqual(['FOR-2', 'FOR-3', 'FOR-1'])
    expect(plan.waiting).toEqual([{ identifier: 'FOR-4', reason: 'concurrency limit reached' }])
  })

  test('issues with overlapping file sets in one repository run one after the other', () => {
    const a = view({ identifier: 'FOR-1', description: files('src/sync/*.go') })
    const b = view({ identifier: 'FOR-2', description: files('src/sync/store.go') })
    const plan = planDispatch({ candidates: [a, b], running: [], slots: 3, config })
    expect(plan.dispatch.map((v) => v.snapshot.identifier)).toEqual(['FOR-1'])
    expect(plan.waiting).toEqual([{ identifier: 'FOR-2', reason: 'files overlap FOR-1' }])
  })

  test('running issues count for overlap, other repositories do not', () => {
    const a = view({ identifier: 'FOR-1', description: files('src/a.ts') })
    const plan = planDispatch({
      candidates: [a],
      running: [{ identifier: 'FOR-7', repository: 'omni', files: ['src/*.ts'] }],
      slots: 1,
      config,
    })
    expect(plan.waiting).toEqual([{ identifier: 'FOR-1', reason: 'files overlap FOR-7' }])
    const other = planDispatch({
      candidates: [a],
      running: [{ identifier: 'FOR-7', repository: 'web', files: ['src/*.ts'] }],
      slots: 1,
      config,
    })
    expect(other.dispatch.length).toBe(1)
  })

  test('backlog issues whose blockers are satisfied are unblocked, not dispatched', () => {
    const blocker = { identifier: 'FOR-9', team: 'FOR', status: 'Done' }
    const a = view({ identifier: 'FOR-1', status: 'Backlog', blockedBy: [blocker] })
    const b = view({ identifier: 'FOR-2', status: 'Backlog', blockedBy: [{ ...blocker, status: 'Todo' }] })
    const c = view({ identifier: 'FOR-3', status: 'Todo', blockedBy: [{ ...blocker, status: 'Todo' }] })
    const plan = planDispatch({ candidates: [a, b, c], running: [], slots: 3, config })
    expect(plan.unblocked.map((u) => [u.view.snapshot.identifier, u.by])).toEqual([['FOR-1', ['FOR-9']]])
    expect(plan.dispatch).toEqual([])
    expect(plan.waiting).toEqual([
      { identifier: 'FOR-2', reason: 'blocked by FOR-9' },
      { identifier: 'FOR-3', reason: 'blocked by FOR-9' },
    ])
  })

  test('an issue that fails the template validator is not dispatched', () => {
    const a = view({ identifier: 'FOR-1', description: '## Files\n- a\n' })
    const plan = planDispatch({ candidates: [a], running: [], slots: 1, config })
    expect(plan.dispatch).toEqual([])
    expect(plan.waiting[0]?.reason).toStartWith('invalid issue: missing section ## Goal')
  })

  test('an issue without a repository waits', () => {
    const a = view({ identifier: 'FOR-1', project: null, labels: ['bug', 'ai-stage:implementation'] })
    const plan = planDispatch({ candidates: [a], running: [], slots: 1, config })
    expect(plan.waiting).toEqual([
      { identifier: 'FOR-1', reason: 'no repo: label for a project with several repositories' },
    ])
  })
})
