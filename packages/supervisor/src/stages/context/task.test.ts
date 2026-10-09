import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openState } from '../../state/db'
import { EventLog } from '../../state/events'
import { RunStore } from '../../state/runs'
import { createUlid } from '../../state/ulid'
import { FakeLinear, issueBody, snapshot, testConfig } from '../../testing/testing'
import { FencedContextBuilder } from './builder'
import { gitObjectSource } from './git'
import { contextInput, contextTaskMessage } from './task'

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString().trim()
}

function repoWithBase(dir: string): string {
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  git(dir, 'add', '.')
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 2 // working tree\n')
  writeFileSync(join(dir, 'b.ts'), 'untracked\n')
  return base
}

describe('gitObjectSource', () => {
  test('reads paths and contents from the base commit, never the working tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-ctx-'))
    try {
      const base = repoWithBase(dir)
      const src = gitObjectSource({ name: 'omni', checkoutPath: dir, base })
      expect(await src.paths()).toEqual(['a.ts'])
      expect(new TextDecoder().decode(await src.read('a.ts'))).toBe('export const a = 1\n')
      expect(await src.read('b.ts')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('contextInput', () => {
  test('assembles the issue, blocker interfaces and earlier failed attempts', async () => {
    const config = testConfig()
    const db = openState(':memory:')
    const stores = { now: () => new Date(0), ulid: createUlid() }
    const runs = new RunStore(db, stores)
    const log = new EventLog(db, stores)
    const prior = runs.create({
      issue: 'FOR-2',
      agent: 'fixer',
      profile: 'cloud',
      model: 'ns/coder',
      repository: 'omni',
      baseSha: 'abc',
      attempt: 1,
    })
    runs.update(prior.id, { failure: 'implementation_defect', finish: { summary: 'tests still red' } })
    log.append({
      type: 'GATE_FAILED',
      issue: 'FOR-2',
      run: prior.id,
      data: { check: 'test', exit_code: 1, duration_ms: 5, output_tail: 'expected 3, got 2' },
    })
    log.append({
      type: 'REVIEW_RECEIVED',
      issue: 'FOR-2',
      run: prior.id,
      data: {
        verdict: 'fail',
        model: 'm',
        findings: [
          {
            severity: 'BLOCKER',
            file: 'test/a.ts',
            lines: '3-4',
            message: 'drops the 3-row check',
            evidence: 'e',
            confidence: 0.9,
          },
        ],
      },
    })
    const current = runs.create({ ...prior, attempt: 2 })
    const linear = new FakeLinear(config, () => new Date(0))
    linear.put(
      snapshot({
        identifier: 'FOR-1',
        description: issueBody().replace('## Interfaces out\nnone', '## Interfaces out\n`retry(): void`'),
      }),
    )
    const issue = snapshot({
      identifier: 'FOR-2',
      title: 'Use retries',
      blockedBy: [{ identifier: 'FOR-1', team: 'FOR', status: 'Done' }],
    })

    const input = await contextInput(
      { config: () => config, db, linear, builder: {} as never, home: '/h' },
      {
        run: current,
        issue,
        files: [],
      },
    )
    expect(input.issue).toMatchObject({ identifier: 'FOR-2', title: 'Use retries', files: ['src/a.ts'] })
    expect(input.repository).toEqual({ name: 'omni', checkoutPath: '/tmp/omni', base: 'abc' })
    expect(input.blockers).toEqual([{ identifier: 'FOR-1', interfaces: '`retry(): void`' }])
    expect(input.attempts).toEqual([
      {
        attempt: 1,
        agent: 'fixer',
        failureClass: 'implementation_defect',
        summary: 'tests still red',
        gateTail: '$ test (exit 1)\nexpected 3, got 2',
        findings: '- BLOCKER test/a.ts:3-4: drops the 3-row check',
      },
    ])
    expect(input.vaultPages).toEqual([])
  })

  test('a continuation from a wip commit says so in HISTORY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ns-ctx-'))
    try {
      const base = repoWithBase(dir)
      git(dir, 'add', '-A')
      git(
        dir,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '-m',
        'wip: FOR-4 attempt 1 (BLOCKED)',
      )
      const wip = git(dir, 'rev-parse', 'HEAD')
      const config = testConfig()
      const omni = config.repositories.omni as NonNullable<(typeof config.repositories)['omni']>
      const withDir = { ...config, repositories: { ...config.repositories, omni: { ...omni, path: dir } } }
      const db = openState(':memory:')
      const runs = new RunStore(db, { now: () => new Date(0), ulid: createUlid() })
      const create = (attempt: number) =>
        runs.create({
          issue: 'FOR-4',
          agent: 'fixer',
          profile: 'cloud',
          model: 'm',
          repository: 'omni',
          baseSha: base,
          attempt,
        })
      const prior = create(1)
      const run = create(2)
      const deps = { config: () => withDir, db, linear: new FakeLinear(config, () => new Date(0)) }
      const issue = snapshot({ identifier: 'FOR-4' })
      const continued = await contextInput(
        { ...deps, builder: {} as never },
        { run, issue, files: [], repairFrom: { run: prior.id, headSha: wip } },
      )
      expect(continued.wipHead).toBe(wip)
      const fresh = await contextInput({ ...deps, builder: {} as never }, { run, issue, files: [] })
      expect(fresh.wipHead).toBeUndefined()
      const notWip = await contextInput(
        { ...deps, builder: {} as never },
        { run, issue, files: [], repairFrom: { run: prior.id, headSha: base } },
      )
      expect(notWip.wipHead).toBeUndefined()

      const message = contextTaskMessage({
        ...deps,
        builder: new FencedContextBuilder({ count: async (t) => t.length / 4, source: gitObjectSource }),
      })
      const built = await message(
        { run, issue, files: [], repairFrom: { run: prior.id, headSha: wip } },
        { inputTokens: 20_000, model: 'm' },
      )
      expect(built.message).toContain(`starts with a WIP commit ${wip.slice(0, 12)}`)
      expect(built.message).toContain('git reset --soft HEAD^')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a description outside the template is rejected', async () => {
    const config = testConfig()
    const db = openState(':memory:')
    const run = new RunStore(db, { now: () => new Date(0), ulid: createUlid() }).create({
      issue: 'FOR-3',
      agent: 'fixer',
      profile: 'cloud',
      model: 'm',
      repository: 'omni',
      baseSha: 'abc',
      attempt: 1,
    })
    const message = contextTaskMessage({
      config: () => config,
      db,
      linear: new FakeLinear(config, () => new Date(0)),
      builder: new FencedContextBuilder({ count: async (t) => t.length, source: gitObjectSource }),
    })
    await expect(
      message(
        { run, issue: snapshot({ identifier: 'FOR-3', description: 'just do it' }), files: [] },
        {
          inputTokens: 1000,
          model: 'm',
        },
      ),
    ).rejects.toThrow('does not follow the issue template')
  })
})
