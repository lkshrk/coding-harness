import type {
  ExecResult,
  Ms,
  ProcessHandle,
  SandboxCapabilities,
  SandboxDriver,
  SandboxHandle,
  SandboxSpec,
  SandboxStatus,
} from '../../ports'

export type ExecCall = {
  cmd: string[]
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: Ms; stdin?: string }
}

export class FakeSandboxDriver implements SandboxDriver {
  readonly created: SandboxSpec[] = []
  readonly execs: ExecCall[] = []
  readonly spawns: ExecCall[] = []
  readonly destroyed: string[] = []
  readonly files = new Map<string, string>()
  url = 'http://127.0.0.1:1'
  onExec: (cmd: string[]) => Partial<ExecResult> | undefined = () => undefined

  capabilities(): SandboxCapabilities {
    return { nestedDocker: false, egressPolicy: false, credentialInjection: false }
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec)
    return { driver: 'docker', id: `ctr-${spec.name}`, name: spec.name }
  }

  async status(): Promise<SandboxStatus> {
    return 'running'
  }

  async exec(_h: SandboxHandle, cmd: string[], opts: ExecCall['opts'] = {}): Promise<ExecResult> {
    this.execs.push({ cmd, opts })
    const result = (exitCode: number, stdout = ''): ExecResult => ({
      exitCode,
      durationMs: 1,
      stdoutTail: stdout,
      stderrTail: '',
      artifact: '',
      timedOut: false,
    })
    const custom = this.onExec(cmd)
    if (custom) return { ...result(0), ...custom }
    if (cmd[0] === 'sh' && cmd[2]?.includes('cat >') && cmd[4]) {
      this.files.set(cmd[4], opts.stdin ?? '')
      return result(0)
    }
    if (cmd[0] === 'cat' && cmd[1]) {
      const content = this.files.get(cmd[1])
      return content === undefined ? result(1) : result(0, content)
    }
    if (cmd[0] === 'rm' && cmd[2]) this.files.delete(cmd[2])
    return result(0)
  }

  async spawn(h: SandboxHandle, cmd: string[], opts: ExecCall['opts'] = {}): Promise<ProcessHandle> {
    this.spawns.push({ cmd, opts })
    return { sandbox: h, pid: '42' }
  }

  async expose(): Promise<{ url: string }> {
    return { url: this.url }
  }

  attachCommand(h: SandboxHandle, shell: string[] = ['bash']): string[] {
    return ['docker', 'exec', '-it', h.id, ...shell]
  }

  async *logs(): AsyncIterable<string> {}

  async exportCommits(
    _h: SandboxHandle,
    _repoPath: string,
    _ref: string,
  ): Promise<{ bundle: string; headSha: string }> {
    return { bundle: '/tmp/b.bundle', headSha: 'abc' }
  }

  async list(_labels: Record<string, string> = {}): Promise<SandboxHandle[]> {
    return []
  }

  async destroy(h: SandboxHandle): Promise<void> {
    this.destroyed.push(h.id)
  }
}
