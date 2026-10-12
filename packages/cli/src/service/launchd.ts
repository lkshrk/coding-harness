import { dirname, join } from 'node:path'
import {
  must,
  type Runner,
  type ServiceFiles,
  type ServiceManager,
  type ServiceSpec,
  type ServiceState,
} from './manager'

export const LAUNCHD_LABEL = 'dev.nightshift.supervisor'
export const LAUNCHD_LEAD_LABEL = 'dev.nightshift.lead'

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const str = (value: string) => `<string>${xml(value)}</string>`

export function launchdPlist(spec: ServiceSpec, label: string = LAUNCHD_LABEL): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `      <key>${xml(k)}</key>${str(v)}`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>${str(label)}
    <key>ProgramArguments</key>
    <array>
${[spec.bun, spec.main, ...(spec.args ?? ['supervise'])].map((a) => `      ${str(a)}`).join('\n')}
    </array>
    <key>WorkingDirectory</key>${str(spec.workdir)}
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key><false/>
    </dict>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key>${str(spec.logFile)}
    <key>StandardErrorPath</key>${str(spec.logFile)}
  </dict>
</plist>
`
}

export class LaunchdAgent implements ServiceManager {
  readonly kind = 'launchd'
  readonly path: string
  readonly label: string

  constructor(
    private readonly o: { home: string; uid: number; run: Runner; files: ServiceFiles; label?: string },
  ) {
    this.label = o.label ?? LAUNCHD_LABEL
    this.path = join(o.home, 'Library/LaunchAgents', `${this.label}.plist`)
  }

  private get domain(): string {
    return `gui/${this.o.uid}`
  }

  installed(): boolean {
    return this.o.files.exists(this.path)
  }

  async install(spec: ServiceSpec): Promise<void> {
    this.o.files.mkdir(dirname(spec.logFile))
    this.o.files.write(this.path, launchdPlist(spec, this.label))
  }

  async uninstall(): Promise<void> {
    this.o.files.remove(this.path)
  }

  async start(): Promise<void> {
    await must(this.o.run, ['launchctl', 'bootstrap', this.domain, this.path])
  }

  async stop(): Promise<void> {
    if (await this.loaded()) await must(this.o.run, ['launchctl', 'bootout', `${this.domain}/${this.label}`])
  }

  private async loaded(): Promise<boolean> {
    return (await this.o.run(['launchctl', 'print', `${this.domain}/${this.label}`])).exitCode === 0
  }

  async status(): Promise<ServiceState> {
    if (!this.installed()) return 'not installed'
    const res = await this.o.run(['launchctl', 'print', `${this.domain}/${this.label}`])
    return res.exitCode === 0 && /\bstate = running\b/.test(res.stdout) ? 'running' : 'stopped'
  }
}
