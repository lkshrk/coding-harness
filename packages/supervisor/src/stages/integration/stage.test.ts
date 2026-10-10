import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import { importBundle } from '../../adapters/git/host'
import type { Run } from '../../state/runs'
import { snapshot } from '../../testing/testing'
import { git } from '../gates/testing'
import { AGENT_TOKEN, FINISH, gate, integrationHarness, PERSONAL_TOKEN, until } from './testing'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-integration-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('integration stage (manual)', () => {
  test('pushes ns/<identifier>, opens the PR under the agent account, links it and sets review', async () => {
    const h = integrationHarness(root)
    const before = h.fx.hostState()
    const run = await h.integrated()

    expect(git(h.remote, 'rev-parse', 'refs/heads/ns/FOR-1')).toBe(run.headSha ?? '')
    expect(h.fx.hostState()).toBe(before)
    const created = h.of('PR_CREATED')
    expect(created.map((e) => [e.issue, e.run, e.data])).toMatchObject([
      [
        'FOR-1',
        run.id,
        {
          url: 'https://github.com/lkshrk/omni/pull/1',
          branch: 'ns/FOR-1',
          account: 'agent',
          mode: 'manual',
        },
      ],
    ])
    expect(h.linear.attachments.get('FOR-1')).toEqual([
      { url: 'https://github.com/lkshrk/omni/pull/1', title: 'PR #1: FOR-1: Trim names' },
    ])
    expect(h.linear.get('FOR-1')).toMatchObject({ status: 'In Review', labels: ['ai-stage:integration'] })
    expect(h.first.pullRequests.get('FOR-1')).toMatchObject({
      run: run.id,
      headSha: run.headSha,
      ci: 'pending',
    })

    const [create] = h.gh.gh('create')
    expect(create?.env.GH_TOKEN).toBe(AGENT_TOKEN)
    expect(create?.cmd).toContain('FOR-1: Trim names')
    expect(create?.cmd).not.toContain('--draft')
    const body = create?.stdin ?? ''
    expect(h.first.pullRequests.get('FOR-1')).toMatchObject({ title: 'FOR-1: Trim names', body })
    expect(created[0]?.data).toMatchObject({ title: 'FOR-1: Trim names', body })
    expect(body).toContain('## Summary\nTrimmed user names before saving.')
    expect(body).toContain('- [ ] it works')
    expect(body).toContain('- `lint`: passed in 1.5s\n- `test`: passed in 1.5s')
    expect(body).toContain('Verdict: pass\n- **SUGGESTION** `src/b.ts:1`: export a type')
    expect(body).toContain(`Session \`${run.id}\``)
    expect(body).not.toMatch(/claude|co-authored|generated (with|by)|\bAI\b/i)
  })

  test('retrying the step logs PR_CREATED once and attaches the link once', async () => {
    const h = integrationHarness(root)
    await h.integrated()
    await h.first.tick()
    await h.handler.run({
      issue: { ...h.linear.get('FOR-1'), status: 'In Progress' },
      stage: 'integration',
      agent: undefined,
    })
    await h.handler.run({ issue: h.linear.get('FOR-1'), stage: 'integration', agent: undefined })

    expect(h.of('PR_CREATED')).toHaveLength(1)
    expect(h.linear.attachments.get('FOR-1')).toHaveLength(1)
    expect(h.gh.gh('create')).toHaveLength(1)
    expect(h.gh.calls.filter((c) => c.cmd.includes('push'))).toHaveLength(1)
  })

  test('integration handler leaves status alone during an active run', async () => {
    const h = integrationHarness(root)
    await h.integrated()
    const before = h.linear.get('FOR-1')
    const retry = await h.first.retryRun('FOR-1', {}, 'cli')
    expect(h.linear.get('FOR-1').status).toBe('In Progress')
    await h.handler.run({ issue: before, stage: 'integration', agent: undefined })
    await h.handler.run({ issue: h.linear.get('FOR-1'), stage: 'integration', agent: undefined })
    const record = h.first.pullRequests.get('FOR-1')
    if (record) await h.first.pullRequestOpened(record, 'FOR-1: Trim names')
    expect(h.linear.get('FOR-1')).toMatchObject({
      status: 'In Progress',
      labels: ['ai-stage:implementation'],
    })
    await h.first.tick()
    expect(h.first.runs.get(retry.id)?.state).not.toBe('stopped')
  })

  test('a retry with an open PR pushes its new commits to the same branch and keeps the PR', async () => {
    const h = integrationHarness(root)
    const first = await h.integrated()
    const retry = await h.first.retryRun('FOR-1', {}, 'cli')
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ run: first.id, headSha: first.headSha ?? '' })
    git(h.fx.worker, 'commit', '-q', '--allow-empty', '-m', 'address review')
    await h.first.workerStarted(retry.id, { sandbox: 'sb-2', session: 's-2' })
    await h.first.workerFinished(retry.id, FINISH)
    const head = importBundle(h.fx.checkout, h.fx.bundle('run2').bundle, h.fx.branch, retry.id)
    await h.first.headImported(retry.id, head)
    await h.first.gatesFinished(retry.id, [gate('test')])
    await h.first.reviewFinished(retry.id, {
      kind: 'verdict',
      review: { verdict: 'pass', findings: [] },
      model: 'glm',
    })
    await h.first.tick()
    await until(() => h.first.pullRequests.get('FOR-1')?.headSha === head, 'PR head updated')
    await until(() => h.linear.get('FOR-1').status === 'In Review', 'status In Review')

    expect(git(h.remote, 'rev-parse', 'refs/heads/ns/FOR-1')).toBe(head)
    expect(h.gh.gh('create')).toHaveLength(1)
    expect(h.gh.prs.map((p) => [p.number, p.state])).toEqual([[1, 'OPEN']])
    expect(h.first.pullRequests.get('FOR-1')).toMatchObject({ number: 1, run: retry.id, headSha: head })
    expect(h.of('PR_CREATED')).toHaveLength(1)
  })

  test('a retry after a fix pushed to the PR branch by hand continues from it and fast-forwards the PR', async () => {
    let checkout = ''
    let remote = ''
    const h = integrationHarness(root, undefined, {
      repos: {
        baseSha: async () => git(checkout, 'rev-parse', 'main'),
        fetchPullRequest: async (_, pr) => {
          git(checkout, 'fetch', '-q', remote, `+refs/heads/${pr.branch}:refs/nightshift/pr/${pr.number}`)
          return git(checkout, 'rev-parse', `refs/nightshift/pr/${pr.number}`)
        },
      },
    })
    checkout = h.fx.checkout
    remote = h.remote
    await h.integrated()
    const hand = join(root, 'hand')
    git(root, 'clone', '-q', '-b', 'ns/FOR-1', h.remote, hand)
    git(hand, 'commit', '-q', '--allow-empty', '-m', 'review fix by hand')
    git(hand, 'push', '-q', 'origin', 'ns/FOR-1')
    const prHead = git(hand, 'rev-parse', 'HEAD')
    const record = h.first.pullRequests.get('FOR-1')
    if (record) h.first.pullRequests.put({ ...record, headSha: prHead })
    const before = h.fx.hostState()

    const retry = await h.first.retryRun('FOR-1', {}, 'cli')
    expect(h.executor.starts.at(-1)?.repairFrom).toEqual({ ref: 'refs/nightshift/pr/1', headSha: prHead })
    expect(git(h.fx.checkout, 'rev-parse', 'refs/nightshift/pr/1')).toBe(prHead)
    expect(h.fx.hostState()).toBe(before)

    git(h.fx.worker, 'fetch', '-q', h.fx.checkout, 'refs/nightshift/pr/1')
    git(h.fx.worker, 'reset', '-q', '--hard', 'FETCH_HEAD')
    git(h.fx.worker, 'commit', '-q', '--allow-empty', '-m', 'address review')
    await h.first.workerStarted(retry.id, { sandbox: 'sb-2', session: 's-2' })
    await h.first.workerFinished(retry.id, FINISH)
    const head = importBundle(h.fx.checkout, h.fx.bundle('run2').bundle, h.fx.branch, retry.id)
    await h.first.headImported(retry.id, head)
    await h.first.gatesFinished(retry.id, [gate('test')])
    await h.first.reviewFinished(retry.id, {
      kind: 'verdict',
      review: { verdict: 'pass', findings: [] },
      model: 'glm',
    })
    await h.first.tick()
    await until(() => h.first.pullRequests.get('FOR-1')?.headSha === head, 'PR head updated')

    expect(git(h.remote, 'rev-parse', 'refs/heads/ns/FOR-1')).toBe(head)
    expect(git(h.remote, 'rev-parse', `${head}^`)).toBe(prHead)
    expect(h.gh.prs.map((p) => [p.number, p.state])).toEqual([[1, 'OPEN']])
    expect(h.first.pullRequests.get('FOR-1')).toMatchObject({ number: 1, run: retry.id, headSha: head })
  })

  test('a push rejected because the PR branch moved during the attempt holds the issue and keeps the remote commit', async () => {
    const h = integrationHarness(root)
    const first = await h.integrated()
    const retry = await h.first.retryRun('FOR-1', {}, 'cli')
    const hand = join(root, 'hand')
    git(root, 'clone', '-q', '-b', 'ns/FOR-1', h.remote, hand)
    git(hand, 'commit', '-q', '--allow-empty', '-m', 'pushed while the attempt ran')
    git(hand, 'push', '-q', 'origin', 'ns/FOR-1')
    const foreign = git(hand, 'rev-parse', 'HEAD')

    git(h.fx.worker, 'commit', '-q', '--allow-empty', '-m', 'address review')
    await h.first.workerStarted(retry.id, { sandbox: 'sb-2', session: 's-2' })
    await h.first.workerFinished(retry.id, FINISH)
    const head = importBundle(h.fx.checkout, h.fx.bundle('run2').bundle, h.fx.branch, retry.id)
    await h.first.headImported(retry.id, head)
    await h.first.gatesFinished(retry.id, [gate('test')])
    await h.first.reviewFinished(retry.id, {
      kind: 'verdict',
      review: { verdict: 'pass', findings: [] },
      model: 'glm',
    })
    await h.first.tick()
    await until(() => h.first.awaiting('FOR-1') !== null, 'issue held')

    expect(git(h.remote, 'rev-parse', 'refs/heads/ns/FOR-1')).toBe(foreign)
    expect(h.first.awaiting('FOR-1')).toMatchObject({ kind: 'escalated', stage: 'integration' })
    expect(h.linear.get('FOR-1').status).toBe('Blocked')
    const comment = (h.linear.threads.get('FOR-1') ?? []).map((c) => c.body).join('\n')
    expect(comment).toContain('ns/FOR-1')
    expect(comment).toContain(first.headSha ?? '?')
    expect(comment).toContain(foreign)
    expect(h.first.pullRequests.get('FOR-1')).toMatchObject({ run: first.id, headSha: first.headSha })
    await h.first.tick()
    await h.first.tick()
    expect(h.gh.calls.filter((c) => c.cmd.includes('push'))).toHaveLength(2)
  })

  test('a change touching a risk path opens a draft PR and says so', async () => {
    const h = integrationHarness(root, (c) => ({
      ...c,
      repositories: {
        ...c.repositories,
        omni: { ...(c.repositories.omni as Config['repositories'][string]), risk_paths: ['src/b.ts'] },
      },
    }))
    await h.integrated()
    const [create] = h.gh.gh('create')
    expect(create?.cmd.at(-1)).toBe('--draft')
    expect(create?.stdin).toContain(
      '## Risk paths\nDraft: this change touches configured risk paths.\n- `src/b.ts`',
    )
    expect(h.first.pullRequests.get('FOR-1')?.draft).toBe(true)
  })

  test('a repository with github: personal opens the PR under the personal account', async () => {
    const h = integrationHarness(root)
    await h.integrated({
      project: { id: 'p-litellm', name: 'LiteLLM', initiatives: [], labels: [] },
    })
    expect(h.of('PR_CREATED')[0]?.data).toMatchObject({ account: 'personal', mode: 'manual' })
    expect(h.gh.gh('create')[0]?.env.GH_TOKEN).toBe(PERSONAL_TOKEN)
    expect(h.linear.get('FOR-1').status).toBe('In Review')
  })

  test('a run whose head commit is a WIP commit is refused before pushing', async () => {
    const h = integrationHarness(root)
    git(h.fx.worker, 'commit', '-q', '--amend', '-m', 'wip: FOR-1 attempt 1 (BLOCKED)')
    h.linear.put(snapshot({ identifier: 'FOR-1', title: 'Trim names' }))
    await h.first.start()
    await h.first.tick()
    const run = h.first.runs.forIssue('FOR-1').at(-1) as Run
    await h.first.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    await h.first.workerFinished(run.id, FINISH)
    await h.first.headImported(run.id, importBundle(h.fx.checkout, h.fx.bundle().bundle, h.fx.branch, run.id))
    await h.first.gatesFinished(run.id, [gate('test')])
    await h.first.reviewFinished(run.id, {
      kind: 'verdict',
      review: { verdict: 'pass', findings: [] },
      model: 'glm',
    })
    expect(h.first.runs.get(run.id)?.state).toBe('done')
    await expect(
      h.handler.run({ issue: h.linear.get('FOR-1'), stage: 'integration', agent: undefined }),
    ).rejects.toThrow('head commit is a WIP commit')
    expect(h.gh.calls.filter((c) => c.cmd.includes('push'))).toEqual([])
    expect(h.gh.gh('create')).toEqual([])
  })

  test('an unreviewed change says so in the PR body', async () => {
    const h = integrationHarness(root)
    h.linear.put(snapshot({ identifier: 'FOR-1', title: 'Trim names' }))
    await h.first.start()
    await h.first.tick()
    const run = h.first.runs.forIssue('FOR-1').at(-1) as Run
    await h.first.workerStarted(run.id, { sandbox: 'sb-1', session: 's-1' })
    await h.first.workerFinished(run.id, FINISH)
    await h.first.headImported(run.id, importBundle(h.fx.checkout, h.fx.bundle().bundle, h.fx.branch, run.id))
    await h.first.gatesFinished(run.id, [gate('test')])
    await h.first.reviewFinished(run.id, {
      kind: 'unreviewed',
      reason: 'invalid_output',
      model: 'glm',
      detail: 'bad',
    })
    await h.first.tick()
    await until(() => h.linear.get('FOR-1').status === 'In Review', 'status In Review')
    expect(h.gh.gh('create')[0]?.stdin).toContain(
      'Unreviewed: the reviewer returned invalid output twice. Merge manually',
    )
  })
})
