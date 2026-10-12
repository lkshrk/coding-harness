import { describe, expect, test } from 'bun:test'
import type { CommandResult, Config } from '@nightshift/core'
import { run } from '../run'
import {
  LAUNCHD_LEAD_LABEL,
  LaunchdAgent,
  launchdPlist,
  leadServiceSpec,
  type ServiceDeps,
  SYSTEMD_LEAD_UNIT,
  SystemdUserService,
  serviceSpec,
  systemdUnit,
} from '.'
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
  limits: { handoff_grace_seconds: 120 },
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

  test('the systemd stop timeout exceeds the handoff grace period', () => {
    const s = serviceSpec(config, { bun: '/b/bun', env: { HOME: '/home/dev' } })
    expect(systemdUnit(s)).toContain('TimeoutStopSec=180\n')
  })

  test('the lead unit runs ns lead serve, restarts on failure and unlocks rbw like the supervisor', () => {
    const env = { HOME: '/home/dev', PATH: '/usr/bin' }
    const s = leadServiceSpec(config, { bun: '/b/bun', env, rbw: '/usr/bin/rbw' })
    const unit = systemdUnit(s)
    expect(unit).toContain('Description=nightshift lead\n')
    expect(unit).toContain('ExecStartPre=-/usr/bin/rbw unlock\nExecStart=/b/bun ')
    expect(unit).toContain('packages/cli/src/main.ts lead serve\nRestart=on-failure\n')
    expect(unit).toContain('TimeoutStopSec=60\n')
    expect(s.env).toEqual(serviceSpec(config, { bun: '/b/bun', env }).env)
    expect(s.logFile).toBe('/home/dev/.local/state/nightshift/lead.log')
    const plist = launchdPlist(s, 'dev.nightshift.lead')
    expect(plist).toContain('<key>Label</key><string>dev.nightshift.lead</string>')
    expect(plist).toContain(
      `<string>${s.main}</string>\n      <string>lead</string>\n      <string>serve</string>`,
    )
  })
})

describe('ns up / ns down with systemd', () => {
  const unit = '/home/dev/.config/systemd/user/nightshift.service'
  const leadUnit = '/home/dev/.config/systemd/user/nightshift-lead.service'
  const systemd =
    (f: ReturnType<typeof fakes>) =>
    (role: 'supervisor' | 'lead' = 'supervisor') =>
      new SystemdUserService({
        home: '/home/dev',
        user: 'dev',
        run: f.runner,
        files: f.fs,
        ...(role === 'lead' ? { unit: SYSTEMD_LEAD_UNIT } : {}),
      })

  test('up writes both units, enables and starts them, and enables lingering', async () => {
    const f = fakes({
      'systemctl --user is-active nightshift.service': { exitCode: 0, stdout: 'active\n', stderr: '' },
      'systemctl --user is-active nightshift-lead.service': { exitCode: 0, stdout: 'active\n', stderr: '' },
    })
    const r = await cli(['up'], {
      service: systemd(f),
      lockHolder: () => null,
      bun: '/b/bun',
      rbw: '/usr/bin/rbw',
      env: {},
    })
    expect(r.code).toBe(0)
    expect(f.files.get(unit)).toContain('ExecStartPre=-/usr/bin/rbw unlock\nExecStart=/b/bun ')
    expect(f.files.get(unit)).toContain(' supervise\n')
    expect(f.files.get(leadUnit)).toContain('ExecStartPre=-/usr/bin/rbw unlock\nExecStart=/b/bun ')
    expect(f.files.get(leadUnit)).toContain(' lead serve\n')
    expect(f.calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable nightshift.service',
      'systemctl --user start nightshift.service',
      'systemctl --user daemon-reload',
      'systemctl --user enable nightshift-lead.service',
      'systemctl --user start nightshift-lead.service',
      'loginctl show-user dev --property=Linger --value',
      'loginctl enable-linger dev',
      'systemctl --user is-active nightshift.service',
      'systemctl --user is-active nightshift-lead.service',
    ])
    expect(r.out.slice(-2)).toEqual(['nightshift: running', 'nightshift lead: running'])
  })

  test('up refuses while another supervisor holds the state lock', async () => {
    const f = fakes()
    const holder = 'another nightshift supervisor holds /s/state.db.lock'
    const r = await cli(['up'], { service: systemd(f), lockHolder: () => holder, env: {} })
    expect(r.code).toBe(1)
    expect(r.err).toEqual([holder])
    expect(f.files.size).toBe(0)
  })

  test('up is a no-op when both services already run', async () => {
    const f = fakes({
      'systemctl --user is-active nightshift.service': { exitCode: 0, stdout: 'active\n', stderr: '' },
      'systemctl --user is-active nightshift-lead.service': { exitCode: 0, stdout: 'active\n', stderr: '' },
    })
    f.files.set(unit, 'old')
    f.files.set(leadUnit, 'old')
    const r = await cli(['up'], { service: systemd(f), lockHolder: () => null, env: {} })
    expect(r.code).toBe(0)
    expect(f.calls).toEqual([
      'systemctl --user is-active nightshift.service',
      'systemctl --user is-active nightshift-lead.service',
    ])
  })

  test('up starts only the lead when the supervisor already runs, without restarting it', async () => {
    const f = fakes({
      'systemctl --user is-active nightshift.service': { exitCode: 0, stdout: 'active\n', stderr: '' },
    })
    f.files.set(unit, 'old')
    const r = await cli(['up'], {
      service: systemd(f),
      lockHolder: () => 'held by the running supervisor',
      env: {},
    })
    expect(r.code).toBe(0)
    expect(f.files.get(unit)).toBe('old')
    expect(f.calls.filter((c) => c.includes('nightshift.service'))).toEqual([
      'systemctl --user is-active nightshift.service',
      'systemctl --user is-active nightshift.service',
    ])
    expect(f.calls).toContain('systemctl --user start nightshift-lead.service')
  })

  test('a missing user manager fails with the WSL fix', async () => {
    const f = fakes({
      'systemctl --user daemon-reload': { exitCode: 1, stdout: '', stderr: 'Failed to connect to bus' },
    })
    const r = await cli(['up'], { service: systemd(f), lockHolder: () => null, env: {} })
    expect(r.code).toBe(1)
    expect(r.err[0]).toBe('systemctl --user daemon-reload failed: Failed to connect to bus')
    expect(r.err[1]).toContain('[boot] systemd=true')
  })

  test('down stops, disables and removes both units; a second down is a no-op', async () => {
    const f = fakes()
    f.files.set(unit, 'x')
    f.files.set(leadUnit, 'x')
    const first = await cli(['down'], { service: systemd(f) })
    expect(first.code).toBe(0)
    expect(f.calls).toEqual([
      'systemctl --user stop nightshift.service',
      'systemctl --user disable nightshift.service',
      'systemctl --user daemon-reload',
      'systemctl --user stop nightshift-lead.service',
      'systemctl --user disable nightshift-lead.service',
      'systemctl --user daemon-reload',
    ])
    expect(f.files.has(unit)).toBe(false)
    expect(f.files.has(leadUnit)).toBe(false)
    const second = await cli(['down'], { service: systemd(f) })
    expect(second).toMatchObject({ code: 0, out: ['nightshift service is not installed'] })
    expect(f.calls).toHaveLength(6)
  })

  test('the supervisor and lead units restart independently', async () => {
    const f = fakes()
    await systemd(f)('supervisor').stop()
    await systemd(f)('supervisor').start()
    await systemd(f)('lead').stop()
    expect(f.calls).toEqual([
      'systemctl --user stop nightshift.service',
      'systemctl --user start nightshift.service',
      'systemctl --user stop nightshift-lead.service',
    ])
    expect(systemdUnit(leadServiceSpec(config, { bun: '/b/bun', env: { HOME: '/h' } }))).not.toMatch(
      /PartOf|BindsTo|Requires|nightshift\.service/,
    )
  })
})

describe('ns up / ns down with launchd', () => {
  const plist = '/Users/me/Library/LaunchAgents/dev.nightshift.supervisor.plist'
  const target = 'gui/501/dev.nightshift.supervisor'

  const leadPlist = '/Users/me/Library/LaunchAgents/dev.nightshift.lead.plist'
  const leadTarget = 'gui/501/dev.nightshift.lead'
  const agents =
    (f: ReturnType<typeof fakes>) =>
    (role: 'supervisor' | 'lead' = 'supervisor') =>
      new LaunchdAgent({
        home: '/Users/me',
        uid: 501,
        run: f.runner,
        files: f.fs,
        ...(role === 'lead' ? { label: LAUNCHD_LEAD_LABEL } : {}),
      })

  test('up writes both plists and bootstraps them; down boots them out and removes them', async () => {
    const missing = { exitCode: 113, stdout: '', stderr: 'not found' }
    const f = fakes({ [`launchctl print ${target}`]: missing, [`launchctl print ${leadTarget}`]: missing })
    const service = { service: agents(f), lockHolder: () => null, env: {}, bun: '/b/bun' }
    const r = await cli(['up'], service)
    expect(r.code).toBe(0)
    expect(f.files.get(plist)).toContain('<string>/b/bun</string>')
    expect(f.files.get(leadPlist)).toContain('<string>lead</string>\n      <string>serve</string>')
    expect(f.calls).toContain(`launchctl bootstrap gui/501 ${plist}`)
    expect(f.calls).toContain(`launchctl bootstrap gui/501 ${leadPlist}`)

    f.calls.length = 0
    const loaded = fakes({
      [`launchctl print ${target}`]: { exitCode: 0, stdout: 'state = running', stderr: '' },
    })
    loaded.files.set(plist, 'x')
    loaded.files.set(leadPlist, 'x')
    const down = await cli(['down'], { service: agents(loaded) })
    expect(down.code).toBe(0)
    expect(loaded.calls).toEqual([
      `launchctl print ${target}`,
      `launchctl bootout ${target}`,
      `launchctl print ${leadTarget}`,
      `launchctl bootout ${leadTarget}`,
    ])
    expect(loaded.files.has(plist)).toBe(false)
    expect(loaded.files.has(leadPlist)).toBe(false)
  })
})
