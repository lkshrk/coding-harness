import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FakeSandboxDriver } from '../../adapters/worker/testing'
import type { Check, ExecResult } from '../../ports'
import { GATE_BUNDLE_MOUNT, GATE_REPO_MOUNT, OUTPUT_TAIL_CHARS, SandboxGateRunner } from './runner'

const repo = { name: 'omni', image: 'nightshift/worker:test', gitDir: '/home/u/omni/.git' }
const checks: Check[] = [
  { name: 'lint', run: 'make lint', timeoutMs: 60_000 },
  { name: 'test', run: 'bun test --bail', timeoutMs: 900_000 },
]

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-gates-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function setup(results: Record<string, Partial<ExecResult>> = {}) {
  const sandbox = new FakeSandboxDriver()
  sandbox.onExec = (cmd) => (cmd[2]?.startsWith('sh -c "$2"') ? (results[cmd[5] ?? ''] ?? {}) : undefined)
  const runner = new SandboxGateRunner({
    sandbox,
    outbox: join(root, 'outbox'),
    artifacts: join(root, 'artifacts'),
    resources: { cpus: 2, memoryMb: 4096 },
  })
  const checkRuns = () => sandbox.execs.filter((e) => e.cmd[2]?.startsWith('sh -c "$2"'))
  return { sandbox, runner, checkRuns }
}

describe('SandboxGateRunner', () => {
  test('runs the configured checks in order in a fresh sandbox, then destroys it', async () => {
    const { sandbox, runner, checkRuns } = setup({ 'make lint': { stdoutTail: 'lint ok' } })
    const results = await runner.run(repo, '', 'c0ffee', checks, { run: '01RUN' })

    expect(results.map((r) => [r.check, r.passed])).toEqual([
      ['lint', true],
      ['test', true],
    ])
    expect(sandbox.created).toHaveLength(1)
    expect(sandbox.created[0]).toMatchObject({
      name: '01RUN-gate',
      image: 'nightshift/worker:test',
      env: {},
      mounts: [{ hostPath: repo.gitDir, guestPath: GATE_REPO_MOUNT, readOnly: true }],
      labels: { nightshift: '1', run: '01RUN', gate: '01RUN-gate' },
    })
    const setupCmd = sandbox.execs[0]?.cmd ?? []
    expect(setupCmd.slice(4)).toEqual([GATE_REPO_MOUNT, '/work/omni', 'c0ffee', ''])
    expect(checkRuns().map((e) => [e.cmd[5], e.opts])).toEqual([
      ['make lint', { cwd: '/work/omni', timeoutMs: 60_000 }],
      ['bun test --bail', { cwd: '/work/omni', timeoutMs: 900_000 }],
    ])
    expect(sandbox.destroyed).toEqual(['ctr-01RUN-gate'])
    expect(readFileSync(join(root, 'artifacts', '01RUN', 'gate-lint.log'), 'utf8')).toBe('lint ok')
    expect(results[0]?.result.artifact).toBe(join(root, 'artifacts', '01RUN', 'gate-lint.log'))
  })

  test('stops at the first failing check and still destroys the sandbox', async () => {
    const { sandbox, runner, checkRuns } = setup({ 'make lint': { exitCode: 2, stderrTail: 'E501' } })
    const results = await runner.run(repo, '', 'c0ffee', checks, { run: '01RUN' })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ check: 'lint', passed: false, result: { exitCode: 2 } })
    expect(results[0]?.result.stdoutTail).toBe('E501')
    expect(checkRuns()).toHaveLength(1)
    expect(sandbox.destroyed).toEqual(['ctr-01RUN-gate'])
    expect(existsSync(join(root, 'artifacts', '01RUN', 'gate-test.log'))).toBe(false)
  })

  test('a timed-out check fails with exit code 124', async () => {
    const { runner } = setup({ 'make lint': { exitCode: 124, timedOut: true } })
    const [lint] = await runner.run(repo, '', 'c0ffee', checks, { run: '01RUN' })
    expect(lint).toMatchObject({ passed: false, result: { exitCode: 124, timedOut: true } })
  })

  test('runs the command line from config verbatim, whatever the repository contains', async () => {
    const { runner, checkRuns } = setup()
    const odd = [{ name: 'lint', run: `make lint && echo "it's $HOME"`, timeoutMs: 1000 }]
    await runner.run(repo, '', 'c0ffee', odd, { run: '01RUN' })
    expect(checkRuns()[0]?.cmd.slice(0, 2)).toEqual(['sh', '-c'])
    expect(checkRuns()[0]?.cmd[5]).toBe(`make lint && echo "it's $HOME"`)
  })

  test('the full log written to the outbox becomes the artifact; the event keeps a bounded tail', async () => {
    const { sandbox, runner } = setup()
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(60)}`)
    sandbox.onExec = (cmd) => {
      if (!cmd[2]?.startsWith('sh -c "$2"') || !cmd[4]) return undefined
      mkdirSync(dirname(cmd[4]), { recursive: true })
      writeFileSync(cmd[4], lines.join('\n'))
      return { exitCode: 1 }
    }
    const [lint] = await runner.run(repo, '', 'c0ffee', checks, { run: '01RUN' })
    expect(readFileSync(lint?.result.artifact ?? '', 'utf8')).toBe(lines.join('\n'))
    expect(lint?.result.stdoutTail.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS)
    expect(lint?.result.stdoutTail.endsWith(`line 499 ${'x'.repeat(60)}`)).toBe(true)
  })

  test('mounts and fetches a bundle when one is given', async () => {
    const { sandbox, runner } = setup()
    await runner.run(repo, '/outbox/01RUN/01RUN.bundle', 'c0ffee', checks, { run: '01RUN' })
    expect(sandbox.created[0]?.mounts[1]).toEqual({
      hostPath: '/outbox/01RUN/01RUN.bundle',
      guestPath: GATE_BUNDLE_MOUNT,
      readOnly: true,
    })
    expect(sandbox.execs[0]?.cmd.at(-1)).toBe(GATE_BUNDLE_MOUNT)
  })

  test('a failed checkout throws and destroys the sandbox', async () => {
    const { sandbox, runner } = setup()
    sandbox.onExec = (cmd) =>
      cmd[2]?.includes('clone') ? { exitCode: 128, stderrTail: 'bad object' } : undefined
    await expect(runner.run(repo, '', 'c0ffee', checks, { run: '01RUN' })).rejects.toThrow(
      'gate checkout of c0ffee failed: bad object',
    )
    expect(sandbox.destroyed).toEqual(['ctr-01RUN-gate'])
  })

  test('destroys a stale gate sandbox of the same run before creating a fresh one', async () => {
    const { sandbox, runner } = setup()
    const stale = { driver: 'docker' as const, id: 'old', name: '01RUN' }
    sandbox.list = async (labels: Record<string, string>) => (labels.gate === '01RUN-gate' ? [stale] : [])
    await runner.run(repo, '', 'c0ffee', checks, { run: '01RUN' })
    expect(sandbox.destroyed).toEqual(['old', 'ctr-01RUN-gate'])
  })
})
