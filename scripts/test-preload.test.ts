import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

test('bun run test strips git variables that would redirect fixture repositories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-preload-'))
  try {
    const outer = join(dir, 'outer')
    Bun.spawnSync(['git', 'init', '-q', outer])
    const env = { ...process.env, GIT_DIR: join(outer, '.git'), GIT_WORK_TREE: outer }
    const guarded = Bun.spawnSync(['bun', 'test', './scripts/test-preload.probe.ts'], {
      cwd: root,
      env,
      stderr: 'pipe',
    })
    expect(guarded.exitCode).not.toBe(0)
    expect(guarded.stderr.toString()).toContain('refusing to run tests with GIT_DIR, GIT_WORK_TREE set')
    const wrapped = Bun.spawnSync(['bun', 'run', 'test', './scripts/test-preload.probe.ts'], {
      cwd: root,
      env,
    })
    expect(wrapped.exitCode).toBe(0)
    const name = Bun.spawnSync(['git', '-C', outer, 'config', '--local', 'user.name'], { stdout: 'pipe' })
    expect(name.stdout.toString().trim()).toBe('')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bun run test makes git ignore a global core.hooksPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-preload-hooks-'))
  try {
    const hooks = join(dir, 'hooks')
    const repo = join(dir, 'repo')
    Bun.spawnSync(['mkdir', '-p', hooks])
    Bun.write(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n')
    Bun.spawnSync(['chmod', '+x', join(hooks, 'pre-commit')])
    Bun.spawnSync(['git', 'init', '-q', repo])
    const commit = Bun.spawnSync(
      [
        'git',
        '-C',
        repo,
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x',
      ],
      { stderr: 'pipe' },
    )
    expect(Bun.spawnSync(['git', 'config', '--get', 'core.hooksPath']).stdout.toString().trim()).toBe(
      '/dev/null',
    )
    expect(commit.exitCode).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
