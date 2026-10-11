import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importBundle } from '../adapters/git/host'
import type { Classifier, FailureSignal } from '../ports'
import { attemptsOf } from '../stages/context'
import { git } from '../stages/gates/testing'
import { FINISH, fakeThread, gate, integrationHarness, until } from '../stages/integration/testing'
import type { Run } from '../state/runs'
import { issueBody, snapshot } from '../testing/testing'

describe('pull request watching', () => {
  async function watching(extra: Parameters<typeof integrationHarness>[2] = {}) {
    const root = mkdtempSync(join(tmpdir(), 'ns-watch-'))
    const h = integrationHarness(root, (c) => c, extra)
    const run = await h.integrated()
    return { ...h, run, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  test('checks turning green log CI_PASSED once', async () => {
    const h = await watching()
    try {
      h.gh.checks = [{ name: 'build', bucket: 'pending' }]
      await h.first.tick()
      expect(h.of('CI_PASSED')).toEqual([])
      h.gh.checks = [{ name: 'build', bucket: 'pass' }]
      await h.first.tick()
      await h.first.tick()
      expect(h.of('CI_PASSED').map((e) => [e.issue, e.run, e.data])).toEqual([
        ['FOR-1', h.run.id, { url: 'https://github.com/lkshrk/omni/pull/1' }],
      ])
      expect(h.gh.ciReads()).toHaveLength(2)
    } finally {
      h.cleanup()
    }
  })

  test('a failing check logs CI_FAILED with the check names and remediates with ci_failed', async () => {
    const signals: FailureSignal[] = []
    const classifier: Classifier = {
      async classify(f) {
        signals.push(f)
        return { class: 'implementation_defect', action: 'retry_same' }
      },
    }
    const h = await watching({ classifier })
    try {
      h.gh.checks = [
        { name: 'build', bucket: 'pass' },
        { name: 'e2e', bucket: 'fail' },
      ]
      await h.first.tick()
      await h.first.tick()
      expect(h.of('CI_FAILED').map((e) => e.data)).toEqual([
        {
          url: 'https://github.com/lkshrk/omni/pull/1',
          failed_checks: ['e2e'],
          failures: [{ name: 'e2e', url: 'https://github.com/lkshrk/omni/pull/1' }],
        },
      ])
      expect(signals).toEqual([])
      expect(h.of('FAILURE_CLASSIFIED').at(-1)?.data).toEqual({
        class: 'implementation_defect',
        action: 'retry_same',
        evidence: 'failed checks: e2e',
        fallback: false,
      })
      expect(h.linear.get('FOR-1')).toMatchObject({ status: 'Todo', labels: ['ai-stage:implementation'] })
      const marker = `<!-- nightshift:${h.of('CI_FAILED')[0]?.id} -->`
      expect((await h.linear.comments('FOR-1')).filter((c) => c.body.includes(marker))).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('a failing check hands its job log excerpt to the repair attempt, not to the event log', async () => {
    const h = await watching()
    try {
      h.gh.checks = [{ name: 'quality', bucket: 'fail', run: 5, job: 77 }]
      h.gh.logs['job 77'] =
        'quality\tTest\t2026-10-05T10:00:01Z (fail) stable locator contract\nquality\tTest\t2026-10-05T10:00:01Z error: expected "a" got "b"'
      await h.first.tick()
      const url = 'https://github.com/lkshrk/omni/actions/runs/5/job/77'
      expect(h.of('CI_FAILED').map((e) => e.data)).toEqual([
        {
          url: 'https://github.com/lkshrk/omni/pull/1',
          failed_checks: ['quality'],
          failures: [{ name: 'quality', url }],
        },
      ])
      expect(JSON.stringify(h.first.log.since(null, {}))).not.toContain('stable locator contract')
      const [attempt] = attemptsOf(h.db, 'FOR-1', 'next')
      expect(attempt?.ciFailures).toEqual([
        { name: 'quality', url, log: '(fail) stable locator contract\nerror: expected "a" got "b"' },
      ])
    } finally {
      h.cleanup()
    }
  })

  test('checks that also fail on the base sha hold the issue as base_failed with no repair run', async () => {
    const h = await watching({ retry: { baseMs: 0, maxMs: 0 } })
    try {
      h.gh.checks = [
        { name: 'build', bucket: 'pass' },
        { name: 'pip-audit', bucket: 'fail' },
      ]
      h.gh.baseChecks = [
        { name: 'build', bucket: 'pass' },
        { name: 'pip-audit', bucket: 'fail' },
      ]
      await h.first.tick()
      await h.first.tick()
      await h.first.tick()
      expect(h.of('CI_FAILED')).toHaveLength(1)
      expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(1)
      expect(h.first.runs.get(h.run.id)?.failure).toBeNull()
      expect(h.first.awaiting('FOR-1')).toEqual({
        kind: 'escalated',
        stage: 'integration',
        reason: 'base_failed',
      })
      expect(h.linear.get('FOR-1').status).toBe('Blocked')
      const sent = h.of('NOTIFICATION_SENT').filter((e) => String(e.data.title).includes('base'))
      expect(sent).toHaveLength(1)
      expect(sent[0]?.data.title).toContain(h.gh.baseSha)
      const comments = (await h.linear.comments('FOR-1')).filter((c) => c.body.includes(h.gh.baseSha))
      expect(comments).toHaveLength(1)
      expect(comments[0]?.body).toContain('pip-audit')
    } finally {
      h.cleanup()
    }
  })

  test('another poll failing on the same base sha sends no second notification', async () => {
    const h = await watching()
    try {
      h.gh.checks = [{ name: 'pip-audit', bucket: 'fail' }]
      h.gh.baseChecks = [{ name: 'pip-audit', bucket: 'fail' }]
      await h.first.tick()
      const pr = h.first.pullRequests.get('FOR-1')
      if (!pr) throw new Error('no PR')
      h.first.pullRequests.put({ ...pr, ci: 'pending' })
      await h.first.tick()
      const sent = h.of('NOTIFICATION_SENT').filter((e) => String(e.data.title).includes('fails on base'))
      expect(sent).toHaveLength(1)
      expect(h.of('CI_FAILED')).toHaveLength(2)
      expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  test('checks that pass on the base sha keep the ci_failed remediation', async () => {
    const h = await watching()
    try {
      h.gh.checks = [{ name: 'e2e', bucket: 'fail' }]
      h.gh.baseChecks = [{ name: 'e2e', bucket: 'pass' }]
      await h.first.tick()
      expect(h.of('FAILURE_CLASSIFIED').map((e) => e.data)).toEqual([
        {
          class: 'implementation_defect',
          action: 'retry_same',
          evidence: 'failed checks: e2e',
          fallback: false,
        },
      ])
      expect(h.first.awaiting('FOR-1')).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('a base sha without a completed run keeps the ci_failed remediation', async () => {
    const h = await watching()
    try {
      h.gh.checks = [{ name: 'e2e', bucket: 'fail' }]
      h.gh.baseChecks = [{ name: 'e2e', bucket: 'pending' }]
      await h.first.tick()
      expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(1)
      expect(h.first.awaiting('FOR-1')).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('after a base_failed hold a retry on the fixed base continues normally', async () => {
    const h = await watching({ retry: { baseMs: 0, maxMs: 0 } })
    try {
      h.gh.checks = [{ name: 'pip-audit', bucket: 'fail' }]
      h.gh.baseChecks = [{ name: 'pip-audit', bucket: 'fail' }]
      await h.first.tick()
      expect(h.first.awaiting('FOR-1')?.reason).toBe('base_failed')
      h.gh.baseSha = 'f1xed'
      h.gh.baseChecks = [{ name: 'pip-audit', bucket: 'pass' }]
      h.gh.checks = [{ name: 'pip-audit', bucket: 'pass' }]
      const retried = await h.first.retryRun('FOR-1', {}, 'cli')
      expect(h.first.awaiting('FOR-1')).toBeNull()
      expect(retried.id).not.toBe(h.run.id)
      const head = await repaired(h, {})
      expect(h.first.pullRequests.get('FOR-1')?.headSha).toBe(head)
      await h.first.tick()
      expect(h.of('CI_PASSED')).toHaveLength(1)
      expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
      expect(h.first.awaiting('FOR-1')).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('a merge logs MERGED, sets done and unblocks an issue blocked only by it', async () => {
    const h = await watching()
    try {
      h.first.cover('FOR-1')
      h.linear.put(
        snapshot({
          identifier: 'FOR-2',
          status: 'Backlog',
          blockedBy: [{ identifier: 'FOR-1', team: 'FOR', status: 'In Review' }],
          description: issueBody(['src/other.ts']),
        }),
      )
      expect((await h.first.tick()).unblocked).toEqual([])
      ;(h.gh.prs[0] as { state: string }).state = 'MERGED'
      const report = await h.first.tick()
      expect(h.of('MERGED').map((e) => [e.issue, e.data])).toEqual([
        [
          'FOR-1',
          {
            url: 'https://github.com/lkshrk/omni/pull/1',
            branch: 'ns/FOR-1',
            account: 'agent',
            mode: 'manual',
          },
        ],
      ])
      expect(h.of('STAGE_COMPLETED').at(-1)?.data).toEqual({ stage: 'integration' })
      expect(h.linear.get('FOR-1').status).toBe('Done')
      expect(h.first.covered()).not.toContain('FOR-1')
      expect(report.unblocked).toEqual(['FOR-2'])
      expect(h.of('DEPENDENCY_UNBLOCKED').map((e) => [e.issue, e.data])).toEqual([
        ['FOR-2', { by: ['FOR-1'] }],
      ])
      expect((await h.first.tick()).dispatched).toEqual(['FOR-2'])
      expect(h.first.pullRequests.all()).toEqual([])
      await h.first.tick()
      expect(h.gh.gh('view').length - h.gh.ciReads().length).toBe(2)
    } finally {
      h.cleanup()
    }
  })

  test('a PR closed without merge blocks the issue for you with one comment', async () => {
    const h = await watching()
    try {
      ;(h.gh.prs[0] as { state: string }).state = 'CLOSED'
      await h.first.tick()
      await h.first.tick()
      expect(h.linear.get('FOR-1').status).toBe('Blocked')
      expect(h.first.awaiting('FOR-1')).toEqual({ kind: 'escalated', stage: 'integration' })
      const closed = (await h.linear.comments('FOR-1')).filter((c) =>
        c.body.includes('closed without merging'),
      )
      expect(closed).toHaveLength(1)
      expect(h.gh.gh('create')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('an issue moved to Done or Canceled by hand stops watching its PR', async () => {
    const h = await watching()
    try {
      h.linear.patch('FOR-1', { status: 'Canceled' })
      await h.first.tick()
      await h.first.tick()
      expect(h.gh.gh('view')).toEqual([])
      expect(h.first.pullRequests.all()).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  test('an issue already Done by the GitHub automation still takes the merge path', async () => {
    const h = await watching()
    try {
      ;(h.gh.prs[0] as { state: string }).state = 'MERGED'
      h.linear.patch('FOR-1', { status: 'Done' })
      await h.first.tick()
      expect(h.of('MERGED')).toHaveLength(1)
      expect(h.of('STAGE_COMPLETED').at(-1)?.data).toEqual({ stage: 'integration' })
      expect(h.first.pullRequests.all()).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  test('an issue moved to Done by hand with an open PR stops watching it', async () => {
    const h = await watching()
    try {
      h.linear.patch('FOR-1', { status: 'Done' })
      await h.first.tick()
      expect(h.of('MERGED')).toEqual([])
      expect(h.first.pullRequests.all()).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  async function repaired(h: Awaited<ReturnType<typeof watching>>, report: unknown, commit = true) {
    const repair = h.first.runs.forIssue('FOR-1').at(-1) as Run
    expect(repair.id).not.toBe(h.run.id)
    if (commit) git(h.fx.worker, 'commit', '-q', '--allow-empty', '-m', 'fix: trim before saving')
    await h.first.workerStarted(repair.id, { sandbox: 'sb-2', session: 's-2' })
    await h.first.workerFinished(repair.id, { ...FINISH, report })
    const head = importBundle(h.fx.checkout, h.fx.bundle('run2').bundle, h.fx.branch, repair.id)
    await h.first.headImported(repair.id, head)
    await h.first.gatesFinished(repair.id, [gate('test')])
    await h.first.reviewFinished(repair.id, {
      kind: 'verdict',
      review: { verdict: 'pass', findings: [] },
      model: 'glm',
    })
    await h.first.tick()
    await until(() => h.first.pullRequests.get('FOR-1')?.headSha === head, 'PR head updated')
    return head
  }

  test('an unresolved review thread starts one remediation run carrying the thread verbatim', async () => {
    const h = await watching({ retry: { baseMs: 0, maxMs: 0 } })
    try {
      h.gh.checks = [{ name: 'build', bucket: 'pass' }]
      h.gh.threads = [fakeThread('T1', 11, 'Trim the name before saving.')]
      await h.first.tick()
      expect(h.of('FAILURE_CLASSIFIED').map((e) => e.data)).toEqual([
        {
          class: 'implementation_defect',
          action: 'retry_same',
          evidence: '1 unresolved review thread on https://github.com/lkshrk/omni/pull/1',
          fallback: false,
        },
      ])
      const [attempt] = attemptsOf(h.db, 'FOR-1', 'next')
      expect(attempt?.reviewThreads).toEqual([
        {
          id: 'T1',
          resolved: false,
          outdated: false,
          path: 'src/b.ts',
          line: 1,
          comments: [{ id: 11, author: 'agent-npa', body: 'Trim the name before saving.' }],
        },
      ])
      await h.first.tick()
      await h.first.tick()
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(2)
      expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('resolved and outdated threads start no run, and a repeated poll starts none', async () => {
    const h = await watching()
    try {
      h.gh.checks = [{ name: 'build', bucket: 'pass' }]
      h.gh.threads = [
        fakeThread('T1', 11, 'done', { isResolved: true }),
        fakeThread('T2', 21, 'old line', { isOutdated: true }),
      ]
      await h.first.tick()
      await h.first.tick()
      expect(h.gh.threadReads()).toHaveLength(2)
      expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('addressed threads get a reply naming the pushed commit and are resolved', async () => {
    const h = await watching({ retry: { baseMs: 0, maxMs: 0 } })
    try {
      h.gh.checks = [{ name: 'build', bucket: 'pass' }]
      h.gh.threads = [fakeThread('T1', 11, 'Trim the name before saving.')]
      await h.first.tick()
      await h.first.tick()
      const head = await repaired(h, {
        threads: [{ id: 'T1', outcome: 'addressed', reason: 'Names are trimmed in save().' }],
      })
      const [thread] = h.gh.threads
      expect(thread?.isResolved).toBe(true)
      expect(thread?.comments.at(-1)?.body).toBe(`Fixed in ${head}. Names are trimmed in save().`)
      expect(thread?.comments.at(-1)?.body).not.toMatch(/claude|co-authored|generated (with|by)|\bAI\b/i)
      expect(h.linear.get('FOR-1').status).toBe('In Review')
      expect(h.first.awaiting('FOR-1')).toBeNull()
      const runs = h.first.runs.forIssue('FOR-1').length
      await h.first.tick()
      await h.first.tick()
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(runs)
    } finally {
      h.cleanup()
    }
  })

  test('a thread posted during the repair starts its own round after the close-out', async () => {
    const h = await watching({ retry: { baseMs: 0, maxMs: 0 } })
    try {
      h.gh.checks = [{ name: 'build', bucket: 'pass' }]
      h.gh.threads = [fakeThread('T1', 11, 'Trim the name before saving.')]
      await h.first.tick()
      await h.first.tick()
      h.gh.threads.push(fakeThread('T2', 30, 'Also reject empty names.'))
      await repaired(h, {
        threads: [{ id: 'T1', outcome: 'addressed', reason: 'Names are trimmed in save().' }],
      })
      expect(h.gh.threads[0]?.isResolved).toBe(true)
      const runs = h.first.runs.forIssue('FOR-1').length
      await h.first.tick()
      await h.first.tick()
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(runs + 1)
      expect(h.of('FAILURE_CLASSIFIED').at(-1)?.data).toMatchObject({
        evidence: '1 unresolved review thread on https://github.com/lkshrk/omni/pull/1',
      })
      const latest = h.first.runs.forIssue('FOR-1').at(-1) as Run
      const attempts = attemptsOf(h.db, 'FOR-1', latest.id)
      expect(attempts.at(-1)?.reviewThreads?.map((t) => t.id)).toEqual(['T2'])
    } finally {
      h.cleanup()
    }
  })

  test('a thread that gets a new reviewer comment during the repair stays open for its own round', async () => {
    const h = await watching({ retry: { baseMs: 0, maxMs: 0 } })
    try {
      h.gh.checks = [{ name: 'build', bucket: 'pass' }]
      h.gh.threads = [fakeThread('T1', 11, 'Trim the name before saving.')]
      await h.first.tick()
      await h.first.tick()
      h.gh.threads[0]?.comments.push({
        databaseId: 30,
        author: { login: 'agent-npa' },
        body: 'Also reject empty names.',
      })
      const head = await repaired(h, {
        threads: [{ id: 'T1', outcome: 'addressed', reason: 'Names are trimmed in save().' }],
      })
      const [thread] = h.gh.threads
      expect(thread?.isResolved).toBe(false)
      expect(thread?.comments.at(-1)?.body).toBe(`Fixed in ${head}. Names are trimmed in save().`)
      expect(h.first.awaiting('FOR-1')).toBeNull()
      const runs = h.first.runs.forIssue('FOR-1').length
      await h.first.tick()
      await h.first.tick()
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(runs + 1)
      const latest = h.first.runs.forIssue('FOR-1').at(-1) as Run
      const attempts = attemptsOf(h.db, 'FOR-1', latest.id)
      expect(attempts.at(-1)?.reviewThreads?.map((t) => t.comments.map((c) => c.id))).toEqual([
        [11, 30, expect.any(Number)],
      ])
    } finally {
      h.cleanup()
    }
  })

  test('a thread with an existing discussion is replied to at its root comment', async () => {
    const h = await watching({ retry: { baseMs: 0, maxMs: 0 } })
    try {
      h.gh.checks = [{ name: 'build', bucket: 'pass' }]
      const discussed = fakeThread('T1', 11, 'Trim the name before saving.')
      discussed.comments.push({ databaseId: 12, author: { login: 'lkshrk' }, body: 'Agreed, please trim.' })
      h.gh.threads = [discussed]
      await h.first.tick()
      await h.first.tick()
      const head = await repaired(h, {
        threads: [{ id: 'T1', outcome: 'addressed', reason: 'Names are trimmed in save().' }],
      })
      const replies = h.gh.calls.filter((c) => c.cmd[4]?.endsWith('/replies')).map((c) => c.cmd[4])
      expect(replies).toEqual(['repos/lkshrk/omni/pulls/1/comments/11/replies'])
      const [thread] = h.gh.threads
      expect(thread?.isResolved).toBe(true)
      expect(thread?.comments.at(-1)?.body).toBe(`Fixed in ${head}. Names are trimmed in save().`)
    } finally {
      h.cleanup()
    }
  })

  test('a disputed thread gets a reply with the reason, stays open and holds the issue', async () => {
    const h = await watching({ retry: { baseMs: 0, maxMs: 0 } })
    try {
      h.gh.checks = [{ name: 'build', bucket: 'pass' }]
      h.gh.threads = [
        fakeThread('T1', 11, 'Trim the name before saving.'),
        fakeThread('T2', 21, 'Lower-case the name.'),
      ]
      await h.first.tick()
      await h.first.tick()
      await repaired(h, {
        threads: [
          { id: 'T1', outcome: 'addressed', reason: 'Names are trimmed in save().' },
          { id: 'T2', outcome: 'disputed', reason: 'Names are case-sensitive by design.' },
        ],
      })
      const [fixed, disputed] = h.gh.threads
      expect(fixed?.isResolved).toBe(true)
      expect(disputed?.isResolved).toBe(false)
      expect(disputed?.comments.at(-1)?.body).toBe('Not changed: Names are case-sensitive by design.')
      expect(h.linear.get('FOR-1').status).toBe('Blocked')
      expect(h.first.awaiting('FOR-1')).toEqual({
        kind: 'escalated',
        stage: 'integration',
        reason: 'review_disputed',
      })
      const runs = h.first.runs.forIssue('FOR-1').length
      await h.first.tick()
      await h.first.tick()
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(runs)
      expect(disputed?.comments).toHaveLength(2)
    } finally {
      h.cleanup()
    }
  })

  async function conflicted() {
    const root = mkdtempSync(join(tmpdir(), 'ns-watch-'))
    const repos = {
      base: '',
      head: '',
      files: ['ARCHITECTURE.md'],
      fetched: [] as string[],
      inspected: [] as string[],
      fetchFails: false,
      baseSha: async () => repos.base,
      fetchPullRequest: async (_: string, pr: { branch: string }) => {
        if (repos.fetchFails) throw new Error('git fetch: could not read from remote')
        repos.fetched.push(pr.branch)
        return repos.head
      },
      conflictingFiles: async (_: string, _base: string, head: string) => {
        repos.inspected.push(head)
        if (!repos.fetched.length) throw new Error(`git merge-tree: not a valid object name ${head}`)
        return repos.files
      },
    }
    const h = integrationHarness(root, (c) => c, { repos, retry: { baseMs: 0, maxMs: 0 } })
    repos.base = h.fx.base
    const run = await h.integrated()
    repos.head = run.headSha ?? ''
    const pr = h.gh.prs[0] as { mergeable?: string }
    pr.mergeable = 'CONFLICTING'
    const moved = () => git(h.fx.checkout, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'moved')
    return { ...h, run, repos, pr, moved, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  test('a conflicting PR starts one pr_conflict remediation naming the base sha and the files', async () => {
    const h = await conflicted()
    try {
      await h.first.tick()
      const detail = `base ${h.fx.base} conflicts in: ARCHITECTURE.md`
      expect(h.of('FAILURE_CLASSIFIED').map((e) => e.data)).toEqual([
        { class: 'implementation_defect', action: 'retry_same', evidence: detail, fallback: false },
      ])
      const [attempt] = attemptsOf(h.db, 'FOR-1', 'next')
      expect(attempt?.prConflict).toEqual({ base: h.fx.base, files: ['ARCHITECTURE.md'] })
      await h.first.tick()
      await h.first.tick()
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(2)
      expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(1)
      expect(h.executor.starts.at(-1)?.repairFrom).toEqual({
        run: h.run.id,
        headSha: h.run.headSha ?? '',
        resolveConflicts: true,
      })
    } finally {
      h.cleanup()
    }
  })

  test('unknown mergeability starts no run', async () => {
    const h = await conflicted()
    try {
      h.pr.mergeable = 'UNKNOWN'
      await h.first.tick()
      await h.first.tick()
      expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('unknown mergeability defers failed CI and fresh review threads to a later poll', async () => {
    const h = await conflicted()
    try {
      h.pr.mergeable = 'UNKNOWN'
      h.gh.checks = [{ name: 'build', bucket: 'fail' }]
      h.gh.threads = [fakeThread('T1', 11, 'Trim the name before saving.')]
      await h.first.tick()
      await h.first.tick()
      expect(h.of('CI_FAILED')).toEqual([])
      expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('conflicting files are read from the fetched PR head, and a failed fetch starts no round yet', async () => {
    const h = await conflicted()
    try {
      h.repos.fetchFails = true
      await h.first.tick()
      expect(h.of('FAILURE_CLASSIFIED')).toEqual([])
      expect(h.first.pullRequests.get('FOR-1')?.conflict).toBeUndefined()
      h.repos.fetchFails = false
      await h.first.tick()
      expect(h.repos.fetched).toEqual([h.first.pullRequests.get('FOR-1')?.branch ?? ''])
      expect(h.repos.inspected.at(-1)).toBe(h.run.headSha ?? '')
      expect(h.first.pullRequests.get('FOR-1')?.conflict?.files).toEqual(['ARCHITECTURE.md'])
      expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('repeated polls of a conflict on the same base sha start one round, a new base sha a new one', async () => {
    const h = await conflicted()
    try {
      await h.first.tick()
      await h.first.tick()
      await h.first.tick()
      expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(1)
      await repaired(h, {})
      expect(h.first.pullRequests.get('FOR-1')?.conflict?.base).toBe(h.fx.base)
      const moved = h.moved()
      h.repos.base = moved
      await h.first.tick()
      expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(2)
      expect(h.of('FAILURE_CLASSIFIED').at(-1)?.data).toMatchObject({
        evidence: `base ${moved} conflicts in: ARCHITECTURE.md`,
      })
      expect(h.first.awaiting('FOR-1')).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test('a conflict that survives its repair round holds the issue naming the files', async () => {
    const h = await conflicted()
    try {
      await h.first.tick()
      await h.first.tick()
      await repaired(h, {})
      await h.first.tick()
      expect(h.first.awaiting('FOR-1')).toEqual({
        kind: 'escalated',
        stage: 'integration',
        reason: 'pr_conflict',
      })
      expect(h.linear.get('FOR-1').status).toBe('Blocked')
      const held = (await h.linear.comments('FOR-1')).filter((c) => c.body.includes('still conflicts'))
      expect(held).toHaveLength(1)
      expect(held[0]?.body).toContain('ARCHITECTURE.md')
      const runs = h.first.runs.forIssue('FOR-1').length
      await h.first.tick()
      await h.first.tick()
      expect(h.first.runs.forIssue('FOR-1')).toHaveLength(runs)
      expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('a repair round that pushes no new head still holds the issue when the conflict remains', async () => {
    const h = await conflicted()
    try {
      await h.first.tick()
      await h.first.tick()
      const head = h.first.pullRequests.get('FOR-1')?.headSha
      await repaired(h, {}, false)
      expect(h.first.pullRequests.get('FOR-1')?.headSha).toBe(head)
      await h.first.tick()
      expect(h.first.awaiting('FOR-1')).toEqual({
        kind: 'escalated',
        stage: 'integration',
        reason: 'pr_conflict',
      })
      const held = (await h.linear.comments('FOR-1')).filter((c) => c.body.includes('still conflicts'))
      expect(held).toHaveLength(1)
      expect(held[0]?.body).toContain('ARCHITECTURE.md')
      expect(h.of('FAILURE_CLASSIFIED')).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('watching survives a supervisor restart', async () => {
    const h = await watching()
    try {
      const restarted = h.make('inst-2')
      await restarted.start()
      ;(h.gh.prs[0] as { state: string }).state = 'MERGED'
      await restarted.tick()
      expect(h.of('MERGED', restarted)).toHaveLength(1)
      expect(h.linear.get('FOR-1').status).toBe('Done')
    } finally {
      h.cleanup()
    }
  })
})
