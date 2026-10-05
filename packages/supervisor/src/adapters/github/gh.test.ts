import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PullRequest } from '../../ports'
import { git, gitFixture } from '../../stages/gates/testing'
import {
  AGENT_TOKEN,
  bareRemote,
  FakeGh,
  fakeHost,
  hostConfig,
  PERSONAL_TOKEN,
} from '../../stages/integration/testing'
import { importBundle, runRef } from '../git/host'
import { bucketOf, githubSlug, MAX_CI_LOG, MAX_JOB_LOG } from './gh'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-gh-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function setup() {
  const fx = gitFixture(root)
  const config = hostConfig(fx.checkout)
  const gh = new FakeGh()
  const remote = bareRemote(root)
  const host = fakeHost(() => config, gh, remote)
  const headSha = importBundle(fx.checkout, fx.bundle().bundle, fx.branch, 'RUN1')
  return { fx, gh, remote, host, headSha }
}

const pushes = (gh: FakeGh) => gh.calls.filter((c) => c.cmd[0] === 'git' && c.cmd.includes('push'))

describe('GhGitHost.push', () => {
  test('pushes the imported ref to ns/<identifier> with the agent token and leaves the checkout alone', async () => {
    const { fx, gh, remote, host, headSha } = setup()
    const before = fx.hostState()
    expect(await host.push({ repository: 'omni', source: runRef('RUN1'), branch: 'ns/FOR-1' })).toEqual({
      headSha,
    })
    expect(git(remote, 'rev-parse', 'refs/heads/ns/FOR-1')).toBe(headSha)
    expect(fx.hostState()).toBe(before)
    const [push] = pushes(gh)
    expect(push?.cmd.slice(-2)).toEqual([remote, `+${headSha}:refs/heads/ns/FOR-1`])
    expect(push?.env.GH_TOKEN).toBe(AGENT_TOKEN)
    expect(push?.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
  })

  test('a retried attempt force-updates only ns/<identifier>', async () => {
    const { fx, remote, host, headSha } = setup()
    await host.push({ repository: 'omni', source: runRef('RUN1'), branch: 'ns/FOR-1' })
    git(fx.worker, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--amend', '-m', 'retry')
    const second = importBundle(fx.checkout, fx.bundle('two').bundle, fx.branch, 'RUN2')
    expect(second).not.toBe(headSha)
    await host.push({ repository: 'omni', source: runRef('RUN2'), branch: 'ns/FOR-1' })
    expect(git(remote, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(
      `refs/heads/ns/FOR-1 ${second}`,
    )
  })

  test('never pushes outside ns/ or to the base branch', async () => {
    const { gh, host } = setup()
    for (const branch of ['main', 'feature/x', 'ns-FOR-1']) {
      await expect(host.push({ repository: 'omni', source: runRef('RUN1'), branch })).rejects.toThrow(
        `refusing to push ${branch}`,
      )
    }
    expect(pushes(gh)).toEqual([])
  })

  test('a repository with github: personal pushes with the personal token', async () => {
    const { gh, host } = setup()
    await host.push({ repository: 'litellm', source: runRef('RUN1'), branch: 'ns/FOR-1' })
    expect(pushes(gh)[0]?.env.GH_TOKEN).toBe(PERSONAL_TOKEN)
    expect(host.accountFor('litellm')).toBe('personal')
    expect(host.accountFor('omni')).toBe('agent')
  })
})

describe('GhGitHost pull requests', () => {
  test('opens a PR with the body on stdin, as draft when asked, under the account token', async () => {
    const { gh, host } = setup()
    const pr = await host.openPullRequest({
      repository: 'omni',
      branch: 'ns/FOR-1',
      base: 'main',
      title: 'FOR-1: trim names',
      body: 'body text',
      draft: true,
    })
    expect(pr).toEqual({
      url: 'https://github.com/lkshrk/omni/pull/1',
      number: 1,
      repository: 'omni',
      repo: 'lkshrk/omni',
      branch: 'ns/FOR-1',
      base: 'main',
      account: 'agent',
    })
    const [create] = gh.gh('create')
    expect(create?.cmd).toEqual([
      'gh',
      'pr',
      'create',
      '--repo',
      'lkshrk/omni',
      '--head',
      'ns/FOR-1',
      '--base',
      'main',
      '--title',
      'FOR-1: trim names',
      '--body-file',
      '-',
      '--draft',
    ])
    expect(create?.stdin).toBe('body text')
    expect(create?.env.GH_TOKEN).toBe(AGENT_TOKEN)
  })

  test('an open PR for the branch is updated instead of opened twice', async () => {
    const { gh, host } = setup()
    const o = { repository: 'omni', branch: 'ns/FOR-1', base: 'main', title: 't', body: 'b', draft: false }
    const first = await host.openPullRequest(o)
    const again = await host.openPullRequest({ ...o, body: 'b2' })
    expect(again).toEqual(first)
    expect(gh.gh('create')).toHaveLength(1)
    expect(gh.gh('edit')).toHaveLength(0)
    expect(gh.prUpdates().map((c) => [c.cmd[4], JSON.parse(c.stdin ?? '')])).toEqual([
      ['repos/lkshrk/omni/pulls/1', { title: 't', body: 'b2' }],
    ])
  })

  test('reads checks and merge state', async () => {
    const { gh, host } = setup()
    const pr: PullRequest = {
      url: 'https://github.com/lkshrk/omni/pull/1',
      number: 1,
      repository: 'litellm',
      repo: 'lkshrk/omni',
      branch: 'ns/FOR-1',
      base: 'main',
      account: 'personal',
    }
    gh.prs.push({ number: 1, url: pr.url, head: 'ns/FOR-1', state: 'OPEN' })
    gh.checks = [
      { name: 'build', bucket: 'pass' },
      { name: 'test', bucket: 'pending' },
    ]
    expect(await host.ci(pr)).toEqual({ state: 'pending', failedChecks: [], failures: [], url: pr.url })
    gh.checks = [
      { name: 'build', bucket: 'fail' },
      { name: 'test', bucket: 'cancel' },
    ]
    expect(await host.ci(pr)).toEqual({
      state: 'failed',
      failedChecks: ['build', 'test'],
      failures: [
        { name: 'build', url: pr.url, log: '' },
        { name: 'test', url: pr.url, log: '' },
      ],
      url: pr.url,
    })
    gh.checks = [
      { name: 'build', bucket: 'pass' },
      { name: 'deploy', bucket: 'skipping' },
    ]
    expect(await host.ci(pr)).toEqual({ state: 'passed', failedChecks: [], failures: [], url: pr.url })
    gh.checks = []
    expect(await host.ci(pr)).toEqual({ state: 'passed', failedChecks: [], failures: [], url: pr.url })
    expect(gh.gh('checks')).toHaveLength(0)
    expect(gh.ciReads()).toHaveLength(4)
    expect(await host.state(pr)).toEqual({ state: 'open' })
    ;(gh.prs[0] as { state: string }).state = 'MERGED'
    expect(await host.state(pr)).toEqual({ state: 'merged', mergeSha: 'm3rg3d' })
    expect(gh.gh('view')[0]?.env.GH_TOKEN).toBe(PERSONAL_TOKEN)
  })

  const ciPr: PullRequest = {
    url: 'https://github.com/lkshrk/omni/pull/1',
    number: 1,
    repository: 'omni',
    repo: 'lkshrk/omni',
    branch: 'ns/FOR-1',
    base: 'main',
    account: 'agent',
  }

  test('a failing check run carries an excerpt of its failed job log', async () => {
    const { gh, host } = setup()
    const noise = (tag: string) =>
      Array.from({ length: 40 }, (_, n) => `quality\tTest\t2026-10-05T10:00:00.0000000Z ${tag} ${n}`)
    gh.logs['job 77'] = [
      ...noise('before'),
      'quality\tTest\t2026-10-05T10:00:01.0000000Z (fail) stable locator contract > keeps ids',
      'quality\tTest\t2026-10-05T10:00:01.0000000Z   error: expect(received).toBe(expected)',
      'quality\tTest\t2026-10-05T10:00:01.0000000Z   at e2e/test/stable-locator-contract.test.ts:42:7',
      ...noise('after'),
    ].join('\n')
    gh.checks = [
      { name: 'build', bucket: 'pass', run: 5 },
      { name: 'quality', bucket: 'fail', run: 5, job: 77 },
    ]
    const ci = await host.ci(ciPr)
    expect(ci.state).toBe('failed')
    expect(ci.failedChecks).toEqual(['quality'])
    expect(ci.failures).toHaveLength(1)
    const [f] = ci.failures
    expect(f?.name).toBe('quality')
    expect(f?.url).toBe('https://github.com/lkshrk/omni/actions/runs/5/job/77')
    expect(f?.log).toContain('(fail) stable locator contract > keeps ids')
    expect(f?.log).toContain('at e2e/test/stable-locator-contract.test.ts:42:7')
    expect(f?.log).toContain('before 39')
    expect(f?.log).not.toContain('before 30')
    expect(f?.log).not.toContain('after 30')
    expect(f?.log).not.toContain('2026-10-05T10')
    const [read] = gh.logReads()
    expect(read?.cmd).toEqual(['gh', 'run', 'view', '--job', '77', '--repo', 'lkshrk/omni', '--log-failed'])
    expect(read?.env.GH_TOKEN).toBe(AGENT_TOKEN)
  })

  test('failed job logs are bounded per job and in total', async () => {
    const { gh, host } = setup()
    const huge = Array.from({ length: 4000 }, (_, n) => `j\ts\terror: assertion ${n} failed`).join('\n')
    gh.checks = [1, 2, 3, 4, 5].map((n) => ({ name: `job${n}`, bucket: 'fail', run: 9, job: n }))
    for (const n of [1, 2, 3, 4, 5]) gh.logs[`job ${n}`] = huge
    const ci = await host.ci(ciPr)
    for (const f of ci.failures) expect(f.log.length).toBeLessThanOrEqual(MAX_JOB_LOG)
    expect(ci.failures.reduce((n, f) => n + f.log.length, 0)).toBeLessThanOrEqual(MAX_CI_LOG)
    expect(ci.failures[0]?.log).toContain('truncated')
    expect(ci.failures.map((f) => f.name)).toEqual(['job1', 'job2', 'job3', 'job4', 'job5'])
  })

  test('a log that cannot be fetched leaves the check with its name only', async () => {
    const { gh, host } = setup()
    gh.checks = [
      { name: 'e2e', bucket: 'fail', run: 8, job: 3 },
      { name: 'ci/legacy', bucket: 'fail' },
    ]
    gh.logs['job 3'] = { exitCode: 1, stdout: '', stderr: 'log not found' }
    const errors: string[] = []
    const original = console.error
    console.error = (m: string) => errors.push(m)
    try {
      const ci = await host.ci(ciPr)
      expect(ci.state).toBe('failed')
      expect(ci.failedChecks).toEqual(['e2e', 'ci/legacy'])
      expect(ci.failures).toEqual([
        { name: 'e2e', url: 'https://github.com/lkshrk/omni/actions/runs/8/job/3', log: '' },
        { name: 'ci/legacy', url: ciPr.url, log: '' },
      ])
    } finally {
      console.error = original
    }
    expect(errors.join('\n')).toContain('e2e')
    expect(errors.join('\n')).toContain('log not found')
    expect(errors.join('\n')).toContain('ci/legacy')
  })

  test('a rejected token is refreshed once and the command retried', async () => {
    const { gh, host } = setup()
    gh.failNext = { exitCode: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' }
    await host.openPullRequest({
      repository: 'omni',
      branch: 'ns/FOR-1',
      base: 'main',
      title: 't',
      body: 'b',
      draft: false,
    })
    expect(gh.gh('list')).toHaveLength(2)
    expect(gh.gh('create')).toHaveLength(1)
  })
})

describe('bucketOf', () => {
  test('maps check runs and status contexts', () => {
    expect(bucketOf({ name: 'a', status: 'QUEUED', conclusion: '' })).toBe('pending')
    expect(bucketOf({ name: 'a', status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('fail')
    expect(bucketOf({ name: 'a', status: 'COMPLETED', conclusion: 'NEUTRAL' })).toBe('pass')
    expect(bucketOf({ context: 'ci/x', state: 'ERROR' })).toBe('fail')
    expect(bucketOf({ context: 'ci/x', state: 'PENDING' })).toBe('pending')
    expect(bucketOf({ context: 'ci/x', state: 'SUCCESS' })).toBe('pass')
  })
})

describe('githubSlug', () => {
  test('reads owner/name from https, ssh and scp-style remotes', () => {
    expect(githubSlug('https://github.com/BerriAI/litellm.git')).toBe('BerriAI/litellm')
    expect(githubSlug('git@github.com:lkshrk/omni.git')).toBe('lkshrk/omni')
    expect(githubSlug('ssh://git@github.com/lkshrk/omni')).toBe('lkshrk/omni')
    expect(githubSlug('https://gitlab.com/a/b.git')).toBeUndefined()
  })
})
