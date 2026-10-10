import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PullRequest } from '../../ports'
import { PushRejectedError } from '../../ports/git-host'
import { git, gitFixture } from '../../stages/gates/testing'
import {
  AGENT_TOKEN,
  bareRemote,
  FakeGh,
  fakeHost,
  fakeThread,
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
    const slot = Number(push?.env.GIT_CONFIG_COUNT) - 1
    expect(push?.env[`GIT_CONFIG_KEY_${slot}`]).toBe('http.https://github.com/.extraheader')
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

  test('a push with expected leases the branch at that commit', async () => {
    const { fx, gh, remote, host, headSha } = setup()
    await host.push({ repository: 'omni', source: runRef('RUN1'), branch: 'ns/FOR-1' })
    git(fx.worker, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two')
    const second = importBundle(fx.checkout, fx.bundle('two').bundle, fx.branch, 'RUN2')
    await host.push({ repository: 'omni', source: runRef('RUN2'), branch: 'ns/FOR-1', expected: headSha })
    expect(git(remote, 'rev-parse', 'refs/heads/ns/FOR-1')).toBe(second)
    expect(pushes(gh)[1]?.cmd.slice(-3)).toEqual([
      `--force-with-lease=refs/heads/ns/FOR-1:${headSha}`,
      remote,
      `${second}:refs/heads/ns/FOR-1`,
    ])
  })

  test('a leased push fails and keeps the remote commit when the branch moved', async () => {
    const { fx, remote, host, headSha } = setup()
    await host.push({ repository: 'omni', source: runRef('RUN1'), branch: 'ns/FOR-1' })
    git(fx.worker, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two')
    const moved = importBundle(fx.checkout, fx.bundle('two').bundle, fx.branch, 'RUN2')
    await host.push({ repository: 'omni', source: runRef('RUN2'), branch: 'ns/FOR-1' })
    git(
      fx.worker,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--amend',
      '--allow-empty',
      '-m',
      'three',
    )
    importBundle(fx.checkout, fx.bundle('three').bundle, fx.branch, 'RUN3')
    const failed = host.push({
      repository: 'omni',
      source: runRef('RUN3'),
      branch: 'ns/FOR-1',
      expected: headSha,
    })
    await expect(failed).rejects.toBeInstanceOf(PushRejectedError)
    await expect(failed).rejects.toMatchObject({ branch: 'ns/FOR-1', expected: headSha })
    expect(git(remote, 'rev-parse', 'refs/heads/ns/FOR-1')).toBe(moved)
  })

  test('a leased push fails when the branch moved to the very commit being pushed', async () => {
    const { fx, remote, host, headSha } = setup()
    await host.push({ repository: 'omni', source: runRef('RUN1'), branch: 'ns/FOR-1' })
    git(fx.worker, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two')
    const moved = importBundle(fx.checkout, fx.bundle('two').bundle, fx.branch, 'RUN2')
    await host.push({ repository: 'omni', source: runRef('RUN2'), branch: 'ns/FOR-1' })
    const failed = host.push({
      repository: 'omni',
      source: runRef('RUN2'),
      branch: 'ns/FOR-1',
      expected: headSha,
    })
    await expect(failed).rejects.toBeInstanceOf(PushRejectedError)
    await expect(failed).rejects.toMatchObject({ branch: 'ns/FOR-1', expected: headSha, actual: moved })
    expect(git(remote, 'rev-parse', 'refs/heads/ns/FOR-1')).toBe(moved)
  })

  test('a leased push fails when the branch moves to the pushed commit between the lease check and the push', async () => {
    const { fx, gh, remote, host, headSha } = setup()
    await host.push({ repository: 'omni', source: runRef('RUN1'), branch: 'ns/FOR-1' })
    git(fx.worker, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two')
    const second = importBundle(fx.checkout, fx.bundle('two').bundle, fx.branch, 'RUN2')
    const run = gh.run
    let advanced = false
    const racing = fakeHost(
      () => hostConfig(fx.checkout),
      Object.assign(Object.create(gh), {
        run: async (...a: Parameters<typeof run>) => {
          const r = await run(...a)
          if (!advanced && a[0].includes('ls-remote')) {
            advanced = true
            git(fx.checkout, 'push', '-q', remote, `${second}:refs/heads/ns/FOR-1`)
          }
          return r
        },
      }),
      remote,
    )
    const failed = racing.push({
      repository: 'omni',
      source: runRef('RUN2'),
      branch: 'ns/FOR-1',
      expected: headSha,
    })
    await expect(failed).rejects.toBeInstanceOf(PushRejectedError)
    await expect(failed).rejects.toMatchObject({ branch: 'ns/FOR-1', expected: headSha, actual: second })
    expect(git(remote, 'rev-parse', 'refs/heads/ns/FOR-1')).toBe(second)
    expect(gh.calls.filter((c) => c.cmd.includes('ls-remote'))).toHaveLength(2)
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
    ;(gh.prs[0] as { headSha?: string }).headSha = 'pushed-by-hand'
    expect(await host.state(pr)).toEqual({ state: 'open', headSha: 'pushed-by-hand' })
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

describe('GhGitHost review threads', () => {
  const pr: PullRequest = {
    url: 'https://github.com/lkshrk/omni/pull/7',
    number: 7,
    repository: 'omni',
    repo: 'lkshrk/omni',
    branch: 'ns/FOR-1',
    base: 'main',
    account: 'agent',
  }

  test('reviewThreads maps the GraphQL response', async () => {
    const { gh, host } = setup()
    gh.threads = [
      fakeThread('T1', 11, 'trim before saving'),
      fakeThread('T2', 21, 'old', { isResolved: true, isOutdated: true, line: null }),
    ]
    gh.threads[1]?.comments.push({ databaseId: 22, author: null, body: 'done' })
    expect(await host.reviewThreads(pr)).toEqual([
      {
        id: 'T1',
        resolved: false,
        outdated: false,
        path: 'src/b.ts',
        line: 1,
        comments: [{ id: 11, author: 'agent-npa', body: 'trim before saving' }],
      },
      {
        id: 'T2',
        resolved: true,
        outdated: true,
        path: 'src/b.ts',
        line: null,
        comments: [
          { id: 21, author: 'agent-npa', body: 'old' },
          { id: 22, author: '', body: 'done' },
        ],
      },
    ])
    const [read] = gh.threadReads()
    expect(read?.cmd).toContain('owner=lkshrk')
    expect(read?.cmd).toContain('name=omni')
    expect(read?.cmd).toContain('number=7')
    expect(read?.env.GH_TOKEN).toBe(AGENT_TOKEN)
  })

  test('reply posts to the comment replies endpoint and resolve sends the mutation', async () => {
    const { gh, host } = setup()
    gh.threads = [fakeThread('T1', 11, 'trim before saving')]
    const reply = await host.replyToThread(pr, 11, 'Fixed in abc123.')
    const post = gh.calls.find((c) => c.cmd.includes('POST'))
    expect(post?.cmd).toEqual([
      'gh',
      'api',
      '-X',
      'POST',
      'repos/lkshrk/omni/pulls/7/comments/11/replies',
      '--input',
      '-',
    ])
    expect(JSON.parse(post?.stdin ?? '')).toEqual({ body: 'Fixed in abc123.' })
    expect(gh.threads[0]?.comments.at(-1)).toMatchObject({ databaseId: reply.id, body: 'Fixed in abc123.' })
    await host.resolveThread(pr, 'T1')
    const resolve = gh.calls.at(-1)
    expect(resolve?.cmd.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
    expect(resolve?.cmd.find((a) => a.startsWith('query='))).toContain('resolveReviewThread')
    expect(resolve?.cmd).toContain('id=T1')
    expect(resolve?.env.GH_TOKEN).toBe(AGENT_TOKEN)
    expect(gh.threads[0]?.isResolved).toBe(true)
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
