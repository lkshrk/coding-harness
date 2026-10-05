export type Ms = number

export type ExecResult = {
  exitCode: number
  durationMs: Ms
  stdoutTail: string
  stderrTail: string
  artifact: string
  timedOut: boolean
}

export type Mount = { hostPath: string; guestPath: string; readOnly: true }

export type SandboxSpec = {
  name: string
  image: string
  resources: { cpus: number; memoryMb: number }
  outbox: string
  mounts: Mount[]
  env: Record<string, string>
  egress: { allow: string[] }
  workdir: string
  labels: Record<string, string>
}

export type SandboxHandle = { driver: 'docker' | 'sbx'; id: string; name: string }

export type SandboxStatus = 'running' | 'stopped' | 'gone'

export type SandboxCapabilities = {
  nestedDocker: boolean
  egressPolicy: boolean
  credentialInjection: boolean
}

export type ProcessHandle = { sandbox: SandboxHandle; pid: string }

export interface SandboxDriver {
  capabilities(): SandboxCapabilities
  create(spec: SandboxSpec): Promise<SandboxHandle>
  status(h: SandboxHandle): Promise<SandboxStatus>
  exec(
    h: SandboxHandle,
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: Ms; stdin?: string },
  ): Promise<ExecResult>
  spawn(
    h: SandboxHandle,
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<ProcessHandle>
  expose(h: SandboxHandle, guestPort: number): Promise<{ url: string }>
  attachCommand(h: SandboxHandle, shell?: string[]): string[]
  logs(h: SandboxHandle, opts?: { follow?: boolean }): AsyncIterable<string>
  exportCommits(
    h: SandboxHandle,
    repoPath: string,
    ref: string,
    message?: string,
  ): Promise<{ bundle: string; headSha: string }>
  list(labels: Record<string, string>): Promise<SandboxHandle[]>
  destroy(h: SandboxHandle): Promise<void>
}
