import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentDef,
  type Config,
  expandHome,
  type OpenCodePluginEntry,
  renderAgent,
  renderContext,
  renderFinishPlugin,
  type WorkerImage,
} from '@nightshift/core'
import { INDEX_MOUNT, indexDb } from '../codegraph'
import type { TaskMessage } from '../context'
import { runRef } from '../gates/host'
import type {
  BuiltContext,
  HarnessEvent,
  Ms,
  SandboxDriver,
  SandboxHandle,
  WorkerDriver,
  WorkerSession,
} from '../interfaces'
import type { ExecutorStart, RunExecutor } from '../ports'
import type { Run } from '../runs'
import type { SandboxCreatedInfo, WorkerStartedInfo } from '../supervisor'
import { Channel } from './channel'
import { memoryMb } from './docker'
import { OPENCODE_CONFIG_DIR, WORKER_HOME } from './opencode'
import {
  type CapReason,
  type Progress,
  WATCH_DEFAULTS,
  type WatchAction,
  Watcher,
  type WatchThresholds,
} from './watch'

// The index mount is read-only; cbm needs a writable cache dir, so the database is linked into one.
const GRAPH_CACHE = `${WORKER_HOME}/cbm`

export const REPO_MOUNT = '/mnt/repo.git'
export const CA_MOUNT = '/etc/nightshift/ca.pem'
export const GRACE_MESSAGE = 'Limit reached: call finish now with your current status.'

export interface WorkerCallbacks {
  sandboxCreated?(runId: string, info: SandboxCreatedInfo): Promise<void>
  workerStarted(runId: string, info: WorkerStartedInfo): Promise<void>
  workerStalled(runId: string, signal: string, detail?: string): Promise<void>
  workerFinished(runId: string, payload: unknown): Promise<void>
  workerFailed(runId: string, reason: string, detail?: string): Promise<void>
  workerProgress?(runId: string, progress: Progress): Promise<void>
}

export type WorkerExecutorDeps = {
  config: Config
  sandbox: SandboxDriver
  worker: WorkerDriver
  agents: ReadonlyMap<string, AgentDef>
  finishPlugin: string
  skillFiles?: (skill: string) => { path: string; content: string }[]
  codeGraph?: (run: Run) => Promise<string | undefined>
  image(run: Run): Promise<WorkerImage>
  taskMessage: TaskMessage
  gatewayKey(run: Run): Promise<string>
  runStep(run: Run): Promise<void>
  thresholds?: Partial<WatchThresholds>
  graceMs?: Ms
  tickMs?: Ms
  home?: string
  now?: () => number
}

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

const dropped = (what: string) => async (runId: string) => {
  console.error(`run ${runId}: ${what} after executor detach ignored`)
}

const DETACHED: WorkerCallbacks = {
  sandboxCreated: dropped('sandbox created'),
  workerStarted: dropped('start'),
  workerStalled: dropped('stall'),
  workerFinished: dropped('finish'),
  workerFailed: dropped('failure'),
  workerProgress: dropped('progress'),
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 }
const UNIT_TOKENS: Record<string, number> = { k: 1_000, M: 1_000_000 }

export function parseDuration(value: string): Ms {
  const m = value.match(/^([1-9][0-9]*)(s|m|h)$/)
  if (!m) throw new Error(`invalid duration '${value}'`)
  return Number(m[1]) * (UNIT_MS[m[2] as string] as number)
}

export function parseTokens(value: string): number {
  const m = value.match(/^([1-9][0-9]*)(k|M)?$/)
  if (!m) throw new Error(`invalid token count '${value}'`)
  return Number(m[1]) * (m[2] ? (UNIT_TOKENS[m[2]] as number) : 1)
}

export function shellJoin(args: string[]): string {
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ')
}

export function workdirOf(run: Pick<Run, 'repository'>): string {
  return `/work/${run.repository}`
}

export function branchOf(run: Pick<Run, 'issue' | 'attempt'>): string {
  return `ns/${run.issue}-${run.attempt}`
}

export function failureReason(message: string): string {
  if (/event stream lost|sandbox|container/i.test(message)) return 'sandbox_error'
  if (/gateway|provider|api|rate.?limit|429|5\d\d|timed? ?out|ECONN|fetch failed/i.test(message)) {
    return 'gateway_error'
  }
  return 'crash'
}

export class WorkerExecutor implements RunExecutor {
  private readonly active = new Map<string, Active>()
  private readonly thresholds: WatchThresholds
  private readonly now: () => number
  private callbacks: WorkerCallbacks | undefined
  private detached = false

  constructor(private readonly d: WorkerExecutorDeps) {
    this.thresholds = { ...WATCH_DEFAULTS, ...d.thresholds }
    this.now = d.now ?? Date.now
  }

  bind(callbacks: WorkerCallbacks): void {
    this.callbacks = callbacks
    this.detached = false
  }

  detach(): void {
    this.callbacks = undefined
    this.detached = true
  }

  async start({ run, issue, files, sourceFiles, repairFrom }: ExecutorStart): Promise<void> {
    const def = this.d.agents.get(run.agent)
    if (!def) throw new Error(`no agent '${run.agent}'`)
    const repo = this.d.config.repositories[run.repository]
    if (!repo) throw new Error(`no repository '${run.repository}'`)
    const home = this.d.home ?? homedir()
    const index = await this.codeGraph(run)
    const context = await this.d.taskMessage(
      { run, issue, files, ...(index ? { indexPath: index } : {}) },
      { inputTokens: def.budget.inputTokens, model: run.model },
    )
    this.storeContext(run, context, home)
    const gateway = this.d.config.gateway
    const workdir = workdirOf(run)
    const worker = await this.d.image(run)
    const image = worker.image
    const sandbox = await this.d.sandbox.create({
      name: run.id,
      image,
      resources: {
        cpus: this.d.config.sandbox.resources.cpus ?? 4,
        memoryMb: memoryMb(this.d.config.sandbox.resources.memory),
      },
      outbox: join(expandHome(this.d.config.paths.cache, home), 'outbox', run.id),
      mounts: [
        { hostPath: join(expandHome(repo.path, home), '.git'), guestPath: REPO_MOUNT, readOnly: true },
        ...(gateway.ca_bundle
          ? [{ hostPath: expandHome(gateway.ca_bundle, home), guestPath: CA_MOUNT, readOnly: true as const }]
          : []),
        ...(index ? [{ hostPath: index, guestPath: INDEX_MOUNT, readOnly: true as const }] : []),
      ],
      env: index ? { CBM_CACHE_DIR: GRAPH_CACHE, NS_GRAPH_PROJECT: run.repository } : {},
      egress: { allow: [new URL(gateway.base_url).host, ...worker.egress] },
      workdir: '/work',
      labels: { nightshift: '1', run: run.id, issue: run.issue },
    })
    await this.cb().sandboxCreated?.(run.id, { driver: sandbox.driver, id: sandbox.id, image })
    let session: WorkerSession
    try {
      await this.prepare(sandbox, workdir, run)
      for (const file of sourceFiles ?? []) {
        if (!/^raw\/(linear|prs|reviews|failures)\/[^/]+\.md$/.test(file.path)) {
          throw new Error(`invalid ingest source path: ${file.path}`)
        }
        const res = await this.d.sandbox.exec(
          sandbox,
          [
            'sh',
            '-c',
            'set -e; mkdir -p "$(dirname "$1")"; set -C; cat > "$1"',
            'sh',
            `${workdir}/${file.path}`,
          ],
          { stdin: file.content },
        )
        if (res.exitCode !== 0) throw new Error(`source copy failed: ${res.stderrTail.trim()}`)
      }
      if (repairFrom) await this.continueFrom(sandbox, workdir, run, repairFrom)
      if (index) await this.linkIndex(sandbox, run)
      const rendered = renderAgent(def, renderContext(this.d.config, run.profile))
      const plugin = renderFinishPlugin([def], OPENCODE_CONFIG_DIR, this.d.finishPlugin)
      const skills = def.skills.flatMap((s) =>
        (this.d.skillFiles?.(s) ?? []).map((f) => ({ path: `skills/${s}/${f.path}`, content: f.content })),
      )
      session = await this.d.worker.start({
        sandbox,
        agent: {
          name: def.name,
          files: [
            { path: rendered.path, content: rendered.content },
            ...(plugin?.files ?? []),
            ...skills,
            {
              path: 'opencode.json',
              content: JSON.stringify(opencodeConfig(plugin?.plugin, worker.lsp, skills.length > 0)),
            },
          ],
        },
        model: run.model,
        taskMessage: context.message,
        gateway: {
          baseUrl: gateway.base_url,
          apiKey: await this.d.gatewayKey(run),
          sessionId: run.id,
        },
        limits: this.limits(def),
        workdir,
      })
    } catch (e) {
      await this.d.sandbox.destroy(sandbox).catch(() => undefined)
      throw e
    }
    await this.cb().workerStarted(run.id, {
      sandbox: sandbox.id,
      session: session.id,
      attach: shellJoin(session.attach),
    })
    this.watch(run, session, sandbox, workdir, def, this.now())
  }

  async reattach(run: Run): Promise<void> {
    if (run.session === null || run.sandbox === null) throw new Error(`run ${run.id} has no session`)
    const def = this.d.agents.get(run.agent)
    if (!def) throw new Error(`no agent '${run.agent}'`)
    const sandbox: SandboxHandle = { driver: this.d.config.sandbox.driver, id: run.sandbox, name: run.id }
    this.watch(run, { id: run.session, attach: [] }, sandbox, workdirOf(run), def, Date.parse(run.startedAt))
  }

  runStep(run: Run): Promise<void> {
    return this.d.runStep(run)
  }

  async nudge(run: Run, message: string): Promise<void> {
    if (run.session === null) return
    await this.d.worker.send({ id: run.session, attach: [] }, message)
  }

  async stop(run: Run, reason: string): Promise<void> {
    const a = this.active.get(run.id)
    if (a) this.end(a)
    const session = a?.session.id ?? run.session
    if (session !== null) await this.d.worker.stop({ id: session, attach: [] }, reason)
  }

  private storeContext(run: Run, context: BuiltContext, home: string): void {
    const dir = join(expandHome(this.d.config.paths.state, home), 'artifacts', run.id)
    mkdirSync(dir, { recursive: true })
    const summary = { tokens: context.tokens, sections: context.sections }
    writeFileSync(join(dir, 'context.json'), `${JSON.stringify(summary, null, 2)}\n`)
  }

  private async codeGraph(run: Run): Promise<string | undefined> {
    if (run.agent === 'ingester') return undefined
    try {
      return await this.d.codeGraph?.(run)
    } catch (e) {
      console.error(`${run.issue}: code graph unavailable: ${(e as Error).message}`)
      return undefined
    }
  }

  private async linkIndex(sandbox: SandboxHandle, run: Run): Promise<void> {
    const res = await this.d.sandbox.exec(sandbox, [
      'sh',
      '-c',
      'mkdir -p "$1" && ln -sf "$2" "$1/"',
      'sh',
      GRAPH_CACHE,
      `${INDEX_MOUNT}/${indexDb(run.repository)}`,
    ])
    if (res.exitCode !== 0) throw new Error(`code graph link failed: ${res.stderrTail.trim()}`)
  }

  private async continueFrom(
    sandbox: SandboxHandle,
    workdir: string,
    run: Run,
    from: NonNullable<ExecutorStart['repairFrom']>,
  ): Promise<void> {
    const res = await this.d.sandbox.exec(sandbox, [
      'sh',
      '-c',
      'set -e; git -C "$1" fetch --quiet "$2" "+$3:refs/nightshift/previous"; git -C "$1" checkout --quiet -B "$4" refs/nightshift/previous; git -C "$1" rev-parse HEAD',
      'sh',
      workdir,
      REPO_MOUNT,
      runRef(from.run),
      branchOf(run),
    ])
    const head = res.stdoutTail.trim().split('\n').at(-1)
    if (res.exitCode !== 0 || head !== from.headSha) {
      throw new Error(`continuing from ${from.headSha.slice(0, 12)} failed: ${res.stderrTail.trim() || head}`)
    }
  }

  private async prepare(sandbox: SandboxHandle, workdir: string, run: Run): Promise<void> {
    const script = [
      'set -e',
      'git config --global --add safe.directory "*" && git clone --quiet --shared "$1" "$2"',
      'git -C "$2" checkout --quiet -b "$3" "$4"',
      'git -C "$2" config user.name nightshift',
      'git -C "$2" config user.email nightshift@localhost',
    ].join('\n')
    const branch = branchOf(run)
    const res = await this.d.sandbox.exec(sandbox, [
      'sh',
      '-c',
      script,
      'sh',
      REPO_MOUNT,
      workdir,
      branch,
      run.baseSha || 'HEAD',
    ])
    if (res.exitCode !== 0) throw new Error(`workspace setup failed: ${res.stderrTail.trim()}`)
  }

  private limits(def: AgentDef) {
    const w = this.d.config.limits.worker
    return {
      steps: w.steps,
      wallClockMs: parseDuration(w.wall_clock),
      tokens: parseTokens(w.tokens),
      graceTurns: def.graceTurns,
    }
  }

  private watch(
    run: Run,
    session: WorkerSession,
    sandbox: SandboxHandle,
    workdir: string,
    def: AgentDef,
    startedAt: number,
  ): void {
    this.active.get(run.id)?.input.close()
    const limits = this.limits(def)
    const a: Active = {
      run,
      session,
      sandbox,
      workdir,
      watcher: new Watcher(limits, this.thresholds, startedAt),
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
      const now = this.now()
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
      await this.cb().workerFinished(a.run.id, e.payload)
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
        const lines = await this.diffLines(a)
        if (lines !== undefined) a.watcher.diff(lines)
        await this.cb().workerProgress?.(a.run.id, a.watcher.progress())
      } else if (action.kind === 'stall') {
        await this.cb().workerStalled(a.run.id, action.signal, action.detail)
      } else {
        a.cap = { reason: action.reason, at: this.now() }
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

  private async diffLines(a: Active): Promise<number | undefined> {
    const script = [
      'i=$(mktemp)',
      'trap \'rm -f "$i"\' EXIT',
      'GIT_INDEX_FILE="$i" git read-tree HEAD',
      'GIT_INDEX_FILE="$i" git add -A',
      'GIT_INDEX_FILE="$i" git diff --cached --numstat "$1"',
    ].join(' && ')
    const res = await this.d.sandbox
      .exec(a.sandbox, ['sh', '-c', script, 'sh', a.run.baseSha || 'HEAD'], {
        cwd: a.workdir,
        timeoutMs: 30_000,
      })
      .catch(() => undefined)
    if (res?.exitCode !== 0) return undefined
    return res.stdoutTail
      .split('\n')
      .map((l) => l.split('\t'))
      .reduce((sum, [add, del]) => sum + (Number(add) || 0) + (Number(del) || 0), 0)
  }

  private async fail(a: Active, reason: string, detail?: string): Promise<void> {
    if (a.done) return
    this.end(a)
    await this.d.worker.stop(a.session, reason).catch(() => undefined)
    await this.cb().workerFailed(a.run.id, reason, detail)
  }

  private end(a: Active): void {
    a.done = true
    a.input.close()
    if (this.active.get(a.run.id) === a) this.active.delete(a.run.id)
  }

  private cb(): WorkerCallbacks {
    if (this.detached) return DETACHED
    if (!this.callbacks) throw new Error('WorkerExecutor: bind() the supervisor before starting runs')
    return this.callbacks
  }
}

function opencodeConfig(
  plugin: OpenCodePluginEntry | undefined,
  lsp: WorkerImage['lsp'],
  skills = false,
): Record<string, unknown> {
  return {
    plugins: plugin ? [plugin] : [],
    ...(Object.keys(lsp).length > 0 ? { lsp } : {}),
    ...(skills ? { skills: { paths: [`${OPENCODE_CONFIG_DIR}/skills`] } } : {}),
  }
}
