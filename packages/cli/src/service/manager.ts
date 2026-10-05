import type { CommandResult } from '@nightshift/core'

export type ServiceSpec = {
  bun: string
  main: string
  workdir: string
  env: Record<string, string>
  logFile: string
}

export type ServiceState = 'running' | 'stopped' | 'not installed'

export interface ServiceManager {
  readonly kind: 'systemd' | 'launchd'
  readonly path: string
  installed(): boolean
  install(spec: ServiceSpec): Promise<void>
  uninstall(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  status(): Promise<ServiceState>
}

export type Runner = (cmd: string[]) => Promise<CommandResult>

export type ServiceFiles = {
  exists: (path: string) => boolean
  write: (path: string, content: string) => void
  remove: (path: string) => void
  mkdir: (path: string) => void
}

export class ServiceError extends Error {
  override name = 'ServiceError'
}

export async function must(run: Runner, cmd: string[]): Promise<CommandResult> {
  const res = await run(cmd)
  if (res.exitCode !== 0)
    throw new ServiceError(
      `${cmd.join(' ')} failed: ${(res.stderr || res.stdout).trim() || `exit ${res.exitCode}`}`,
    )
  return res
}
