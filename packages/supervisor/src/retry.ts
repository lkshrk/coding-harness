export type RetryEntry = { issue: string; reason: string; dueAt: number; count: number }

export class RetryQueue {
  private readonly entries = new Map<string, RetryEntry>()
  private readonly counts = new Map<string, number>()
  private readonly baseMs: number
  private readonly maxMs: number

  constructor(opts: { baseMs: number; maxMs: number }) {
    this.baseMs = opts.baseMs
    this.maxMs = opts.maxMs
  }

  schedule(issue: string, reason: string, now: number): RetryEntry {
    const count = (this.counts.get(issue) ?? 0) + 1
    this.counts.set(issue, count)
    const delay = Math.min(this.baseMs * 2 ** (count - 1), this.maxMs)
    const entry = { issue, reason, dueAt: now + delay, count }
    this.entries.set(issue, entry)
    return entry
  }

  due(now: number): RetryEntry[] {
    return [...this.entries.values()].filter((e) => e.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt)
  }

  has(issue: string): boolean {
    return this.entries.has(issue)
  }

  take(issue: string): void {
    this.entries.delete(issue)
  }

  reset(issue: string): void {
    this.entries.delete(issue)
    this.counts.delete(issue)
  }
}
