import { describe, expect, test } from 'bun:test'
import type { CommandResult, Config } from '@nightshift/core'
import { run } from '../run'
import { LaunchdAgent, launchdPlist, type ServiceDeps, SystemdUserService, serviceSpec, systemdUnit } from '.'
import type { ServiceFiles, ServiceSpec } from './manager'

const spec: ServiceSpec = {
  bun: '/home/dev/.bun/bin/bun',
  main: '/home/dev/Dev/coding-harness/packages/cli/src/main.ts',
  workdir: '/home/dev/Dev/coding-harness',
  env: {
    PATH: '/home/dev/.bun/bin:/usr/bin',
    RBW_PROFILE: 'nightshift',
    NODE_EXTRA_CA_CERTS: '/etc/ca & co.pem',
  },
  logFile: '/home/dev/.local/state/nightshift/supervisor.log',
}

const config = {
  paths: { state: '~/.local/state/nightshift', cache: '~/.cache/nightshift', vault: '~/Dev/vault' },
  gateway: {
    base_url: 'https://gw/v1',
    api_key: 'rbw:llm-gateway',
    ca_bundle: '~/.config/nightshift/ca.pem',
  },
  secrets: { rbw_profile: 'nightshift' },
} as unknown as Config

function fakes(answers: Record<string, CommandResult> = {}) {
  const calls: string[] = []
  const files = new Map<string, string>()
  const fs: ServiceFiles = {
    exists: (p) => files.has(p),
    write: (p, c) => files.set(p, c),
    remove: (p) => files.delete(p),
    mkdir: (p) => calls.push(`mkdir ${p}`),
  }
  const runner = async (cmd: string[]) => {
    const line = cmd.join(' ')
    calls.push(line)
    return answers[line] ?? { exitCode: 0, stdout: '', stderr: '' }
  }
  return { calls, files, fs, runner }
}

async function cli(args: string[], service: ServiceDeps, over = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(
    args,
    { out: (s) => out.push(s), err: (s) => err.push(s) },
    { load: () => ({ ok: true, config, sources: [] }), service, ...over },
  )
  return { code, out, err }
}

describe('service definitions', () => {
  test('the systemd unit runs ns supervise with restart, environment and an install target', () => {
    expect(systemdUnit(spec)).toBe(`[Unit]
Description=nightshift supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/dev/Dev/coding-harness
ExecStart=/home/dev/.bun/bin/bun /home/dev/Dev/coding-harness/packages/cli/src/main.ts supervise
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=60
Environment=PATH=/home/dev/.bun/bin:/usr/bin
Environment=RBW_PROFILE=nightshift
Environment="NODE_EXTRA_CA_CERTS=/etc/ca & co.pem"

[Install]
WantedBy=default.target
`)
  })

  test('the launchd plist runs at load, restarts on failure and logs to the state directory', () => {
    const plist = launchdPlist(spec)
    expect(plist).toContain('<key>Label</key><string>dev.nightshift.supervisor</string>')
    expect(plist).toContain(`<string>${spec.main}</string>\n      <string>supervise</string>`)
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(plist).toContain('<key>SuccessfulExit</key><false/>')
    expect(plist).toContain(`<key>StandardOutPath</key><string>${spec.logFile}</string>`)
    expect(plist).toContain('<key>NODE_EXTRA_CA_CERTS</key><string>/etc/ca &amp; co.pem</string>')
  })

  test('the spec sets the rbw profile and trusts the gateway CA bundle', () => {
    const s = serviceSpec(config, {
      bun: '/b/bun',
      env: { HOME: '/home/dev', PATH: '/usr/bin', SECRET_TOKEN: 'x' },
    })
    expect(s.env).toEqual({
      PATH: '/usr/bin',
      RBW_PROFILE: 'nightshift',
      NODE_EXTRA_CA_CERTS: '/home/dev/.config/nightshift/ca.pem',
    })
    expect(s.logFile).toBe('/home/dev/.local/state/nightshift/supervisor.log')
    expect(s.main).toEndWith('packages/cli/src/main.ts')
  })

  test('the systemd unit unlocks rbw before start without blocking on failure', () => {
    const s = serviceSpec(config, { bun: '/b/bun', env: { HOME: '/home/dev' }, rbw: '/usr/bin/rbw' })
    expect(s.rbw).toBe('/usr/bin/rbw')
    expect(systemdUnit(s)).toContain('ExecStartPre=-/usr/bin/rbw unlock\nExecStart=/b/bun ')
  })
})

describe('ns up / ns down with systemd', () => {
  const unit = '/home/dev/.config/systemd/user/nightshift.service'
  const systemd = (f: ReturnType<typeof fakes>) =>
    new SystemdUserService({ home: '/home/dev', user: 'dev', run: f.runner, files: f.fs })

  test('up writes the unit, enables and starts it, and enables lingering', async () => {
    const f = fakes({
      'systemctl --user is-active nightshift.service': { exitCode: 0, stdout: 'active\n', stderr: '' },
    })
    const r = await cli(['up'], {
      service: () => systemd(f),
      lockHolder: () => null,
      bun: '/b/bun',
      rbw: '/usr/bin/rbw',
      env: {},
    })
    expect(r.code).toBe(0)
    expect(f.files.get(unit)).toContain('ExecStartPre=-/usr/bin/rbw unlock\nExecStart=/b/bun ')
    expect(f.calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable nightshift.service',
      'systemctl --user start nightshift.service',
      'loginctl show-user dev --property=Linger --value',
      'loginctl enable-linger dev',
      'systemctl --user is-active nightshift.service',
    ])
    expect(r.out.at(-1)).toBe('status: running')
  })

  test('up refuses while another supervisor holds the state lock', async () => {
    const f = fakes()
    const holder = 'another nightshift supervisor holds /s/state.db.lock'
    const r = await cli(['up'], { service: () => systemd(f), lockHolder: () => holder, env: {} })
    expect(r.code).toBe(1)
    expect(r.err).toEqual([holder])
    expect(f.files.size).toBe(0)
  })

  test('up is a no-op when the service already runs', async () => {
    const f = fakes({
      'systemctl --user is-active nightshift.service': { exitCode: 0, stdout: 'active\n', stderr: '' },
    })
    f.files.set(unit, 'old')
    const r = await cli(['up'], { service: () => systemd(f), lockHolder: () => null, env: {} })
    expect(r.code).toBe(0)
    expect(f.calls).toEqual(['systemctl --user is-active nightshift.service'])
  })

  test('a missing user manager fails with the WSL fix', async () => {
    const f = fakes({
      'systemctl --user daemon-reload': { exitCode: 1, stdout: '', stderr: 'Failed to connect to bus' },
    })
    const r = await cli(['up'], { service: () => systemd(f), lockHolder: () => null, env: {} })
    expect(r.code).toBe(1)
    expect(r.err[0]).toBe('systemctl --user daemon-reload failed: Failed to connect to bus')
    expect(r.err[1]).toContain('[boot] systemd=true')
  })

  test('down stops, disables and removes the unit; a second down is a no-op', async () => {
    const f = fakes()
    f.files.set(unit, 'x')
    const first = await cli(['down'], { service: () => systemd(f) })
    expect(first.code).toBe(0)
    expect(f.calls).toEqual([
      'systemctl --user stop nightshift.service',
      'systemctl --user disable nightshift.service',
      'systemctl --user daemon-reload',
    ])
    expect(f.files.has(unit)).toBe(false)
    const second = await cli(['down'], { service: () => systemd(f) })
    expect(second).toMatchObject({ code: 0, out: ['nightshift service is not installed'] })
    expect(f.calls).toHaveLength(3)
  })
})

describe('ns up / ns down with launchd', () => {
  const plist = '/Users/me/Library/LaunchAgents/dev.nightshift.supervisor.plist'
  const target = 'gui/501/dev.nightshift.supervisor'

  test('up writes the plist and bootstraps it; down boots it out and removes it', async () => {
    const f = fakes({ [`launchctl print ${target}`]: { exitCode: 113, stdout: '', stderr: 'not found' } })
    const agent = () => new LaunchdAgent({ home: '/Users/me', uid: 501, run: f.runner, files: f.fs })
    const service = { service: agent, lockHolder: () => null, env: {}, bun: '/b/bun' }
    const r = await cli(['up'], service)
    expect(r.code).toBe(0)
    expect(f.files.get(plist)).toContain('<string>/b/bun</string>')
    expect(f.calls).toContain(`launchctl bootstrap gui/501 ${plist}`)

    f.calls.length = 0
    const loaded = fakes({
      [`launchctl print ${target}`]: { exitCode: 0, stdout: 'state = running', stderr: '' },
    })
    loaded.files.set(plist, 'x')
    const down = await cli(['down'], {
      service: () => new LaunchdAgent({ home: '/Users/me', uid: 501, run: loaded.runner, files: loaded.fs }),
    })
    expect(down.code).toBe(0)
    expect(loaded.calls).toEqual([`launchctl print ${target}`, `launchctl bootout ${target}`])
    expect(loaded.files.has(plist)).toBe(false)
  })
})
