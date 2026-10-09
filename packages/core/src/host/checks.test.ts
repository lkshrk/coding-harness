import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config/schema'
import type { CommandResult } from '../secrets'
import { type CheckResult, type HostCheckDeps, hostChecks, MIN_FREE_BYTES } from './checks'
import { credentialEnv, credentialNames, withCredentials } from './credentials'

type Answers = Record<string, CommandResult | null>

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr = ''): CommandResult => ({ exitCode: 1, stdout: '', stderr })

const HEALTHY: Answers = {
  'docker info': ok('29.1.3\n'),
  'sbx version': ok('sbx version: v0.46.0\n'),
  'sbx ls': ok(),
  'rbw unlocked': ok(),
  'opencode --version': ok('opencode v2.0.22\n'),
}

function deps(answers: Answers = {}, over: Partial<HostCheckDeps> = {}) {
  const calls: { cmd: string[]; env?: Record<string, string> }[] = []
  const all = { ...HEALTHY, ...answers }
  const d: HostCheckDeps = {
    run: async (cmd, env) => {
      calls.push({ cmd, ...(env ? { env } : {}) })
      const key = Object.keys(all).find((k) => cmd.join(' ').startsWith(k))
      return key === undefined ? null : (all[key] ?? null)
    },
    fetch: async () => new Response(null, { status: 401 }),
    freeBytes: () => 500 * 1024 ** 3,
    imagePresent: async () => true,
    home: '/home/dev',
    env: { HOME: '/home/dev', PATH: '/usr/bin' },
    platform: 'linux',
    kvm: () => true,
    ...over,
  }
  return { d, calls }
}

const config = (over: Record<string, unknown> = {}) =>
  ({
    paths: { state: '~/.local/state/nightshift', cache: '~/.cache/nightshift', vault: '~/Dev/vault' },
    gateway: { base_url: 'https://gw.example/v1', api_key: 'rbw:llm-gateway' },
    linear: { auth: { mode: 'api_key', api_key: 'env:LINEAR_KEY' } },
    github: { accounts: {} },
    repositories: { omni: { path: '~/Dev/omni' } },
    sandbox: { driver: 'docker' },
    secrets: { rbw_profile: 'nightshift' },
    ...over,
  }) as unknown as Config

const byName = (results: CheckResult[], name: string) => results.find((r) => r.name === name)
const failing = (results: CheckResult[]) => results.filter((r) => !r.ok && !r.warning).map((r) => r.name)

describe('hostChecks', () => {
  test('a healthy host passes every check', async () => {
    const results = await hostChecks(config(), deps().d)
    expect(failing(results)).toEqual([])
    expect(byName(results, 'opencode')?.detail).toBe('2.0.22')
  })

  test('docker stopped is reported with its fix', async () => {
    const results = await hostChecks(config(), deps({ 'docker info': fail('Cannot connect') }).d)
    expect(byName(results, 'docker')).toMatchObject({
      ok: false,
      detail: 'not running',
      fix: 'start the Docker daemon: sudo systemctl start docker',
    })
  })

  test('a locked rbw profile names the unlock command and probes with RBW_PROFILE', async () => {
    const { d, calls } = deps({ 'rbw unlocked': fail() })
    const results = await hostChecks(config(), d)
    expect(byName(results, 'rbw')).toMatchObject({
      ok: false,
      detail: 'profile nightshift is locked',
      fix: 'run RBW_PROFILE=nightshift rbw unlock',
    })
    expect(calls.find((c) => c.cmd[0] === 'rbw')?.env?.RBW_PROFILE).toBe('nightshift')
  })

  test('rbw auto-unlock warns until the creds pinentry and credential file exist', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ns-rbw-'))
    const env = { HOME: home, PATH: '/usr/bin' }
    const show = (pinentry: string) => ({ 'rbw config show': ok(JSON.stringify({ pinentry })) })
    const tty = await hostChecks(config(), deps(show('pinentry-tty'), { home, env }).d)
    expect(byName(tty, 'rbw auto-unlock')).toMatchObject({ ok: false, warning: true })
    expect(byName(tty, 'rbw auto-unlock')?.detail).toContain('pinentry is pinentry-tty')
    const creds = show('/repo/scripts/rbw-pinentry-creds')
    const missing = await hostChecks(config(), deps(creds, { home, env }).d)
    expect(byName(missing, 'rbw auto-unlock')?.detail).toBe(`${home}/.config/nightshift/rbw.cred is missing`)
    mkdirSync(join(home, '.config/nightshift'), { recursive: true })
    writeFileSync(join(home, '.config/nightshift/rbw.cred'), 'x')
    const ready = await hostChecks(config(), deps(creds, { home, env }).d)
    expect(byName(ready, 'rbw auto-unlock')).toMatchObject({ ok: true })
    const mac = await hostChecks(config(), deps(creds, { home, env, platform: 'darwin' }).d)
    expect(byName(mac, 'rbw auto-unlock')).toBeUndefined()
  })

  test('rbw is not probed when no secret reference uses it', async () => {
    const { d, calls } = deps()
    const c = config({
      gateway: { base_url: 'https://gw.example/v1', api_key: 'env:GW_KEY', worker_key: 'env:WORKER_KEY' },
      linear: { auth: { mode: 'api_key', api_key: 'env:LINEAR_KEY' } },
    })
    const results = await hostChecks(c, d)
    expect(byName(results, 'rbw')).toBeUndefined()
    expect(calls.some((x) => x.cmd[0] === 'rbw')).toBe(false)
  })

  test('OpenCode 1.x is rejected', async () => {
    const results = await hostChecks(config(), deps({ 'opencode --version': ok('1.14.3\n') }).d)
    expect(byName(results, 'opencode')).toMatchObject({
      ok: false,
      detail: 'major version 2 required (found 1.14.3)',
    })
  })

  test('sbx is checked only for the sbx driver, including /dev/kvm', async () => {
    const docker = await hostChecks(config(), deps().d)
    expect(byName(docker, 'sbx')).toBeUndefined()
    const sbx = config({ sandbox: { driver: 'sbx' } })
    const results = await hostChecks(sbx, deps({ 'sbx ls': fail() }, { kvm: () => false }).d)
    expect(failing(results)).toEqual(['sbx', 'sbx virtualization'])
  })

  test('an untrusted gateway certificate asks for gateway.ca_bundle; the bundle is passed as tls.ca', async () => {
    const untrusted = deps(
      {},
      {
        fetch: async () => {
          throw new Error('unable to verify the first certificate')
        },
      },
    )
    const results = await hostChecks(config(), untrusted.d)
    expect(byName(results, 'gateway')).toMatchObject({
      ok: false,
      fix: 'set gateway.ca_bundle to the PEM of the CA that signed the gateway',
    })

    const dir = mkdtempSync(join(tmpdir(), 'ns-ca-'))
    writeFileSync(join(dir, 'ca.pem'), 'PEM')
    let seen: unknown
    const trusted = deps(
      {},
      {
        fetch: async (_url, init) => {
          seen = init.tls?.ca
          return new Response(null)
        },
      },
    )
    const withCa = config({
      gateway: {
        base_url: 'https://gw.example/v1',
        api_key: 'rbw:llm-gateway',
        ca_bundle: join(dir, 'ca.pem'),
      },
    })
    expect(byName(await hostChecks(withCa, trusted.d), 'gateway')?.ok).toBe(true)
    expect(seen).toBe('PEM')
  })

  test('low disk space and a missing worker image are warnings with a fix', async () => {
    const results = await hostChecks(
      config(),
      deps({}, { freeBytes: () => MIN_FREE_BYTES - 1, imagePresent: async () => false }).d,
    )
    expect(failing(results)).toEqual([])
    expect(byName(results, 'disk state')).toMatchObject({
      ok: false,
      warning: true,
      detail: expect.stringContaining('19 GB'),
    })
    expect(byName(results, 'image omni')).toMatchObject({
      ok: false,
      warning: true,
      fix: expect.stringContaining('ns env build omni'),
    })
  })

  test('every failure is listed, not only the first', async () => {
    const results = await hostChecks(
      config(),
      deps({ 'docker info': fail(), 'rbw unlocked': fail(), 'opencode --version': null }).d,
    )
    expect(failing(results)).toEqual(['docker', 'rbw', 'opencode'])
  })
})

describe('credentials directory', () => {
  test('files named like env variables become the service environment; the process env wins', () => {
    const home = mkdtempSync(join(tmpdir(), 'ns-cred-'))
    const dir = join(home, '.config/nightshift/credentials')
    Bun.spawnSync(['mkdir', '-p', dir])
    writeFileSync(join(dir, 'NIGHTSHIFT_OCTO_STS_PASSWORD'), 'pw\n')
    writeFileSync(join(dir, 'lower'), 'ignored')
    expect(credentialNames(dir)).toEqual(['NIGHTSHIFT_OCTO_STS_PASSWORD'])
    expect(credentialEnv(dir)).toEqual({ NIGHTSHIFT_OCTO_STS_PASSWORD: 'pw' })
    expect(withCredentials({ HOME: home }).NIGHTSHIFT_OCTO_STS_PASSWORD).toBe('pw')
    expect(
      withCredentials({ HOME: home, NIGHTSHIFT_OCTO_STS_PASSWORD: 'env' }).NIGHTSHIFT_OCTO_STS_PASSWORD,
    ).toBe('env')
    expect(credentialEnv(join(home, 'missing'))).toEqual({})
  })
})
