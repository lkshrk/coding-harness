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
