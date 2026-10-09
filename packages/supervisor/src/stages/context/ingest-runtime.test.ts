import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxDriver } from '../../ports'
import { snapshot, testConfig } from '../../testing/testing'
import { ingestConfig, ingestRuntime, ingestTaskMessage, VAULT_REPOSITORY } from './ingest-runtime'

test('derives an isolated vault repository with only the required lints', () => {
  const config = testConfig()
  const derived = ingestConfig(config)
  expect(config.repositories[VAULT_REPOSITORY]).toBeUndefined()
  expect(derived.repositories[VAULT_REPOSITORY]).toMatchObject({
    path: config.paths.vault,
    base: 'main',
    remote: 'origin',
    stacks: ['bun'],
    checks: [{ run: 'bun scripts/lint.ts' }, { run: 'obsidian-wiki lint "$PWD"' }],
  })
})

test('ingest task names immutable sources and checks without selecting issue context', () => {
  const built = ingestTaskMessage(['raw/linear/2026-10-05-FOR-1.md'])
  expect(built.message).toContain('raw/linear/2026-10-05-FOR-1.md')
  expect(built.message).toContain('obsidian-wiki lint "$PWD"')
  expect(built.sections[0]?.sources).toEqual(['raw/linear/2026-10-05-FOR-1.md'])
})

test('prepare bases the ingest on the fetched remote main even when local main is behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-ingest-prepare-'))
  try {
    const sh = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(
        ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
        {
          cwd,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      if (r.exitCode !== 0) throw new Error(r.stderr.toString())
      return r.stdout.toString().trim()
    }
    const origin = join(root, 'origin')
    sh(root, 'init', '-q', '-b', 'main', origin)
    sh(origin, 'commit', '-q', '--allow-empty', '-m', 'one')
    const vault = join(root, 'vault')
    sh(root, 'clone', '-q', origin, vault)
    sh(origin, 'commit', '-q', '--allow-empty', '-m', 'two')
    const head = sh(origin, 'rev-parse', 'HEAD')
    const envs: Record<string, string>[] = []
    const runtime = ingestRuntime({
      dir: vault,
      owner: () => 'owner',
      token: async () => 'token',
      authEnv: (token) => {
        const env = { AUTH: token }
        envs.push(env)
        return env
      },
      sandbox: {} as SandboxDriver,
      driver: 'docker',
      artifacts: root,
    })
    const prepared = await runtime.prepare({
      issue: snapshot({ identifier: 'FOR-1' }),
      repository: 'omni',
      date: '2026-10-09',
      events: [],
      pr: null,
    })
    expect(prepared.baseSha).toBe(head)
    expect(envs).toEqual([{ AUTH: 'token' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
