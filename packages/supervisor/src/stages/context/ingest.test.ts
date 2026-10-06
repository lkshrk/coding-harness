import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Event } from '../../state/events'
import { snapshot as issue } from '../../testing/testing'
import { publishIngest, writeIngestSources } from './ingest'

const dirs: string[] = []
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-ingest-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('source writer fixes content, omits empty sources, and refuses changed raw files', () => {
  const dir = temporary()
  const fixture = {
    dir,
    date: '2026-10-05',
    issue: issue({
      identifier: 'FOR-1',
      title: 'Fix it',
      description: 'A lesson.',
      status: 'Done',
      labels: ['bug'],
    }),
    repository: 'omni',
    events: [],
  }
  expect(writeIngestSources(fixture)).toEqual(['raw/linear/2026-10-05-FOR-1.md'])
  const path = join(dir, 'raw/linear/2026-10-05-FOR-1.md')
  expect(readFileSync(path, 'utf8')).toBe(
    '# FOR-1: Fix it\n\nRepository: omni\nState: Done\nLabels: bug\n\nA lesson.\n',
  )
  expect(writeIngestSources(fixture)).toHaveLength(1)
  expect(() => writeIngestSources({ ...fixture, issue: { ...fixture.issue, title: 'Changed' } })).toThrow(
    'immutable',
  )
  const changed = { ...fixture, issue: { ...fixture.issue, status: 'Canceled' } }
  expect(writeIngestSources({ ...changed, reuse: true })).toEqual(['raw/linear/2026-10-05-FOR-1.md'])
  expect(readFileSync(path, 'utf8')).toContain('State: Done')
})

test('review and failure sources preserve event evidence with fixed content', () => {
  const dir = temporary()
  const events: Event[] = [
    {
      id: '1',
      ts: 'now',
      type: 'REVIEW_RECEIVED',
      issue: 'FOR-1',
      run: 'run',
      data: {
        verdict: 'fail',
        findings: [{ severity: 'BLOCKER', message: 'Bad', file: 'a.ts', evidence: 'line', confidence: 1 }],
      },
    },
    {
      id: '2',
      ts: 'later',
      type: 'FAILURE_CLASSIFIED',
      issue: 'FOR-1',
      run: 'run',
      data: { class: 'review_failed', action: 'repair', evidence: 'Bad' },
    },
  ]
  const paths = writeIngestSources({
    dir,
    date: '2026-10-05',
    issue: issue({ identifier: 'FOR-1' }),
    repository: 'omni',
    events,
  })
  expect(paths).toEqual([
    'raw/linear/2026-10-05-FOR-1.md',
    'raw/reviews/2026-10-05-FOR-1.md',
    'raw/failures/2026-10-05-FOR-1.md',
  ])
  for (const [path, event] of [
    [paths[1], events[0]],
    [paths[2], events[1]],
  ] as const) {
    expect(readFileSync(join(dir, path ?? ''), 'utf8')).toBe(`# FOR-1\n\n${JSON.stringify(event, null, 2)}\n`)
  }
})

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  return p.stdout.toString().trim()
}

function bundleFixture() {
  const dir = temporary()
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(dir, 'README.md'), 'Vault\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial')
  const baseSha = git(dir, 'rev-parse', 'HEAD')
  const sources = writeIngestSources({
    dir,
    date: '2026-10-05',
    issue: issue({ identifier: 'FOR-1' }),
    repository: 'omni',
    events: [],
  })
  const source = readFileSync(join(dir, sources[0] ?? ''), 'utf8')
  git(dir, 'add', 'raw')
  git(dir, 'commit', '-m', `ingest: ${sources[0]}`)
  const bundle = join(temporary(), 'worker.bundle')
  git(dir, 'bundle', 'create', bundle, 'main', `^${baseSha}`)
  git(dir, 'reset', '--hard', baseSha)
  writeIngestSources({
    dir,
    date: '2026-10-05',
    issue: issue({ identifier: 'FOR-1' }),
    repository: 'omni',
    events: [],
  })
  git(dir, 'remote', 'add', 'origin', '/unused-local-vault')
  return { dir, baseSha, sources, source, bundle, ref: 'refs/heads/main', run: 'test-run' }
}

for (const rejected of [0, 1, 2])
  test(`publisher imports, lints, rebases, authenticates, and retries ${rejected} rejections`, async () => {
    const fixture = bundleFixture()
    const calls: string[] = []
    let pushes = 0
    const promise = publishIngest({
      ...fixture,
      owner: () => 'owner',
      token: async (owner) => {
        expect(owner).toBe('owner')
        return 'token'
      },
      authEnv: (token) => ({ AUTH: token }),
      command: (args, options) => {
        const cmd = args.join(' ')
        if (args[0] !== 'git' || ['pull', 'push'].includes(args[1] ?? '')) {
          calls.push(cmd)
          if (args[0] === 'git') expect(options.env.AUTH).toBe('token')
          if (args[1] === 'push' && ++pushes <= rejected) throw new Error('push rejected')
          return ''
        }
        return `${git(options.cwd, ...args.slice(1))}\n`
      },
    })
    if (rejected === 2) {
      await expect(promise).rejects.toThrow('push rejected')
      expect(readFileSync(join(fixture.dir, fixture.sources[0] ?? ''), 'utf8')).toBe(fixture.source)
    } else expect(await promise).toHaveLength(1)
    expect(calls.slice(0, 3)).toEqual([
      'bun scripts/lint.ts',
      expect.stringContaining('obsidian-wiki lint '),
      'git pull --rebase origin main',
    ])
    expect(calls.filter((c) => c === 'git push origin HEAD:main')).toHaveLength(rejected === 0 ? 1 : 2)
    expect(calls.filter((c) => c === 'git pull --rebase origin main')).toHaveLength(rejected === 0 ? 1 : 2)
  })
