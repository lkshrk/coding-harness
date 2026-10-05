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
