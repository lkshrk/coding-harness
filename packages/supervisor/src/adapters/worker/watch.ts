import type { AgentDef } from '@nightshift/core'
import type { HarnessEvent, Ms, WorkerStart } from '../../ports'
import type { Progress } from '../../ports/worker'

export type WatchThresholds = {
  noToolCallSteps: number
  repeatedToolCalls: number
  idleMs: Ms
  noDiffGrowthSteps: number
  progressSteps: number
  progressMs: Ms
}

export const WATCH_DEFAULTS: WatchThresholds = {
  noToolCallSteps: 3,
  repeatedToolCalls: 4,
  idleMs: 300_000,
  noDiffGrowthSteps: 40,
  progressSteps: 5,
  progressMs: 60_000,
}

export type StallSignal = 'no_tool_calls' | 'repeated_tool_call' | 'no_diff_growth' | 'idle'

export type CapReason = 'step_cap' | 'time_cap' | 'token_cap'

export type { Progress } from '../../ports/worker'

export type NoDiffLimits = { steps: number; tokens: number }

export type WatchLimits = WorkerStart['limits'] & { noDiff?: NoDiffLimits }

export type WatchAction =
  | { kind: 'progress'; data: Progress }
  | { kind: 'stall'; signal: StallSignal; detail: string }
  | { kind: 'cap'; reason: CapReason }
  | { kind: 'no_diff'; act: 'nudge' | 'stop'; steps: number; tokens: number }

/** Whether the agent's job is a diff; read-only and single-call agents are never held to the no-diff limits. */
export function producesDiff(def: Pick<AgentDef, 'kind' | 'opencode'>): boolean {
  if (def.kind !== 'worker') return false
  const p = def.opencode.permission
  if (p === undefined) return true
  if (typeof p === 'string') return p !== 'deny'
  const edit = p.edit ?? p['*']
  if (edit === undefined) return true
  return typeof edit === 'string' ? edit !== 'deny' : Object.values(edit).some((v) => v !== 'deny')
}

export class Watcher {
  private steps = 0
  private toolCalls = 0
  private tokens = 0
  private lastTool: string | undefined
  private readonly tools: Record<string, number> = {}
  private lastDigest: string | undefined
  private repeats = 0
  private diffLines: number | undefined
  private diffChangedAt = 0
  private lastEventAt: number
  private executing = true
  private silenceFlagged = false
  private noToolFlagged = false
  private capped = false
  private progressAt: number
  private progressSteps = 0
  private noDiff: 'watching' | 'nudged' | 'done'
  private noDiffTurns = 0

  constructor(
    private readonly limits: WatchLimits,
    private readonly t: WatchThresholds,
    private readonly startedAt: number,
  ) {
    this.lastEventAt = startedAt
    this.progressAt = startedAt
    this.noDiff = limits.noDiff ? 'watching' : 'done'
  }

  observe(e: HarnessEvent, now: number): WatchAction[] {
    if (e.kind === 'idle') {
      this.executing = false
      return e.sinceMs === 0 ? this.noDiffTurnEnded() : []
    }
    this.executing = true
    this.lastEventAt = now
    this.silenceFlagged = false
    const out: WatchAction[] = []
    if (e.kind === 'step') {
      this.steps += 1
      this.tokens += e.tokensIn + e.tokensOut
      if (!this.noToolFlagged && this.toolCalls === 0 && this.steps >= this.t.noToolCallSteps) {
        this.noToolFlagged = true
        out.push({
          kind: 'stall',
          signal: 'no_tool_calls',
          detail: `${this.steps} steps without a tool call`,
        })
      }
      if (this.steps - this.diffChangedAt >= this.t.noDiffGrowthSteps) {
        this.diffChangedAt = this.steps
        out.push({
          kind: 'stall',
          signal: 'no_diff_growth',
          detail: `diff unchanged for ${this.t.noDiffGrowthSteps} steps`,
        })
      }
      out.push(...this.noDiffStep())
      if (this.steps >= this.limits.steps) out.push(...this.cap('step_cap'))
      if (this.tokens >= this.limits.tokens) out.push(...this.cap('token_cap'))
      if (this.steps - this.progressSteps >= this.t.progressSteps) out.push(this.emitProgress(now))
    }
    if (e.kind === 'tool_call') {
      this.toolCalls += 1
      this.tools[e.tool] = (this.tools[e.tool] ?? 0) + 1
      this.lastTool = e.tool
      this.repeats = e.argsDigest === this.lastDigest ? this.repeats + 1 : 1
      this.lastDigest = e.argsDigest
      if (this.repeats >= this.t.repeatedToolCalls) {
        out.push({
          kind: 'stall',
          signal: 'repeated_tool_call',
          detail: `${e.tool} called ${this.repeats} times in a row with the same input`,
        })
        this.repeats = 0
      }
    }
    return out
  }

  tick(now: number): WatchAction[] {
    const out: WatchAction[] = []
    if (this.executing && !this.silenceFlagged && now - this.lastEventAt >= this.t.idleMs) {
      this.silenceFlagged = true
      out.push({
        kind: 'stall',
        signal: 'idle',
        detail: `no harness events for ${now - this.lastEventAt} ms`,
      })
    }
    if (now - this.startedAt >= this.limits.wallClockMs) out.push(...this.cap('time_cap'))
    if (now - this.progressAt >= this.t.progressMs) out.push(this.emitProgress(now))
    return out
  }

  diff(lines: number): void {
    if (lines !== this.diffLines) this.diffChangedAt = this.steps
    this.diffLines = lines
    if (lines > 0) this.noDiff = 'done'
  }

  progress(): Progress {
    return {
      steps: this.steps,
      tool_calls: this.toolCalls,
      tokens: this.tokens,
      ...(this.diffLines === undefined ? {} : { diff_lines: this.diffLines }),
      ...(this.lastTool === undefined ? {} : { last_tool: this.lastTool }),
      ...(this.toolCalls === 0 ? {} : { tools: { ...this.tools } }),
    }
  }

  private noDiffStep(): WatchAction[] {
    const t = this.limits.noDiff
    if (this.noDiff !== 'watching' || !t) return []
    if (this.steps < t.steps && this.tokens < t.tokens) return []
    this.noDiff = 'nudged'
    this.noDiffTurns = this.limits.graceTurns
    return [{ kind: 'no_diff', act: 'nudge', steps: this.steps, tokens: this.tokens }]
  }

  private noDiffTurnEnded(): WatchAction[] {
    if (this.noDiff !== 'nudged') return []
    this.noDiffTurns -= 1
    if (this.noDiffTurns > 0) return []
    this.noDiff = 'done'
    return [{ kind: 'no_diff', act: 'stop', steps: this.steps, tokens: this.tokens }]
  }

  private cap(reason: CapReason): WatchAction[] {
    if (this.capped) return []
    this.capped = true
    return [{ kind: 'cap', reason }]
  }

  private emitProgress(now: number): WatchAction {
    this.progressAt = now
    this.progressSteps = this.steps
    return { kind: 'progress', data: this.progress() }
  }
}
