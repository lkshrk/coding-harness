import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Config, expandHome } from '@nightshift/core'
import { importBundle, writeReviewArtifacts } from '../../adapters/git/host'
import { branchOf, parseDuration, workdirOf } from '../../policy/naming'
import type { GateResult, GateRunner, SandboxDriver } from '../../ports'
import { LockFailedError, type LockOutcome, type LockStep } from '../../ports/lock'
import type { Run } from '../../state/runs'

export interface GateCallbacks {
  headImported(runId: string, headSha: string): Promise<void>
  gatesFinished(runId: string, results: GateResult[]): Promise<void>
  workerFailed(runId: string, reason: string, detail?: string): Promise<void>
  lockRegenerated(runId: string, lock: LockOutcome['locks'][number]): Promise<void>
}

export type GateStepDeps = {
  config: () => Config
  image: (repository: string) => Promise<string>
  sandbox: Pick<SandboxDriver, 'exportCommits'>
  gates: GateRunner
  artifacts: string
  callbacks: () => GateCallbacks
  review?: (run: Run) => Promise<void>
  lock?: LockStep
  out?: (line: string) => void
  home?: string
}

export function gateStep(d: GateStepDeps): (run: Run, signal?: AbortSignal) => Promise<void> {
  return async (run, signal) => {
    if (run.state === 'reviewing') {
      if (d.review) await d.review(run)
      else d.out?.(`${run.issue}: review is not wired yet; run ${run.id} waits in reviewing`)
      return
    }
    if (run.state !== 'gating') return
    const cb = d.callbacks()
    const config = d.config()
    let results: GateResult[]
    try {
      const repo = config.repositories[run.repository]
      if (!repo) throw new Error(`no repository '${run.repository}'`)
      const checkout = expandHome(repo.path, d.home ?? homedir())
      let headSha = run.headSha
      if (headSha === null) {
        if (run.sandbox === null) throw new Error(`run ${run.id} has no worker sandbox to export from`)
        const handle = { driver: config.sandbox.driver, id: run.sandbox, name: run.id }
        const exported = await d.sandbox.exportCommits(
          handle,
          workdirOf(run),
          branchOf(run),
          `${run.issue}: ${run.agent} changes (uncommitted at finish)`,
        )
        headSha = importBundle(checkout, exported.bundle, branchOf(run), run.id)
        if (headSha !== exported.headSha) {
          throw new Error(`imported ${headSha} but the worker reported ${exported.headSha}`)
        }
        if (run.baseSha && headSha === run.baseSha) {
          await cb.workerFailed(run.id, 'no_finish', 'worker finished without changes')
          return
        }
        if (d.lock) {
          let locked: LockOutcome
          try {
            locked = await d.lock(checkout, run, headSha)
          } catch (e) {
            if (!(e instanceof LockFailedError)) throw e
            await cb.workerFailed(run.id, 'lock_failed', e.message)
            return
          }
          for (const lock of locked.locks) await cb.lockRegenerated(run.id, lock)
          headSha = locked.headSha
        }
        writeReviewArtifacts(checkout, run.baseSha || headSha, headSha, join(d.artifacts, run.id))
        await cb.headImported(run.id, headSha)
      }
      const checks = repo.checks.map((c) => ({
        name: c.name,
        run: c.run,
        timeoutMs: parseDuration(c.timeout),
      }))
      // The bundle went with the worker sandbox; gates read the commit via refs/nightshift/<run>.
      results = await d.gates.run(
        { name: run.repository, image: await d.image(run.repository), gitDir: join(checkout, '.git') },
        '',
        headSha,
        checks,
        { run: run.id, ...(signal ? { signal } : {}) },
      )
    } catch (e) {
      if (signal?.aborted) return
      await cb.workerFailed(run.id, 'sandbox_error', `gate: ${(e as Error).message}`)
      return
    }
    if (signal?.aborted) return
    await cb.gatesFinished(run.id, results)
  }
}
