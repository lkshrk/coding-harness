import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('probe: a fixture git write stays in the fixture', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ns-probe-'))
  try {
    Bun.spawnSync(['git', 'init', '-q', fixture])
    Bun.spawnSync(['git', '-C', fixture, 'config', 'user.name', 'Fixture'])
    const r = Bun.spawnSync(['git', '-C', fixture, 'config', '--local', 'user.name'], { stdout: 'pipe' })
    expect(r.stdout.toString().trim()).toBe('Fixture')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
