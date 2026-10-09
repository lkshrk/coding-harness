import { join } from 'node:path'
import {
  must,
  type Runner,
  type ServiceFiles,
  type ServiceManager,
  type ServiceSpec,
  type ServiceState,
} from './manager'

export const SYSTEMD_UNIT = 'nightshift.service'

function quote(value: string): string {
  if (!/[\s"\\$%]/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`)
  return [
    '[Unit]',
    'Description=nightshift supervisor',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${quote(spec.workdir)}`,
    ...(spec.rbw ? [`ExecStartPre=-${quote(spec.rbw)} unlock`] : []),
    `ExecStart=${quote(spec.bun)} ${quote(spec.main)} supervise`,
    'Restart=on-failure',
    'RestartSec=10',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=60',
    ...env,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export class SystemdUserService implements ServiceManager {
  readonly kind = 'systemd'
  readonly path: string

  constructor(
    private readonly o: { home: string; user: string; run: Runner; files: ServiceFiles; configHome?: string },
  ) {
    this.path = join(o.configHome || join(o.home, '.config'), 'systemd/user', SYSTEMD_UNIT)
  }

  installed(): boolean {
    return this.o.files.exists(this.path)
  }

  async install(spec: ServiceSpec): Promise<void> {
    this.o.files.write(this.path, systemdUnit(spec))
    await must(this.o.run, ['systemctl', '--user', 'daemon-reload'])
    await must(this.o.run, ['systemctl', '--user', 'enable', SYSTEMD_UNIT])
  }

  async lingering(): Promise<boolean> {
    const res = await this.o.run(['loginctl', 'show-user', this.o.user, '--property=Linger', '--value'])
    return res.exitCode === 0 && res.stdout.trim() === 'yes'
  }

  async enableLinger(): Promise<boolean> {
    if (await this.lingering()) return true
    return (await this.o.run(['loginctl', 'enable-linger', this.o.user])).exitCode === 0
  }

  async uninstall(): Promise<void> {
    await this.o.run(['systemctl', '--user', 'disable', SYSTEMD_UNIT])
    this.o.files.remove(this.path)
    await must(this.o.run, ['systemctl', '--user', 'daemon-reload'])
  }

  async start(): Promise<void> {
    await must(this.o.run, ['systemctl', '--user', 'start', SYSTEMD_UNIT])
  }

  async stop(): Promise<void> {
    await must(this.o.run, ['systemctl', '--user', 'stop', SYSTEMD_UNIT])
  }

  async status(): Promise<ServiceState> {
    if (!this.installed()) return 'not installed'
    const res = await this.o.run(['systemctl', '--user', 'is-active', SYSTEMD_UNIT])
    return res.stdout.trim() === 'active' || res.stdout.trim() === 'activating' ? 'running' : 'stopped'
  }
}
