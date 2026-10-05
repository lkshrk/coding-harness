import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { issueSpec } from './spec'
import { validateIssue } from './template'

describe('issueSpec', () => {
  test('maps a parsed feature issue to the context builder input', () => {
    const r = validateIssue(readFileSync(join(import.meta.dir, 'fixtures/valid/feature.md'), 'utf8'))
    if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('\n'))
    const spec = issueSpec('ENG-1', 'Retry queue', r.issue)
    expect(spec.identifier).toBe('ENG-1')
    expect(spec.files).toEqual(r.issue.files)
    expect(spec.verify).toEqual(r.issue.verify)
    expect(spec.acceptance).toEqual(r.issue.acceptance)
    expect(spec.goal).toBe(r.issue.sections.goal)
    expect(spec.designExcerpt?.documentUrl).toBe(r.issue.designLinks[0] as string)
    expect(spec.designExcerpt?.text).toBe(r.issue.sections.design)
  })

  test('no design excerpt when the issue has none', () => {
    const body = [
      '## Goal\ng\n## Why\nw\n## Design excerpt\nnone\n## Interfaces in\nnone\n## Interfaces out\nnone',
      '## Files\n- a.ts\n## Constraints\nnone\n## Out of scope\nnone\n## Acceptance criteria\n- ok',
      '## Tests expected\n- a.test.ts\n## Verify\n- `bun test`',
    ].join('\n')
    const r = validateIssue(body, { allowNoDesign: true })
    if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('\n'))
    expect(issueSpec('ENG-2', 't', r.issue).designExcerpt).toBeUndefined()
  })
})
