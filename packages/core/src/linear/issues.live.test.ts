import { describe, expect, test } from 'bun:test'
import { SecretResolver } from '../secrets'
import { createTokenProvider } from './auth'
import { linearRequest } from './client'
import { LinearIssueReader } from './issues'

const live = process.env.NIGHTSHIFT_LINEAR_LIVE === '1'

describe.skipIf(!live)('Linear issues live (NIGHTSHIFT_LINEAR_LIVE=1)', () => {
  test('reads issues of ROU updated in the last 7 days and the comments of one', async () => {
    const secrets = new SecretResolver({ env: process.env })
    const auth = createTokenProvider(
      {
        mode: 'app',
        client_id: 'rbw:linear-oauth-app#client_id',
        client_secret: 'rbw:linear-oauth-app#client_secret',
      },
      (ref) => secrets.resolve(ref),
    )
    const reader = new LinearIssueReader(linearRequest({ auth }))
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const issues = await reader.issues({
      actOn: { delegated: true, labels: ['route-planner'] },
      updatedSince: since,
    })
    expect(
      issues.every(
        (i) =>
          i.updatedAt >= since &&
          (i.delegated || i.labels.some((l) => l === 'route-planner' || l.endsWith(':route-planner'))),
      ),
    ).toBe(true)
    const first = issues[0]
    const comments = first ? await reader.comments(first.identifier) : []
    console.error(
      JSON.stringify({
        issues: issues.length,
        statuses: [...new Set(issues.map((i) => i.status))].length,
        withProject: issues.filter((i) => i.project).length,
        groupedLabels: issues.flatMap((i) => i.labels).filter((l) => l.includes(':')).length,
        blockers: issues.reduce((n, i) => n + i.blockedBy.length, 0),
        comments: comments.length,
        replies: comments.filter((c) => c.parentId).length,
      }),
    )
  }, 120_000)
})
