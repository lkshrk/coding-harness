import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import {
  buildFinishPlugin,
  type Config,
  countTokens,
  createTokenProvider,
  DevcontainerEnvironmentBuilder,
  expandHome,
  GatewayError,
  loadAgents,
  parseAgent,
  runSingleCall,
  SecretResolver,
  secretRefs,
  type WorkerImage,
  withCredentials,
  workerImageFor,
} from '@nightshift/core'
import { agentClassifier } from '../adapters/classifier/classifier'
import { CodeGraphIndex } from '../adapters/codegraph'
import { sqliteCodeGraph } from '../adapters/codegraph/query'
import { GhGitHost } from '../adapters/github/gh'
import { GitHubTokens, gitAuthEnv, githubOwner } from '../adapters/github/github-tokens'
import { createLinearPort } from '../adapters/linear/linear-adapter'
import { type SignalInbox, signalApi, signalChannel } from '../adapters/signal'
import {
  type DockerCli,
  DockerSandbox,
  dockerCli,
  fileSessionStore,
  memoryMb,
  OPENCODE_PORT,
  OpenCodeDriver,
  WorkerExecutor,
} from '../adapters/worker'
import type {
  GateRunner,
  GitHost,
  LinearPort,
  Notifier,
  OutboxDirs,
  RepoInspector,
  SandboxDriver,
  WorkerDriver,
} from '../ports'
import type { AttachInfo } from '../ports/generated/control'
import {
  contextSelector,
  contextTaskMessage,
  FencedContextBuilder,
  gitObjectSource,
  type TokenCounter,
} from '../stages/context'
import { ingestConfig, ingestRuntime, ingestTaskMessage } from '../stages/context/ingest-runtime'
import { vaultSync } from '../stages/context/vault'
import { gateStep, reviewStep, SandboxGateRunner, type SingleCall } from '../stages/gates'
import { IntegrationHandler } from '../stages/integration'
import { acquireLock, type Db, openState, statePath } from '../state/db'
import type { Run } from '../state/runs'
import { Supervisor } from '../supervisor/supervisor'
import { agentResolver } from './loop'

export function gitRepos(
  config: () => Config,
  auth: (repository: string) => Promise<Record<string, string>> = async () => ({}),
): RepoInspector {
  return {
    async baseSha(repository) {
      const repo = config().repositories[repository]
      if (!repo) throw new Error(`no repository '${repository}'`)
      const cwd = expandHome(repo.path, homedir())
      const env = { ...process.env, ...(await auth(repository)) }
      const git = (...args: string[]) => {
        const r = Bun.spawnSync(['git', ...args], {
          cwd,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        })
        if (r.exitCode !== 0)
          throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr.toString().trim()}`)
        return r.stdout.toString().trim()
      }
      git('fetch', '--quiet', repo.remote, repo.base)
      return git('rev-parse', `${repo.remote}/${repo.base}`)
    },
  }
}

export function outboxDirs(dir: string): OutboxDirs {
  return {
    list: () => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        return []
      }
    },
    remove: (run) => rmSync(join(dir, run), { recursive: true, force: true }),
  }
}

export function logNotifier(out: (line: string) => void): Notifier {
  return {
    async notify({ title, issue }) {
      out(`notify: ${title}${issue ? ` (${issue})` : ''}`)
      return null
    },
  }
}

export function skillFiles(dir: string): { path: string; content: string }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort()
    .map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') }))
}

// Interactive agents' skills ship outside this repository's skills/ directory.
export function hostSkills(agentsDir: string): string[] {
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .flatMap((f) => {
      const { def } = parseAgent(f, readFileSync(join(agentsDir, f), 'utf8'))
      return def?.kind === 'interactive' ? def.skills : []
    })
}

export type ComposeOptions = {
  config: Config
  root: string
  env?: Record<string, string | undefined>
  out?: (line: string) => void
  linear?: LinearPort
  docker?: DockerCli
  sandbox?: SandboxDriver
  gates?: GateRunner
  worker?: WorkerDriver
  finishPlugin?: string
  countTokens?: TokenCounter
  singleCall?: SingleCall
  gitHost?: GitHost
  images?: (repository: string) => Promise<WorkerImage>
  gitAuth?: (repository: string) => Promise<Record<string, string>>
  signalFetch?: typeof fetch
}

export type Composed = {
  supervisor: Supervisor
  db: Db
  attach: (run: Run) => AttachInfo | undefined
  signal?: SignalInbox
  close: () => void
}

export function gatewaySingleCall(
  call: SingleCall,
  reachable: (ok: boolean, reason: string) => void,
): SingleCall {
  return async <T>(...args: Parameters<SingleCall>) => {
    try {
      const result = await call<T>(...args)
      if (!result.ok && result.reason === 'gateway_error') reachable(false, result.detail)
      else if (result.ok || result.reason === 'invalid_output' || result.trace?.inputTokens !== undefined)
        reachable(true, `${args[0].name} gateway call succeeded`)
      return result
    } catch (e) {
      if (e instanceof GatewayError) reachable(false, e.message)
      throw e
    }
  }
}

export async function composeSupervisor(o: ComposeOptions): Promise<Composed> {
  const out = o.out ?? ((line: string) => console.error(line))
  const home = homedir()
  const { config } = o
  const state = expandHome(config.paths.state, home)
  const cache = expandHome(config.paths.cache, home)
  mkdirSync(state, { recursive: true })
  const dbPath = statePath(config, home)
  const release = acquireLock(dbPath)
  const db = openState(dbPath)
  const secrets = new SecretResolver({
    env: withCredentials(o.env ?? process.env),
    rbwProfile: config.secrets.rbw_profile,
  })
  const usesRbw = secretRefs(config).some((r) => r.ref.startsWith('rbw:'))

  const agentsDir = join(o.root, 'agents')
  const { agents, errors } = loadAgents(agentsDir, {
    profiles: config.profiles,
    externalSkills: [...hostSkills(agentsDir), 'wiki-ingest'],
  })
  for (const e of errors) out(`agents: ${e.file}: ${e.path}: ${e.message}`)

  let supervisor: Supervisor | undefined
  const current = () => supervisor?.config ?? config
  const workerConfig = () => ingestConfig(current())
  const linear =
    o.linear ??
    createLinearPort({
      config: current,
      auth: createTokenProvider(config.linear.auth, (ref) => secrets.resolve(ref)),
    })
  const sandbox =
    o.sandbox ??
    new DockerSandbox({
      ...(o.docker ? { cli: o.docker } : {}),
      publish: [OPENCODE_PORT],
      artifactsDir: join(cache, 'artifacts'),
    })
  const artifacts = join(state, 'artifacts')
  const gates =
    o.gates ??
    new SandboxGateRunner({
      sandbox:
        o.sandbox ?? new DockerSandbox({ ...(o.docker ? { cli: o.docker } : {}), artifactsDir: artifacts }),
      outbox: join(cache, 'outbox'),
      artifacts,
      resources: {
        cpus: config.sandbox.resources.cpus ?? 4,
        memoryMb: memoryMb(config.sandbox.resources.memory),
      },
    })
  const hostGateway = async () => {
    const gw = current().gateway
    return { baseUrl: gw.base_url, apiKey: await secrets.resolve(gw.api_key) }
  }
  const reachable = (ok: boolean, reason: string) => supervisor?.gatewayReachable(ok, reason)
  const singleCall = gatewaySingleCall(o.singleCall ?? runSingleCall, reachable)
  const gatewayCounter: TokenCounter = async (text, model) => {
    try {
      const tokens = await countTokens(await hostGateway(), model, text, 'context')
      reachable(true, 'token counter succeeded')
      return tokens
    } catch (e) {
      if (e instanceof GatewayError) reachable(false, e.message)
      throw e
    }
  }
  const environments = new DevcontainerEnvironmentBuilder({ config: workerConfig, root: o.root, home })
  const images = o.images ?? ((repository: string) => workerImageFor(environments, repository, { log: out }))
  const graphs = new CodeGraphIndex({
    root: join(cache, 'index'),
    docker: o.docker ?? dockerCli(),
    image: async (repository) => (await images(repository)).image,
    ...(process.getuid && process.getgid ? { user: `${process.getuid()}:${process.getgid()}` } : {}),
  })
  const codeGraph = async (run: Run): Promise<string | undefined> => {
    const repo = current().repositories[run.repository]
    if (!repo || !run.baseSha) return undefined
    const dir = await graphs.ensure(run.repository, expandHome(repo.path, home), run.baseSha)
    const inUse = (supervisor?.runs.active() ?? []).filter((r) => r.repository === run.repository)
    graphs.prune(run.repository, [run.baseSha, ...inUse.map((r) => r.baseSha)])
    return dir
  }
  const callbacks = () => {
    if (!supervisor) throw new Error('gate step ran before the supervisor was composed')
    return supervisor
  }
  const opencode = o.worker
    ? undefined
    : new OpenCodeDriver({ sandbox, sessions: fileSessionStore(join(state, 'sessions')) })
  const worker = o.worker ?? (opencode as OpenCodeDriver)
  const executor = new WorkerExecutor({
    config: workerConfig(),
    sandbox,
    worker,
    agents,
    finishPlugin: o.finishPlugin ?? (await buildFinishPlugin()),
    skillFiles: (skill) =>
      skillFiles(
        skill === 'wiki-ingest'
          ? join(expandHome(current().paths.vault, home), '.skills', skill)
          : join(o.root, 'skills', skill),
      ),
    ...(o.sandbox ? {} : { codeGraph }),
    image: (run) => images(run.repository),
    taskMessage: (start, budget) =>
      start.run.agent === 'ingester'
        ? Promise.resolve(ingestTaskMessage(start.files))
        : contextTaskMessage({
            config: current,
            db,
            linear,
            builder: new FencedContextBuilder({
              count: o.countTokens ?? gatewayCounter,
              source: gitObjectSource,
              graph: (repo) => (repo.indexPath ? sqliteCodeGraph(repo.indexPath, repo.name) : undefined),
              rank: contextSelector({
                config: current,
                agents,
                gateway: hostGateway,
                cacheDir: join(cache, 'selector'),
                call: singleCall,
                out,
              }),
            }),
            ...(o.sandbox
              ? {}
              : {
                  syncVault: vaultSync({
                    dir: expandHome(config.paths.vault, home),
                    token: (owner) => githubTokens.ownerToken(owner),
                    authEnv: gitAuthEnv,
                    owner: githubOwner,
                    out,
                  }),
                }),
          })(start, budget),
    gatewayKey: async () => secrets.resolve(current().gateway.worker_key),
    runStep: gateStep({
      config: current,
      image: async (repository) => (await images(repository)).image,
      sandbox,
      gates,
      artifacts,
      callbacks,
      review: reviewStep({
        config: current,
        agents,
        linear,
        artifacts,
        gateway: hostGateway,
        callbacks,
        call: singleCall,
      }),
      out,
    }),
  })

  const githubTokens = new GitHubTokens({ config: current, resolve: (ref) => secrets.resolve(ref), home })
  const gitHost =
    o.gitHost ??
    new GhGitHost({
      config: current,
      tokens: githubTokens,
      home,
    })

  const signalSettings = config.notifications.signal
  const signal = signalSettings
    ? signalChannel({
        settings: () => current().notifications.signal ?? signalSettings,
        api: signalApi(signalSettings, (ref) => secrets.resolve(ref), {
          home,
          ...(o.signalFetch ? { fetch: o.signalFetch } : {}),
        }),
        db,
        stateDir: state,
        fallback: logNotifier(out),
        actions: () => callbacks(),
        out,
      })
    : undefined

  supervisor = new Supervisor({
    config,
    db,
    linear,
    executor,
    sandbox,
    worker,
    repos: gitRepos(
      current,
      o.gitAuth ?? (async (repository) => gitAuthEnv(await githubTokens.token(repository))),
    ),
    notifier: signal?.notifier ?? logNotifier(out),
    outbox: outboxDirs(join(cache, 'outbox')),
    classifier: agentClassifier({
      config: current,
      agents,
      gateway: hostGateway,
      events: (run) => callbacks().log.since(null, { run }),
      call: singleCall,
      out,
    }),
    stageHandler: new IntegrationHandler({ config: current, host: gitHost, callbacks, home, out }),
    gitHost,
    ingest: ingestRuntime({
      dir: expandHome(config.paths.vault, home),
      token: (owner) => githubTokens.ownerToken(owner),
      authEnv: gitAuthEnv,
      owner: githubOwner,
      sandbox,
      driver: config.sandbox.driver,
      artifacts,
      out,
    }),
    ...(usesRbw ? { secretsLocked: () => secrets.locked() } : {}),
    ...agentResolver(agents),
  })
  executor.bind(supervisor)

  return {
    supervisor,
    db,
    attach: (run) => (run.session === null ? undefined : opencode?.attachInfo(run.session)),
    ...(signal ? { signal: signal.inbox } : {}),
    close: () => {
      executor.detach()
      db.close()
      release()
    },
  }
}
