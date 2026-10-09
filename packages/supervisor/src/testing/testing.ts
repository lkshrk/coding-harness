import type {
  ExecutorStart,
  Notification,
  Notifier,
  OutboxDirs,
  RunExecutor,
  SandboxDriver,
  SandboxHandle,
  SandboxStatus,
  WorkerDriver,
  WorkerSession,
} from '../ports'
import type { Run } from '../state/runs'

export * from './config'
export * from './linear'

export class FakeExecutor implements RunExecutor {
  readonly calls: { op: string; run: string; detail?: string }[] = []
  readonly starts: ExecutorStart[] = []
  readonly heads = new Map<string, string>()
  failStart: string | Error | undefined

  async start(s: ExecutorStart): Promise<void> {
    this.calls.push({ op: 'start', run: s.run.id })
    this.starts.push(s)
    if (this.failStart) throw this.failStart instanceof Error ? this.failStart : new Error(this.failStart)
  }

  async reattach(run: Run): Promise<void> {
    this.calls.push({ op: 'reattach', run: run.id })
  }

  async runStep(run: Run): Promise<void> {
    this.calls.push({ op: 'runStep', run: run.id, detail: run.state })
  }

  async nudge(run: Run, message: string): Promise<void> {
    this.calls.push({ op: 'nudge', run: run.id, detail: message })
  }

  async stop(run: Run, reason: string): Promise<void> {
    this.calls.push({ op: 'stop', run: run.id, detail: reason })
  }

  detach(): void {
    this.calls.push({ op: 'detach', run: '*' })
  }

  async captureHead(run: Run, _status?: string): Promise<string | undefined> {
    this.calls.push({ op: 'captureHead', run: run.id, detail: run.sandbox ?? '' })
    return this.heads.get(run.id)
  }

  ops(op: string): string[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.run)
  }
}

export class FakeSandbox implements Pick<SandboxDriver, 'status' | 'list' | 'destroy'> {
  readonly sandboxes = new Map<string, { handle: SandboxHandle; status: SandboxStatus }>()
  readonly destroyed: string[] = []

  add(name: string, status: SandboxStatus = 'running'): SandboxHandle {
    const handle: SandboxHandle = { driver: 'docker', id: `sb-${name}`, name }
    this.sandboxes.set(handle.id, { handle, status })
    return handle
  }

  async status(h: SandboxHandle): Promise<SandboxStatus> {
    return this.sandboxes.get(h.id)?.status ?? 'gone'
  }

  async list(): Promise<SandboxHandle[]> {
    return [...this.sandboxes.values()].map((s) => s.handle)
  }

  async destroy(h: SandboxHandle): Promise<void> {
    this.sandboxes.delete(h.id)
    this.destroyed.push(h.id)
  }
}

export class FakeWorker implements Pick<WorkerDriver, 'alive'> {
  readonly sessions = new Set<string>()

  async alive(s: WorkerSession): Promise<boolean> {
    return this.sessions.has(s.id)
  }
}

export class FakeNotifier implements Notifier {
  readonly sent: Notification[] = []

  async notify(n: Notification): Promise<'macos'> {
    this.sent.push(n)
    return 'macos'
  }
}

export class FakeOutbox implements OutboxDirs {
  readonly dirs = new Set<string>()

  list(): string[] {
    return [...this.dirs]
  }

  remove(run: string): void {
    this.dirs.delete(run)
  }
}
