import type { HarnessEvent, Ms, SandboxDriver, SandboxHandle, WorkerDriver, WorkerSession } from '../../ports'
import type { Run } from '../../ports/records'
import type { SandboxCreatedInfo, WorkerStartedInfo } from '../../ports/worker'
import { Channel } from './channel'
import { type CapReason, type Progress, type WatchAction, Watcher, type WatchThresholds } from './watch'
import { diffLines } from './workspace'

export const GRACE_MESSAGE = 'Limit reached: call finish now with your current status.'

export interface WorkerCallbacks {
  sandboxCreated?(runId: string, info: SandboxCreatedInfo): Promise<void>
  workerStarted(runId: string, info: WorkerStartedInfo): Promise<void>
  workerStalled(runId: string, signal: string, detail?: string): Promise<void>
  workerFinished(runId: string, payload: unknown): Promise<void>
  workerFailed(runId: string, reason: string, detail?: string): Promise<void>
  workerProgress?(runId: string, progress: Progress): Promise<void>
}

export type RunLimits = ConstructorParameters<typeof Watcher>[0] & { graceTurns: number }

type Active = {
  run: Run
  session: WorkerSession
  sandbox: SandboxHandle
  workdir: string
  watcher: Watcher
  graceLeft: number
  invalidFinish: number
  cap?: { reason: CapReason; at: number }
  done: boolean
  input: Channel<HarnessEvent | 'tick'>
}

export type RunWatchDeps = {
  sandbox: Pick<SandboxDriver, 'exec'>
  worker: Pick<WorkerDriver, 'events' | 'send' | 'stop'>
  thresholds: WatchThresholds
  graceMs?: Ms
  tickMs?: Ms
  now: () => number
  callbacks: () => WorkerCallbacks
}

export function failureReason(message: string): string {
  if (/event stream lost|sandbox|container/i.test(message)) return 'sandbox_error'
  if (/gateway|provider|api|rate.?limit|429|5\d\d|timed? ?out|ECONN|fetch failed/i.test(message)) {
    return 'gateway_error'
  }
  return 'crash'
}

export class RunWatch {
  private readonly active = new Map<string, Active>()

  constructor(private readonly d: RunWatchDeps) {}

  session(runId: string): WorkerSession | undefined {
    return this.active.get(runId)?.session
  }

  forget(runId: string): void {
    const a = this.active.get(runId)
    if (a) this.end(a)
  }

  watch(
    run: Run,
    session: WorkerSession,
    sandbox: SandboxHandle,
    workdir: string,
    limits: RunLimits,
    startedAt: number,
  ): void {
    this.active.get(run.id)?.input.close()
    const a: Active = {
      run,
      session,
      sandbox,
      workdir,
      watcher: new Watcher(limits, this.d.thresholds, startedAt),
      graceLeft: limits.graceTurns,
      invalidFinish: 0,
      done: false,
      input: new Channel(),
    }
    this.active.set(run.id, a)
    const timer = setInterval(() => a.input.push('tick'), this.d.tickMs ?? 10_000)
    ;(async () => {
      try {
        for await (const e of this.d.worker.events(session)) a.input.push(e)
        a.input.close()
      } catch (e) {
        a.input.push({ kind: 'error', message: (e as Error).message, fatal: true })
        a.input.close()
      }
    })()
    this.loop(a)
      .catch((e: Error) => this.fail(a, 'crash', e.message))
      .finally(() => clearInterval(timer))
  }

  private async loop(a: Active): Promise<void> {
    for await (const item of a.input) {
      if (a.done) return
      const now = this.d.now()
      if (item === 'tick') {
        await this.act(a, a.watcher.tick(now))
        if (a.cap && now - a.cap.at >= (this.d.graceMs ?? 300_000)) await this.fail(a, a.cap.reason)
        continue
      }
      await this.act(a, a.watcher.observe(item, now))
      if (!a.done) await this.handle(a, item)
    }
    if (!a.done) await this.fail(a, 'crash', 'worker event stream ended without finish')
  }

  private async handle(a: Active, e: HarnessEvent): Promise<void> {
    if (e.kind === 'finish') {
      this.end(a)
      await this.d.worker.stop(a.session, 'finished')
      await this.d.callbacks().workerFinished(a.run.id, e.payload)
      return
    }
    if (e.kind === 'tool_result' && e.tool === 'finish' && !e.ok) {
      a.invalidFinish += 1
      if (a.invalidFinish >= 2) await this.fail(a, 'no_finish', 'finish payload invalid after one correction')
      return
    }
    if (e.kind === 'error' && e.fatal) {
      await this.fail(a, failureReason(e.message), e.message)
      return
    }
    if (e.kind === 'idle' && e.sinceMs === 0) await this.grace(a, a.cap?.reason ?? 'no_finish')
  }

  private async act(a: Active, actions: WatchAction[]): Promise<void> {
    for (const action of actions) {
      if (a.done) return
      if (action.kind === 'progress') {
        const lines = await diffLines(this.d.sandbox, a.sandbox, a.workdir, a.run.baseSha)
        if (lines !== undefined) a.watcher.diff(lines)
        await this.d.callbacks().workerProgress?.(a.run.id, a.watcher.progress())
      } else if (action.kind === 'stall') {
        await this.d.callbacks().workerStalled(a.run.id, action.signal, action.detail)
      } else {
        a.cap = { reason: action.reason, at: this.d.now() }
        await this.grace(a, action.reason)
      }
    }
  }

  private async grace(a: Active, reason: string): Promise<void> {
    if (a.graceLeft <= 0) {
      await this.fail(a, reason)
      return
    }
    a.graceLeft -= 1
    await this.d.worker.send(a.session, GRACE_MESSAGE)
  }

  private async fail(a: Active, reason: string, detail?: string): Promise<void> {
    if (a.done) return
    this.end(a)
    await this.d.worker.stop(a.session, reason).catch(() => undefined)
    await this.d.callbacks().workerFailed(a.run.id, reason, detail)
  }

  private end(a: Active): void {
    a.done = true
    a.input.close()
    if (this.active.get(a.run.id) === a) this.active.delete(a.run.id)
  }
}
