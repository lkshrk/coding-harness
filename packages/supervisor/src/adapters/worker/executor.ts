import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentDef,
  type Config,
  expandHome,
  renderAgent,
  renderContext,
  renderFinishPlugin,
  type WorkerImage,
} from '@nightshift/core'
import { branchOf, parseDuration, parseTokens, workdirOf } from '../../policy/naming'
import type {
  BuiltContext,
  ExecutorStart,
  Ms,
  RunExecutor,
  SandboxDriver,
  SandboxHandle,
  WorkerDriver,
  WorkerSession,
} from '../../ports'
import type { TaskMessage } from '../../ports/context'
import { importBundle } from '../git/host'

export { branchOf, parseDuration, parseTokens, workdirOf } from '../../policy/naming'

import type { Run } from '../../state/runs'
import { INDEX_MOUNT } from '../codegraph'
import { memoryMb } from './docker'
import { OPENCODE_CONFIG_DIR } from './opencode'
import { type RunLimits, RunWatch, type WorkerCallbacks } from './run-watch'
import { WATCH_DEFAULTS, type WatchThresholds } from './watch'
import {
  agentConfig,
  continueFrom,
  copySources,
  GRAPH_CACHE,
  linkIndex,
  pinnedRepo,
  prepareWorkspace,
  REPO_MOUNT,
  shellJoin,
} from './workspace'

export { failureReason, GRACE_MESSAGE, type WorkerCallbacks } from './run-watch'
export { REPO_MOUNT, shellJoin } from './workspace'

export const CA_MOUNT = '/etc/nightshift/ca.pem'
export const KNOWLEDGE_SOURCE = '/mnt/knowledge-source.git'
export const KNOWLEDGE_REPOS = '/tmp/knowledge-repos'

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
  wipCommitted: dropped('wip commit'),
}

export class WorkerExecutor implements RunExecutor {
  private readonly runs: RunWatch
  private readonly now: () => number
  private callbacks: WorkerCallbacks | undefined
  private detached = false

  constructor(private readonly d: WorkerExecutorDeps) {
    this.now = d.now ?? Date.now
    this.runs = new RunWatch({
      sandbox: d.sandbox,
      worker: d.worker,
      thresholds: { ...WATCH_DEFAULTS, ...d.thresholds },
      ...(d.graceMs !== undefined ? { graceMs: d.graceMs } : {}),
      ...(d.tickMs !== undefined ? { tickMs: d.tickMs } : {}),
      now: this.now,
      callbacks: () => this.cb(),
    })
  }

  bind(callbacks: WorkerCallbacks): void {
    this.callbacks = callbacks
    this.detached = false
  }

  detach(): void {
    this.callbacks = undefined
    this.detached = true
  }

  async start({ run, issue, files, sourceFiles, repairFrom, knowledgeRepo }: ExecutorStart): Promise<void> {
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
    const known = knowledgeRepo ? this.d.config.repositories[knowledgeRepo] : undefined
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
        ...(known
          ? [
              {
                hostPath: join(expandHome(known.path, home), '.git'),
                guestPath: KNOWLEDGE_SOURCE,
                readOnly: true as const,
              },
            ]
          : []),
      ],
      env: {
        ...(index ? { CBM_CACHE_DIR: GRAPH_CACHE, NS_GRAPH_PROJECT: run.repository } : {}),
        ...(known ? { KNOWLEDGE_REPOS } : {}),
      },
      egress: { allow: [new URL(gateway.base_url).host, ...worker.egress] },
      workdir: '/work',
      labels: { nightshift: '1', run: run.id, issue: run.issue },
    })
    await this.cb().sandboxCreated?.(run.id, { driver: sandbox.driver, id: sandbox.id, image })
    let session: WorkerSession
    try {
      await prepareWorkspace(this.d.sandbox, sandbox, workdir, run)
      await copySources(this.d.sandbox, sandbox, workdir, sourceFiles)
      if (repairFrom) await continueFrom(this.d.sandbox, sandbox, workdir, run, repairFrom)
      if (index) await linkIndex(this.d.sandbox, sandbox, run)
      if (known && knowledgeRepo)
        await pinnedRepo(
          this.d.sandbox,
          sandbox,
          KNOWLEDGE_SOURCE,
          `${KNOWLEDGE_REPOS}/${knowledgeRepo}`,
          known,
        )
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
              content: JSON.stringify(agentConfig(plugin?.plugin, worker.lsp, skills.length > 0)),
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
    this.runs.watch(run, session, sandbox, workdir, this.limits(def), this.now())
  }

  async reattach(run: Run): Promise<void> {
    if (run.session === null || run.sandbox === null) throw new Error(`run ${run.id} has no session`)
    const def = this.d.agents.get(run.agent)
    if (!def) throw new Error(`no agent '${run.agent}'`)
    const sandbox: SandboxHandle = { driver: this.d.config.sandbox.driver, id: run.sandbox, name: run.id }
    this.runs.watch(
      run,
      { id: run.session, attach: [] },
      sandbox,
      workdirOf(run),
      this.limits(def),
      Date.parse(run.startedAt),
    )
  }

  runStep(run: Run): Promise<void> {
    return this.d.runStep(run)
  }

  async nudge(run: Run, message: string): Promise<void> {
    if (run.session === null) return
    await this.d.worker.send({ id: run.session, attach: [] }, message)
  }

  async stop(run: Run, reason: string): Promise<void> {
    const active = this.runs.session(run.id)
    this.runs.forget(run.id)
    const session = active?.id ?? run.session
    if (session !== null) await this.d.worker.stop({ id: session, attach: [] }, reason)
  }

  async captureHead(run: Run, status?: string): Promise<string | undefined> {
    if (run.sandbox === null) return undefined
    const repo = this.d.config.repositories[run.repository]
    if (!repo) return undefined
    const handle: SandboxHandle = { driver: this.d.config.sandbox.driver, id: run.sandbox, name: run.id }
    const wip = status === undefined ? undefined : await this.commitWip(handle, run, status)
    const exported = await this.d.sandbox.exportCommits(handle, workdirOf(run), branchOf(run))
    if (run.baseSha && exported.headSha === run.baseSha) return undefined
    const checkout = expandHome(repo.path, this.d.home ?? homedir())
    const head = importBundle(checkout, exported.bundle, branchOf(run), run.id)
    if (head !== exported.headSha)
      throw new Error(`imported ${head} but the worker reported ${exported.headSha}`)
    if (wip !== undefined && this.callbacks) await this.cb().wipCommitted?.(run.id, { sha: head, lines: wip })
    return head
  }

  private async commitWip(handle: SandboxHandle, run: Run, status: string): Promise<number | undefined> {
    const script = [
      'test -n "$(git status --porcelain)" || exit 0',
      'git add -A && git commit --quiet --no-verify -m "$1" && echo committed && git diff --numstat HEAD^ HEAD',
    ].join('\n')
    const message = `wip: ${run.issue} attempt ${run.attempt} (${status})`
    const res = await this.d.sandbox.exec(handle, ['sh', '-c', script, 'sh', message], {
      cwd: workdirOf(run),
      timeoutMs: 60_000,
    })
    if (res.exitCode !== 0) {
      console.error(`${run.issue}: wip commit of run ${run.id} failed: ${res.stderrTail.trim()}`)
      return undefined
    }
    const [first, ...rest] = res.stdoutTail.trim().split('\n')
    if (first !== 'committed') return undefined
    return rest
      .map((l) => l.split('\t'))
      .reduce((sum, [add, del]) => sum + (Number(add) || 0) + (Number(del) || 0), 0)
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

  private limits(def: AgentDef): RunLimits {
    const w = this.d.config.limits.worker
    return {
      steps: w.steps,
      wallClockMs: parseDuration(w.wall_clock),
      tokens: parseTokens(w.tokens),
      graceTurns: def.graceTurns,
    }
  }

  private cb(): WorkerCallbacks {
    if (this.detached) return DETACHED
    if (!this.callbacks) throw new Error('WorkerExecutor: bind() the supervisor before starting runs')
    return this.callbacks
  }
}
