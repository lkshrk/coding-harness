import type { IssueSpec } from '@nightshift/core'

export type { IssueSpec }

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

export type RenderedAgent = { name: string; files: { path: string; content: string }[] }

export type GatewayAccess = { baseUrl: string; apiKey: string; sessionId: string; caBundlePath?: string }

export type WorkerStart = {
  sandbox: SandboxHandle
  agent: RenderedAgent
  model: string
  taskMessage: string
  gateway: GatewayAccess
  limits: { steps: number; wallClockMs: Ms; tokens: number; graceTurns: number }
  workdir: string
}

export type WorkerSession = { id: string; attach: string[]; traceId?: string }

export type HarnessEvent =
  | { kind: 'step'; step: number; tokensIn: number; tokensOut: number }
  | { kind: 'tool_call'; tool: string; argsDigest: string }
  | { kind: 'tool_result'; tool: string; ok: boolean }
  | { kind: 'text'; chars: number }
  | { kind: 'finish'; payload: unknown }
  | { kind: 'idle'; sinceMs: Ms }
  | { kind: 'error'; message: string; fatal: boolean }

export interface WorkerDriver {
  readonly harness: 'opencode' | 'acp'
  start(w: WorkerStart): Promise<WorkerSession>
  events(s: WorkerSession): AsyncIterable<HarnessEvent>
  send(s: WorkerSession, message: string): Promise<void>
  stop(s: WorkerSession, reason: string): Promise<void>
  alive(s: WorkerSession): Promise<boolean>
}

export type BlockerOutput = { identifier: string; prUrl?: string; interfaces: string }

export type Attempt = {
  attempt: number
  agent: string
  failureClass: string
  summary: string
  gateTail?: string
  findings?: string
}

export type ContextRepository = { name: string; checkoutPath: string; indexPath?: string; base: string }

export type ContextInput = {
  issue: IssueSpec
  repository: ContextRepository
  blockers: BlockerOutput[]
  attempts: Attempt[]
  vaultPages: { path: string; title: string; content: string }[]
  answers: { question: string; answer: string }[]
  run?: { id: string; attempt: number; profile: string }
}

export type ContextSection = { name: string; tokens: number; sources: string[]; truncated: boolean }

export type BuiltContext = { message: string; tokens: number; sections: ContextSection[] }

export type ContextBudget = { inputTokens: number; model: string }

export interface ContextBuilder {
  build(input: ContextInput, budget: ContextBudget): Promise<BuiltContext>
}

export type Check = { name: string; run: string; timeoutMs: Ms }

export type GateResult = { check: string; passed: boolean; result: ExecResult }

export interface GateRunner {
  run(
    repo: { name: string; image: string; gitDir: string },
    bundle: string,
    headSha: string,
    checks: Check[],
    opts?: { run?: string },
  ): Promise<GateResult[]>
}

export type PullRequest = {
  url: string
  number: number
  repository: string
  repo: string
  branch: string
  base: string
  account: string
}

export type CiState = { state: 'pending' | 'passed' | 'failed'; failedChecks: string[]; url: string }

export type PullRequestState = { state: 'open' | 'merged' | 'closed'; mergeSha?: string }

export interface GitHost {
  accountFor(repository: string): string
  push(o: { repository: string; source: string; branch: string }): Promise<{ headSha: string }>
  openPullRequest(o: {
    repository: string
    branch: string
    base: string
    title: string
    body: string
    draft: boolean
  }): Promise<PullRequest>
  ci(pr: PullRequest): Promise<CiState>
  state(pr: PullRequest): Promise<PullRequestState>
  merge(pr: PullRequest, method: 'squash' | 'merge' | 'rebase'): Promise<{ sha: string }>
}
