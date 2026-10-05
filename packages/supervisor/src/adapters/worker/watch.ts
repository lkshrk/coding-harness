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

export type WatchAction =
  | { kind: 'progress'; data: Progress }
  | { kind: 'stall'; signal: StallSignal; detail: string }
  | { kind: 'cap'; reason: CapReason }

export class Watcher {
  private steps = 0
  private toolCalls = 0
  private tokens = 0
  private lastTool: string | undefined
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

  constructor(
    private readonly limits: WorkerStart['limits'],
    private readonly t: WatchThresholds,
    private readonly startedAt: number,
  ) {
    this.lastEventAt = startedAt
    this.progressAt = startedAt
  }

  observe(e: HarnessEvent, now: number): WatchAction[] {
    if (e.kind === 'idle') {
      this.executing = false
      return []
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
      if (this.steps >= this.limits.steps) out.push(...this.cap('step_cap'))
      if (this.tokens >= this.limits.tokens) out.push(...this.cap('token_cap'))
      if (this.steps - this.progressSteps >= this.t.progressSteps) out.push(this.emitProgress(now))
    }
    if (e.kind === 'tool_call') {
      this.toolCalls += 1
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
  }

  progress(): Progress {
    return {
      steps: this.steps,
      tool_calls: this.toolCalls,
      tokens: this.tokens,
      ...(this.diffLines === undefined ? {} : { diff_lines: this.diffLines }),
      ...(this.lastTool === undefined ? {} : { last_tool: this.lastTool }),
    }
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
