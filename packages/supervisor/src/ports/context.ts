import type { IssueSpec, runSingleCall } from '@nightshift/core'
import type { ExecResult, Ms } from './sandbox'
import type { Attempt, BlockerOutput, ExecutorStart } from './worker'

export type { IssueSpec }

export type ContextRepository = { name: string; checkoutPath: string; indexPath?: string; base: string }

export type ContextInput = {
  issue: IssueSpec
  repository: ContextRepository
  blockers: BlockerOutput[]
  attempts: Attempt[]
  vaultPages: { path: string; title: string; content: string }[]
  answers: { question: string; answer: string }[]
  wipHead?: { sha: string; subject: string }
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

export type TaskStart = ExecutorStart & { indexPath?: string }

export type TaskMessage = (s: TaskStart, budget: ContextBudget) => Promise<BuiltContext>

export type SingleCall = typeof runSingleCall

export type Neighbour = { path: string; edges: number }

export interface CodeGraph {
  neighbours(files: readonly string[]): Neighbour[]
  outline(path: string): string
  close(): void
}
