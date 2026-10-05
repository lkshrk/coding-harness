import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Classifier, FailureSignal } from '../ports'
import { attemptsOf } from '../stages/context'
import { integrationHarness } from '../stages/integration/testing'
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
