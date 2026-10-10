import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '@nightshift/core'
import { runRef } from '../policy/naming'
import type { GateResult, LockOutcome } from '../ports'
import { gateStep } from '../stages/gates/step'
import { type GitFixture, git, gitFixture } from '../stages/gates/testing'
import type { Run } from '../state/runs'
import { testConfig } from '../testing/testing'
import { lockStep, type MiseLock, miseLock } from './lock-step'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-lock-test-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const lockFor = (toml: string) => `# lock for ${createHash('sha256').update(toml).digest('hex')}\n`

function commitFeature(fx: GitFixture, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(fx.worker, path, '..'), { recursive: true })
    writeFileSync(join(fx.worker, path), content)
  }
  git(fx.worker, 'add', '-A')
  git(fx.worker, 'commit', '-q', '-m', 'tools')
}

function harness(mise?: MiseLock) {
  const fx = gitFixture(join(root, 'repo'))
  const base = testConfig()
  const omni = base.repositories.omni
  if (!omni) throw new Error('omni missing')
  const config: Config = {
    ...base,
    repositories: { ...base.repositories, omni: { ...omni, path: fx.checkout } },
  }
  const miseCalls: { dir: string; env: Record<string, string> }[] = []
  const tokens: string[] = []
  const imported: string[] = []
  const failed: [string, string | undefined][] = []
  const locks: LockOutcome['locks'] = []
  const gated: string[] = []
  const fake: MiseLock = async (dir, env) => {
    miseCalls.push({ dir, env })
    writeFileSync(join(dir, 'mise.lock'), lockFor(readFileSync(join(dir, 'mise.toml'), 'utf8')))
    return { exitCode: 0, output: '' }
  }
  const step = gateStep({
    config: () => config,
    image: async () => 'img',
    sandbox: { exportCommits: async () => fx.bundle() },
    gates: {
      run: async (_repo, _bundle, headSha): Promise<GateResult[]> => {
        gated.push(headSha)
        return []
      },
    },
    artifacts: join(root, 'artifacts'),
    lock: lockStep({
      token: async (repository) => {
        tokens.push(repository)
        return 'ghs_secret'
      },
      mise: mise ?? fake,
    }),
    callbacks: () => ({
      headImported: async (_id, sha) => {
        imported.push(sha)
      },
      gatesFinished: async () => {},
      workerFailed: async (_id, reason, detail) => {
        failed.push([reason, detail])
      },
      lockRegenerated: async (_id, lock) => {
        locks.push(lock)
      },
    }),
  })
  const run: Run = {
    id: '01JAAAAAAAAAAAAAAAAAAAAAAA',
    issue: 'FOR-1',
    agent: 'implementer',
    profile: 'default',
    model: 'm',
    repository: 'omni',
    baseSha: fx.base,
    attempt: 1,
    state: 'gating',
    sandbox: 'sb-1',
    session: 's-1',
    headSha: null,
    finish: null,
    failure: null,
    startedAt: '2026-10-10T00:00:00.000Z',
    endedAt: null,
    tokensIn: 0,
    tokensOut: 0,
  }
  return { fx, step: () => step(run), run, miseCalls, tokens, imported, failed, locks, gated }
}

describe('lock step', () => {
  test('a changed mise.toml gets a regenerated mise.lock committed on a new head before the gates', async () => {
    const h = harness()
    commitFeature(h.fx, { 'features/stack-x/mise.toml': '[tools]\nbun = "1.4.3"\n' })
    const exported = git(h.fx.worker, 'rev-parse', 'HEAD')
    await h.step()

    expect(h.failed).toEqual([])
    const head = h.imported[0] ?? ''
    expect(h.imported).toEqual([head])
    expect(head).not.toBe(exported)
    expect(h.gated).toEqual([head])
    expect(git(h.fx.checkout, 'rev-parse', runRef(h.run.id))).toBe(head)
    expect(git(h.fx.checkout, 'log', '-1', '--format=%s%n%an%n%P', head)).toBe(
      `chore(stack-x): regenerate mise.lock\nnightshift\n${exported}`,
    )
    expect(git(h.fx.checkout, 'show', `${head}:features/stack-x/mise.lock`)).toBe(
      lockFor('[tools]\nbun = "1.4.3"\n').trim(),
    )
    expect(h.locks).toEqual([{ feature: 'stack-x', changed: true }])
    expect(h.tokens).toEqual(['omni'])
    expect(h.miseCalls.map((c) => c.env.GITHUB_TOKEN)).toEqual(['ghs_secret'])
    expect(git(h.fx.checkout, 'worktree', 'list').split('\n')).toHaveLength(1)
    expect(git(h.fx.checkout, 'status', '--porcelain')).toBe('?? scratch.txt')
  })

  test('a lock mise leaves unchanged adds no commit and keeps the head', async () => {
    const h = harness()
    const toml = '[tools]\nbun = "1.4.3"\n'
    commitFeature(h.fx, { 'features/stack-x/mise.toml': toml, 'features/stack-x/mise.lock': lockFor(toml) })
    const exported = git(h.fx.worker, 'rev-parse', 'HEAD')
    await h.step()

    expect(h.failed).toEqual([])
    expect(h.imported).toEqual([exported])
    expect(git(h.fx.checkout, 'rev-parse', runRef(h.run.id))).toBe(exported)
    expect(h.locks).toEqual([{ feature: 'stack-x', changed: false }])
  })

  test('a run that changes no mise.toml skips locking without a token or mise call', async () => {
    const h = harness()
    const exported = git(h.fx.worker, 'rev-parse', 'HEAD')
    await h.step()

    expect(h.imported).toEqual([exported])
    expect(h.gated).toEqual([exported])
    expect(h.tokens).toEqual([])
    expect(h.miseCalls).toEqual([])
    expect(h.locks).toEqual([])
  })

  test('a mise failure fails the run with lock_failed and the mise error, without the token', async () => {
    const h = harness(async () => ({ exitCode: 1, output: 'mise ERROR rate limited for ghs_secret' }))
    commitFeature(h.fx, { 'features/stack-x/mise.toml': '[tools]\nbun = "1.4.3"\n' })
    await h.step()

    expect(h.failed).toEqual([
      ['lock_failed', 'mise lock in features/stack-x exited 1: mise ERROR rate limited for ***'],
    ])
    expect(h.imported).toEqual([])
    expect(h.gated).toEqual([])
    expect(git(h.fx.checkout, 'worktree', 'list').split('\n')).toHaveLength(1)
  })
})

test('a mise that cannot start also fails the run with lock_failed', async () => {
  const h = harness(async () => {
    throw new Error('checksum mismatch for https://example/mise')
  })
  commitFeature(h.fx, { 'features/stack-x/mise.toml': '[tools]\n' })
  await h.step()
  expect(h.failed).toEqual([
    ['lock_failed', 'mise lock in features/stack-x: checksum mismatch for https://example/mise'],
  ])
})

describe('miseLock', () => {
  const binary = new TextEncoder().encode('#!/bin/sh\necho "$@" > "$PWD/args"; env > "$PWD/env"\n')
  const sum = createHash('sha256').update(binary).digest('hex')

  function pinned(sha: string): string {
    const dir = join(root, 'harness')
    mkdirSync(join(dir, 'features/mise'), { recursive: true })
    writeFileSync(
      join(dir, 'features/mise/tools.sh'),
      `MISE_VERSION="2026.10.7"\nMISE_SHA256_AMD64="${sha}"\nMISE_SHA256_ARM64="${sha}"\n`,
    )
    return dir
  }

  test('downloads the pinned mise into the cache, checks its sha256 and runs mise lock for both platforms', async () => {
    const urls: string[] = []
    const lock = miseLock({
      root: pinned(sum),
      cache: join(root, 'cache'),
      arch: 'x64',
      fetch: async (url) => {
        urls.push(url)
        return new Response(binary)
      },
    })
    const dir = join(root, 'feature')
    mkdirSync(dir)
    expect(await lock(dir, { GITHUB_TOKEN: 'ghs_secret' })).toMatchObject({ exitCode: 0 })
    expect(await lock(dir, { GITHUB_TOKEN: 'ghs_secret' })).toMatchObject({ exitCode: 0 })
    expect(urls).toEqual([
      'https://github.com/jdx/mise/releases/download/v2026.10.7/mise-v2026.10.7-linux-x64',
    ])
    expect(existsSync(join(root, 'cache/mise/2026.10.7/mise-linux-x64'))).toBe(true)
    expect(readFileSync(join(dir, 'args'), 'utf8')).toBe('lock --platform linux-x64,linux-arm64\n')
    expect(readFileSync(join(dir, 'env'), 'utf8')).toContain('GITHUB_TOKEN=ghs_secret')
  })

  test('a checksum mismatch rejects the download and caches nothing', async () => {
    const lock = miseLock({
      root: pinned('0'.repeat(64)),
      cache: join(root, 'cache'),
      arch: 'arm64',
      fetch: async () => new Response(binary),
    })
    await expect(lock(root, {})).rejects.toThrow('checksum mismatch')
    expect(existsSync(join(root, 'cache/mise/2026.10.7/mise-linux-arm64'))).toBe(false)
  })
})
