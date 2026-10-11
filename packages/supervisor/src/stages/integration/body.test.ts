import { describe, expect, test } from 'bun:test'
import { snapshot } from '../../testing/testing'
import { type PullRequestBodyInput, pullRequestBody } from './body'

const base = (over: Partial<PullRequestBodyInput> = {}): PullRequestBodyInput => ({
  issue: snapshot({ identifier: 'FOR-1', title: 'Trim names' }),
  runId: 'run-final',
  finish: { summary: 'Disputed the review finding; no code was changed.', concerns: ['finding is wrong'] },
  gates: [],
  review: null,
  unreviewed: null,
  riskPaths: [],
  ...over,
})

const summary = (body: string): string => body.slice(0, body.indexOf('\n## Acceptance criteria'))

describe('pullRequestBody summary across attempts', () => {
  test('has the implementer summary followed by one line per repair that pushed commits', () => {
    const body = pullRequestBody(
      base({
        finish: { summary: 'Fixed the flaky test.', concerns: ['slow test'] },
        attempts: [
          {
            attempt: 1,
            headSha: 'a1',
            finish: { summary: 'Trimmed user names before saving.', concerns: ['slow test'] },
          },
          { attempt: 2, headSha: 'a2', finish: { summary: 'Addressed the review finding.\nMore detail.' } },
          {
            attempt: 3,
            headSha: 'a3',
            finish: { summary: 'Fixed the flaky test.', concerns: ['slow test', 'no e2e'] },
          },
        ],
      }),
    )
    expect(summary(body)).toBe(
      [
        '## Summary',
        'Trimmed user names before saving.',
        '',
        '- Attempt 2: Addressed the review finding. More detail.',
        '- Attempt 3: Fixed the flaky test.',
        '',
        'Concerns:',
        '- slow test',
        '- no e2e',
        '',
      ].join('\n'),
    )
  })

  test('leaves out a repair attempt that pushed no commit', () => {
    const body = pullRequestBody(
      base({
        attempts: [
          { attempt: 1, headSha: 'a1', finish: { summary: 'Trimmed user names before saving.' } },
          { attempt: 2, headSha: 'a2', finish: { summary: 'Addressed the review finding.' } },
          {
            attempt: 3,
            headSha: 'a2',
            finish: {
              summary: 'Disputed the review finding; no code was changed.',
              concerns: ['finding is wrong'],
            },
          },
        ],
      }),
    )
    expect(summary(body)).toBe(
      [
        '## Summary',
        'Trimmed user names before saving.',
        '',
        '- Attempt 2: Addressed the review finding.',
        '',
      ].join('\n'),
    )
    expect(body).not.toContain('Disputed')
    expect(body).not.toContain('finding is wrong')
  })

  test('a single attempt produces the same body as without attempts', () => {
    const finish = { summary: 'Trimmed user names before saving.', concerns: ['slow test'] }
    const single = pullRequestBody(base({ finish, attempts: [{ attempt: 1, headSha: 'a1', finish }] }))
    expect(single).toBe(pullRequestBody(base({ finish })))
    expect(summary(single)).toBe(
      ['## Summary', 'Trimmed user names before saving.', '', 'Concerns:', '- slow test', ''].join('\n'),
    )
  })
})
