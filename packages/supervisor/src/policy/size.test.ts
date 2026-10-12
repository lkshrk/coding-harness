import { describe, expect, test } from 'bun:test'
import { issueBody, snapshot, testConfig } from '../testing/testing'
import { issueSize } from './size'
import { viewIssue } from './stages'

const config = testConfig()

const view = (files: string[], over: Partial<Parameters<typeof snapshot>[0]> = {}, goal?: string) => {
  const body = issueBody(files)
  const v = viewIssue(
    snapshot({
      identifier: 'FOR-1',
      description: goal ? body.replace('Do the thing.', goal) : body,
      ...over,
    }),
    config,
  )
  if (!v) throw new Error('unmanaged')
  return v
}

describe('issueSize', () => {
  test('estimate and plain file entries', () => {
    const s = issueSize(view(['a.ts', 'b.ts'], { estimate: 3 }), undefined)
    expect(s).toMatchObject({ estimate: 3, files: 2, risk: [], designVerbs: [], over: [] })
  })

  test('a directory or glob entry counts as 3', () => {
    expect(issueSize(view(['backend/alembic/versions/', 'a.ts', 'src/*.ts']), undefined).files).toBe(7)
  })

  test('entries matching risk_paths are named', () => {
    const s = issueSize(view(['backend/alembic/versions/', 'a.ts']), {
      risk_paths: ['backend/alembic/**'],
    })
    expect(s.risk).toEqual(['backend/alembic/versions/'])
  })

  test('design verbs in the goal', () => {
    const s = issueSize(
      view(['a.ts'], {}, 'Design a certificate model and bind it to the account.'),
      undefined,
    )
    expect(s.designVerbs).toEqual(['design', 'bind … to'])
    expect(issueSize(view(['a.ts']), undefined).designVerbs).toEqual([])
  })

  test('thresholds come from the limits; no limits means never over', () => {
    const v = view(['a/', 'b/', 'c.ts'], { estimate: 8 })
    expect(issueSize(v, undefined).over).toEqual([])
    expect(issueSize(v, undefined, { max_estimate: 5, max_files: 6 }).over).toEqual([
      'estimate 8 > 5',
      'files 7 > 6',
    ])
  })

  test('near the limit: estimate within one or files within two', () => {
    expect(issueSize(view(['a.ts'], { estimate: 4 }), undefined, { max_estimate: 5 }).near).toBe(true)
    expect(issueSize(view(['a/', 'b.ts'], { estimate: 1 }), undefined, { max_files: 6 }).near).toBe(true)
    expect(
      issueSize(view(['a.ts'], { estimate: 1 }), undefined, { max_estimate: 5, max_files: 8 }).near,
    ).toBe(false)
  })
})
