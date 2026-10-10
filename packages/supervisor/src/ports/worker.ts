import type { CiFailure } from './git-host'
import type { IssueSnapshot } from './linear'
import type { Run } from './records'
import type { Ms, SandboxHandle } from './sandbox'

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
  readonly harness: 'opencode' | 'acp' | 'dsh'
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
  ciFailures?: CiFailure[]
}

export type ExecutorStart = {
  run: Run
  issue: IssueSnapshot
  files: string[]
  sourceFiles?: { path: string; content: string }[]
  knowledgeRepo?: string
  repairFrom?: { run: string; headSha: string }
}

export interface RunExecutor {
  start(s: ExecutorStart): Promise<void>
  reattach(run: Run): Promise<void>
  runStep(run: Run): Promise<void>
  nudge(run: Run, message: string): Promise<void>
  stop(run: Run, reason: string): Promise<void>
  detach?(): void
  captureHead?(run: Run, status?: string): Promise<string | undefined>
}

export type WorkerStartedInfo = { sandbox: string; session: string; attach?: string }

export type SandboxCreatedInfo = { driver: SandboxHandle['driver']; id: string; image: string }

export type Progress = {
  steps: number
  tool_calls: number
  tokens: number
  diff_lines?: number
  last_tool?: string
  tools?: Record<string, number>
}
