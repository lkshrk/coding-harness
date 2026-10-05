import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Check, GateResult, GateRunner, Mount, SandboxDriver, SandboxHandle } from '../interfaces'

export const GATE_REPO_MOUNT = '/mnt/repo.git'
export const GATE_BUNDLE_MOUNT = '/mnt/run.bundle'
export const OUTPUT_TAIL_CHARS = 8000
const TAIL_LINES = 200

export type SandboxGateRunnerOptions = {
  sandbox: SandboxDriver
  outbox: string
  artifacts: string
  resources: { cpus: number; memoryMb: number }
  egress?: string[]
}

export function outputTail(text: string): string {
  return text.split('\n').slice(-TAIL_LINES).join('\n').slice(-OUTPUT_TAIL_CHARS)
}

export function gateName(run: string | undefined, headSha: string): string {
  return `${run ?? headSha.slice(0, 12)}-gate`
}

export class SandboxGateRunner implements GateRunner {
  constructor(private readonly o: SandboxGateRunnerOptions) {}

  async run(
    repo: { name: string; image: string; gitDir: string },
    bundle: string,
    headSha: string,
    checks: Check[],
    opts: { run?: string } = {},
  ): Promise<GateResult[]> {
    const name = gateName(opts.run, headSha)
    const runDir = join(this.o.artifacts, opts.run ?? name)
    for (const stale of await this.o.sandbox.list({ gate: name })) await this.o.sandbox.destroy(stale)
    const mounts: Mount[] = [{ hostPath: repo.gitDir, guestPath: GATE_REPO_MOUNT, readOnly: true }]
    if (bundle) mounts.push({ hostPath: bundle, guestPath: GATE_BUNDLE_MOUNT, readOnly: true })
    // Docker Desktop keeps a deleted bind-mount path stale, so each gate gets a fresh outbox path.
    const outbox = join(this.o.outbox, `${name}-${Date.now().toString(36)}`)
    const handle = await this.o.sandbox.create({
      name,
      image: repo.image,
      resources: this.o.resources,
      outbox,
      mounts,
      env: {},
      egress: { allow: this.o.egress ?? [] },
      workdir: '/work',
      labels: { nightshift: '1', run: opts.run ?? name, gate: name },
    })
    try {
      const workdir = `/work/${repo.name}`
      await this.checkout(handle, workdir, headSha, bundle ? GATE_BUNDLE_MOUNT : '')
      mkdirSync(runDir, { recursive: true })
      const results: GateResult[] = []
      for (const check of checks) {
        const result = await this.exec(handle, workdir, outbox, runDir, check)
        results.push(result)
        if (!result.passed) break
      }
      return results
    } finally {
      await this.o.sandbox.destroy(handle)
    }
  }

  private async checkout(h: SandboxHandle, workdir: string, headSha: string, bundle: string): Promise<void> {
    const script = [
      'set -e',
      'git config --global --add safe.directory "*" && git clone --quiet --shared --no-checkout "$1" "$2"',
      'if [ -n "$4" ]; then git -C "$2" fetch --quiet "$4"; fi',
      'git -C "$2" -c advice.detachedHead=false checkout --quiet --detach "$3"',
    ].join('\n')
    const res = await this.o.sandbox.exec(h, [
      'sh',
      '-c',
      script,
      'sh',
      GATE_REPO_MOUNT,
      workdir,
      headSha,
      bundle,
    ])
    if (res.exitCode !== 0) throw new Error(`gate checkout of ${headSha} failed: ${res.stderrTail.trim()}`)
  }

  private async exec(
    h: SandboxHandle,
    workdir: string,
    outbox: string,
    runDir: string,
    check: Check,
  ): Promise<GateResult> {
    const log = join(outbox, `${check.name}.log`)
    const res = await this.o.sandbox.exec(
      h,
      ['sh', '-c', 'sh -c "$2" >"$1" 2>&1; rc=$?; tail -n 200 "$1"; exit $rc', 'sh', log, check.run],
      { cwd: workdir, timeoutMs: check.timeoutMs },
    )
    const artifact = join(runDir, `gate-${check.name}.log`)
    if (existsSync(log)) copyFileSync(log, artifact)
    else writeFileSync(artifact, [res.stdoutTail, res.stderrTail].filter(Boolean).join('\n'))
    const output = readFileSync(artifact, 'utf8')
    return {
      check: check.name,
      passed: res.exitCode === 0 && !res.timedOut,
      result: { ...res, stdoutTail: outputTail(output), stderrTail: '', artifact },
    }
  }
}
