import { accessSync, constants, existsSync, readFileSync, statfsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NIGHTSHIFT_ROOT } from '../config/loader'
import type { Config } from '../config/schema'
import { secretRefs } from '../config/secret-refs'
import { expandHome } from '../config/semantic'
import type { CommandResult } from '../secrets'

export type CheckResult = { name: string; ok: boolean; detail: string; fix?: string; warning?: boolean }

export type HostCheckDeps = {
  run: (cmd: string[], env?: Record<string, string>) => Promise<CommandResult | null>
  fetch: (url: string, init: RequestInit & { tls?: { ca?: string } }) => Promise<Response>
  freeBytes: (path: string) => number | null
  imagePresent: (repository: string) => Promise<boolean>
  home: string
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  kvm: () => boolean
}

export const MIN_FREE_BYTES = 20 * 1024 ** 3
const OPENCODE_MAJOR = 2
const GATEWAY_TIMEOUT_MS = 10_000

const first = (text: string) => text.trim().split('\n')[0] ?? ''

async function docker(d: HostCheckDeps): Promise<CheckResult> {
  const res = await d.run(['docker', 'info', '--format', '{{.ServerVersion}}'])
  if (!res) return { name: 'docker', ok: false, detail: 'not installed', fix: 'install Docker Engine' }
  if (res.exitCode !== 0)
    return {
      name: 'docker',
      ok: false,
      detail: 'not running',
      fix:
        d.platform === 'darwin'
          ? 'start Docker Desktop (or OrbStack)'
          : 'start the Docker daemon: sudo systemctl start docker',
    }
  return { name: 'docker', ok: true, detail: `server ${first(res.stdout)}` }
}

async function sbx(d: HostCheckDeps): Promise<CheckResult[]> {
  const version = await d.run(['sbx', 'version'])
  if (version?.exitCode !== 0)
    return [{ name: 'sbx', ok: false, detail: 'not installed', fix: 'install Docker Sandboxes (sbx)' }]
  const results: CheckResult[] = []
  const ls = await d.run(['sbx', 'ls'])
  results.push(
    ls?.exitCode === 0
      ? { name: 'sbx', ok: true, detail: first(version.stdout) }
      : {
          name: 'sbx',
          ok: false,
          detail: 'not logged in or daemon down',
          fix: 'run sbx login, then sbx diagnose',
        },
  )
  if (d.platform === 'linux' && !d.kvm())
    results.push({
      name: 'sbx virtualization',
      ok: false,
      detail: '/dev/kvm is not accessible',
      fix: 'enable nested virtualization (WSL: nestedVirtualization=true in .wslconfig) and add yourself to the kvm group',
    })
  return results
}

async function rbw(config: Config, d: HostCheckDeps): Promise<CheckResult | null> {
  if (!secretRefs(config).some((r) => r.ref.startsWith('rbw:'))) return null
  const profile = config.secrets.rbw_profile
  const env: Record<string, string> = { RBW_PROFILE: profile }
  for (const key of ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) {
    const v = d.env[key]
    if (v) env[key] = v
  }
  const res = await d.run(['rbw', 'unlocked'], env)
  if (!res) return { name: 'rbw', ok: false, detail: 'not installed', fix: 'install rbw' }
  if (res.exitCode !== 0)
    return {
      name: 'rbw',
      ok: false,
      detail: `profile ${profile} is locked`,
      fix: `run RBW_PROFILE=${profile} rbw unlock`,
    }
  return { name: 'rbw', ok: true, detail: `profile ${profile} unlocked` }
}

const PINENTRY = 'rbw-pinentry-creds'

async function rbwAutoUnlock(config: Config, d: HostCheckDeps): Promise<CheckResult | null> {
  if (d.platform !== 'linux' || !secretRefs(config).some((r) => r.ref.startsWith('rbw:'))) return null
  const profile = config.secrets.rbw_profile
  const env: Record<string, string> = { RBW_PROFILE: profile }
  for (const key of ['HOME', 'PATH', 'XDG_CONFIG_HOME']) {
    const v = d.env[key]
    if (v) env[key] = v
  }
  const cred = join(d.env.XDG_CONFIG_HOME || join(d.home, '.config'), 'nightshift/rbw.cred')
  const setup = `systemd-creds encrypt --user --name=rbw - ${cred}; RBW_PROFILE=${profile} rbw config set pinentry ${join(NIGHTSHIFT_ROOT, 'scripts', PINENTRY)}`
  const res = await d.run(['rbw', 'config', 'show'], env)
  if (res?.exitCode !== 0) return null
  let pinentry = ''
  try {
    pinentry = String((JSON.parse(res.stdout) as { pinentry?: unknown }).pinentry ?? '')
  } catch {
    return null
  }
  if (!pinentry.endsWith(PINENTRY))
    return {
      name: 'rbw auto-unlock',
      ok: false,
      warning: true,
      detail: `pinentry is ${pinentry || 'unset'}; the service cannot unlock after a reboot`,
      fix: setup,
    }
  if (!existsSync(cred))
    return { name: 'rbw auto-unlock', ok: false, warning: true, detail: `${cred} is missing`, fix: setup }
  return { name: 'rbw auto-unlock', ok: true, detail: `${PINENTRY} with ${cred}` }
}

async function opencode(d: HostCheckDeps): Promise<CheckResult> {
  const res = await d.run(['opencode', '--version'])
  if (res?.exitCode !== 0)
    return { name: 'opencode', ok: false, detail: 'not installed', fix: 'install OpenCode v2' }
  const version = /(\d+)\.\d+\.\d+/.exec(res.stdout)
  const major = version ? Number(version[1]) : Number.NaN
  if (major !== OPENCODE_MAJOR)
    return {
      name: 'opencode',
      ok: false,
      detail: `major version ${OPENCODE_MAJOR} required (found ${version?.[0] ?? first(res.stdout)})`,
      fix: 'install OpenCode v2 (opencode upgrade)',
    }
  return { name: 'opencode', ok: true, detail: version?.[0] ?? '' }
}

async function gateway(config: Config, d: HostCheckDeps): Promise<CheckResult> {
  const url = new URL(config.gateway.base_url)
  const bundle = config.gateway.ca_bundle ? expandHome(config.gateway.ca_bundle, d.home) : undefined
  if (bundle && !existsSync(bundle))
    return {
      name: 'gateway',
      ok: false,
      detail: `ca_bundle ${bundle} not found`,
      fix: 'point gateway.ca_bundle at the PEM file of the CA that signed the gateway',
    }
  try {
    const res = await d.fetch(url.origin, {
      method: 'HEAD',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      ...(bundle ? { tls: { ca: readFileSync(bundle, 'utf8') } } : {}),
    })
    return { name: 'gateway', ok: true, detail: `${url.origin} reachable (HTTP ${res.status})` }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const tls = /certificate|self[- ]signed|issuer|CERT|SSL|TLS/i.test(message)
    return {
      name: 'gateway',
      ok: false,
      detail: `${url.origin}: ${tls ? 'TLS certificate not trusted' : 'unreachable'} (${message})`,
      fix: tls
        ? 'set gateway.ca_bundle to the PEM of the CA that signed the gateway'
        : `check the network path to ${url.host}`,
    }
  }
}

function disk(config: Config, d: HostCheckDeps): CheckResult[] {
  const results: CheckResult[] = []
  for (const [key, raw] of [
    ['state', config.paths.state],
    ['cache', config.paths.cache],
  ] as const) {
    let path = expandHome(raw, d.home)
    while (!existsSync(path) && dirname(path) !== path) path = dirname(path)
    const free = d.freeBytes(path)
    const gb = free === null ? null : Math.floor(free / 1024 ** 3)
    results.push(
      free === null
        ? { name: `disk ${key}`, ok: false, warning: true, detail: `cannot read free space of ${path}` }
        : free < MIN_FREE_BYTES
          ? {
              name: `disk ${key}`,
              ok: false,
              warning: true,
              detail: `${gb} GB free under ${path}`,
              fix: 'free space (docker system prune, old images) below 20 GB',
            }
          : { name: `disk ${key}`, ok: true, detail: `${gb} GB free under ${path}` },
    )
  }
  return results
}

async function images(config: Config, d: HostCheckDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const repository of Object.keys(config.repositories)) {
    let present = false
    let detail = 'not built for the current base'
    try {
      present = await d.imagePresent(repository)
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e)
    }
    results.push(
      present
        ? { name: `image ${repository}`, ok: true, detail: 'present' }
        : {
            name: `image ${repository}`,
            ok: false,
            warning: true,
            detail,
            fix: `ns env build ${repository} (otherwise built on first dispatch)`,
          },
    )
  }
  return results
}

export async function hostChecks(config: Config, d: HostCheckDeps): Promise<CheckResult[]> {
  const docked = await docker(d)
  const [sandbox, vault, unlock, oc, gw, imgs] = await Promise.all([
    config.sandbox.driver === 'sbx' ? sbx(d) : Promise.resolve([]),
    rbw(config, d),
    rbwAutoUnlock(config, d),
    opencode(d),
    gateway(config, d),
    docked.ok ? images(config, d) : Promise.resolve([]),
  ])
  return [
    docked,
    ...sandbox,
    ...(vault ? [vault] : []),
    ...(unlock ? [unlock] : []),
    oc,
    gw,
    ...disk(config, d),
    ...imgs,
  ]
}

export async function spawnCheck(cmd: string[], env?: Record<string, string>): Promise<CommandResult | null> {
  if (!Bun.which(cmd[0] ?? '', env?.PATH ? { PATH: env.PATH } : {})) return null
  const proc = Bun.spawn(cmd, {
    ...(env ? { env } : {}),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

export function statfsFree(path: string): number | null {
  try {
    const s = statfsSync(path)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

export function kvmAccessible(): boolean {
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
}
