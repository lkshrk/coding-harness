import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DockerSandbox } from '../../adapters/worker/docker'
import { importBundle } from './host'
import { SandboxGateRunner } from './runner'
import { gitFixture } from './testing'

const live = process.env.NIGHTSHIFT_DOCKER_LIVE === '1'
const image = process.env.NIGHTSHIFT_GATE_IMAGE ?? 'nightshift-gate-test:latest'

describe.skipIf(!live)('gates in Docker (NIGHTSHIFT_DOCKER_LIVE=1)', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ns-gate-live-'))
    if (process.env.NIGHTSHIFT_GATE_IMAGE) return
    const build = Bun.spawnSync(['docker', 'build', '--quiet', '--tag', image, '-'], {
      stdin: new TextEncoder().encode('FROM alpine:3\nRUN apk add --no-cache git coreutils\n'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (build.exitCode !== 0) throw new Error(build.stderr.toString())
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('runs passing, failing and timed-out checks on the imported commit', async () => {
    const fx = gitFixture(root)
    const { bundle, headSha } = fx.bundle()
    importBundle(fx.checkout, bundle, fx.branch, 'LIVE')
    const sandbox = new DockerSandbox({ artifactsDir: join(root, 'exec') })
    const runner = new SandboxGateRunner({
      sandbox,
      outbox: join(root, 'gate-outbox'),
      artifacts: join(root, 'artifacts'),
      resources: { cpus: 1, memoryMb: 512 },
    })
    const repo = { name: 'omni', image, gitDir: join(fx.checkout, '.git') }

    const passing = await runner.run(
      repo,
      '',
      headSha,
      [
        {
          name: 'head',
          run: `test "$(git rev-parse HEAD)" = ${headSha} && test -f src/b.ts`,
          timeoutMs: 60_000,
        },
        { name: 'fail', run: 'echo boom; exit 3', timeoutMs: 60_000 },
        { name: 'never', run: 'true', timeoutMs: 60_000 },
      ],
      { run: 'LIVE' },
    )
    expect(passing.map((r) => [r.check, r.passed, r.result.exitCode])).toEqual([
      ['head', true, 0],
      ['fail', false, 3],
    ])
    expect(passing[1]?.result.stdoutTail.trim()).toBe('boom')
    expect(readFileSync(join(root, 'artifacts', 'LIVE', 'gate-fail.log'), 'utf8').trim()).toBe('boom')

    const [slow] = await runner.run(
      repo,
      '',
      headSha,
      [{ name: 'slow', run: 'sleep 30', timeoutMs: 2_000 }],
      {
        run: 'LIVE',
      },
    )
    expect(slow?.result).toMatchObject({ exitCode: 124, timedOut: true })
    expect(await sandbox.list({ gate: 'LIVE-gate' })).toEqual([])
  }, 180_000)
})
