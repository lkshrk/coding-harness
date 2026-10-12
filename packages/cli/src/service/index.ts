import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type Config,
  expandHome,
  formatError,
  type LoadResult,
  loadConfig,
  NIGHTSHIFT_ROOT,
} from '@nightshift/core'
import { acquireLock, statePath } from '@nightshift/supervisor'
import { LAUNCHD_LEAD_LABEL, LaunchdAgent } from './launchd'
import {
  type Runner,
  ServiceError,
  type ServiceFiles,
  type ServiceManager,
  type ServiceSpec,
} from './manager'
import { SYSTEMD_LEAD_UNIT, SystemdUserService } from './systemd'

export { LAUNCHD_LABEL, LAUNCHD_LEAD_LABEL, LaunchdAgent, launchdPlist } from './launchd'
export type { ServiceManager, ServiceSpec, ServiceState } from './manager'
export { SYSTEMD_LEAD_UNIT, SYSTEMD_UNIT, SystemdUserService, systemdUnit } from './systemd'

type Io = { out: (line: string) => void; err: (line: string) => void }

export type ServiceRole = 'supervisor' | 'lead'

export type ServiceDeps = {
  load?: () => LoadResult
  service?: (role: ServiceRole) => ServiceManager
  lockHolder?: (dbPath: string) => string | null
  bun?: string
  rbw?: string | null
  env?: Record<string, string | undefined>
}

const PASS_THROUGH = ['PATH', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'NODE_EXTRA_CA_CERTS']

const spawnRunner: Runner = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

const diskFiles: ServiceFiles = {
  exists: existsSync,
  write: (path, content) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  },
  remove: (path) => rmSync(path, { force: true }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
}

export function hostService(
  env: Record<string, string | undefined> = process.env,
  role: ServiceRole = 'supervisor',
): ServiceManager {
  const home = homedir()
  const lead = role === 'lead'
  if (process.platform === 'darwin')
    return new LaunchdAgent({
      home,
      uid: process.getuid?.() ?? 0,
      run: spawnRunner,
      files: diskFiles,
      ...(lead ? { label: LAUNCHD_LEAD_LABEL } : {}),
    })
  return new SystemdUserService({
    home,
    user: userInfo().username,
    run: spawnRunner,
    files: diskFiles,
    ...(env.XDG_CONFIG_HOME ? { configHome: env.XDG_CONFIG_HOME } : {}),
    ...(lead ? { unit: SYSTEMD_LEAD_UNIT } : {}),
  })
}

function lockHolder(dbPath: string): string | null {
  if (!existsSync(dirname(dbPath))) return null
  try {
    acquireLock(dbPath)()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

// The supervisor waits the handoff grace and then for gate steps before it exits.
const STOP_MARGIN_SEC = 60

export function serviceSpec(
  config: Config,
  o: { bun: string; env: Record<string, string | undefined>; rbw?: string | null },
): ServiceSpec {
  const home = o.env.HOME ?? homedir()
  const env: Record<string, string> = {}
  for (const key of PASS_THROUGH) {
    const v = o.env[key]
    if (v) env[key] = v
  }
  env.RBW_PROFILE = config.secrets.rbw_profile
  if (config.gateway.ca_bundle) env.NODE_EXTRA_CA_CERTS = expandHome(config.gateway.ca_bundle, home)
  return {
    bun: o.bun,
    main: join(NIGHTSHIFT_ROOT, 'packages/cli/src/main.ts'),
    workdir: NIGHTSHIFT_ROOT,
    env,
    logFile: join(expandHome(config.paths.state, home), 'supervisor.log'),
    ...(o.rbw ? { rbw: o.rbw } : {}),
    stopTimeoutSec: config.limits.handoff_grace_seconds + STOP_MARGIN_SEC,
  }
}

export function leadServiceSpec(
  config: Config,
  o: { bun: string; env: Record<string, string | undefined>; rbw?: string | null },
): ServiceSpec {
  const { stopTimeoutSec: _, ...spec } = serviceSpec(config, o)
  return {
    ...spec,
    args: ['lead', 'serve'],
    description: 'nightshift lead',
    logFile: join(dirname(spec.logFile), 'lead.log'),
  }
}

function loaded(deps: ServiceDeps, io: Io): Config | null {
  const result = (deps.load ?? (() => loadConfig()))()
  if (result.ok) return result.config
  for (const e of result.errors) io.err(`config: ${formatError(e)}`)
  return null
}

function hint(manager: ServiceManager): string {
  return manager.kind === 'systemd'
    ? 'the systemd user manager must run (WSL: [boot] systemd=true in /etc/wsl.conf, then wsl --shutdown)'
    : 'check launchctl print gui/$(id -u)'
}

function managers(deps: ServiceDeps, env: Record<string, string | undefined>) {
  const make = deps.service ?? ((role: ServiceRole) => hostService(env, role))
  return [
    { name: 'nightshift', manager: make('supervisor'), spec: serviceSpec },
    { name: 'nightshift lead', manager: make('lead'), spec: leadServiceSpec },
  ]
}

export async function up(deps: ServiceDeps, io: Io): Promise<number> {
  const config = loaded(deps, io)
  if (!config) return 1
  const env = deps.env ?? process.env
  const services = managers(deps, env)
  const [supervisor] = services
  let started = false
  try {
    for (const { name, manager, spec } of services) {
      if ((await manager.status()) === 'running') {
        io.out(`${name} is already running (${manager.kind}: ${manager.path})`)
        continue
      }
      if (manager === supervisor?.manager) {
        const holder = (deps.lockHolder ?? lockHolder)(statePath(config, env.HOME ?? homedir()))
        if (holder) {
          io.err(holder)
          return 1
        }
      }
      const rbw = deps.rbw !== undefined ? deps.rbw : Bun.which('rbw', env.PATH ? { PATH: env.PATH } : {})
      if (manager.installed()) await manager.stop()
      await manager.install(spec(config, { bun: deps.bun ?? process.execPath, env, rbw }))
      await manager.start()
      started = true
      io.out(`${name} installed and started (${manager.kind}: ${manager.path})`)
    }
    const systemd = services.find((s) => s.manager instanceof SystemdUserService)?.manager
    if (started && systemd instanceof SystemdUserService && !(await systemd.enableLinger()))
      io.err(
        `warning: lingering is off; enable it so the service runs without a login: sudo loginctl enable-linger ${userInfo().username}`,
      )
    if (started) for (const { name, manager } of services) io.out(`${name}: ${await manager.status()}`)
    return 0
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e
    io.err(e.message)
    if (supervisor) io.err(`fix: ${hint(supervisor.manager)}`)
    return 1
  }
}

export async function down(deps: ServiceDeps, io: Io): Promise<number> {
  const env = deps.env ?? process.env
  const installed = managers(deps, env).filter((s) => s.manager.installed())
  if (installed.length === 0) {
    io.out('nightshift service is not installed')
    return 0
  }
  try {
    for (const { name, manager } of installed) {
      await manager.stop()
      await manager.uninstall()
      io.out(`${name} stopped and removed (${manager.kind}: ${manager.path})`)
    }
    return 0
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e
    io.err(e.message)
    return 1
  }
}
