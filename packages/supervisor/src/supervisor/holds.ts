import type { ViewOptions } from '../policy/stages'
import type { Awaiting, IssueUpdate } from '../ports'
import type { By } from '../ports/control'
import { coveredIssues, heldIssues, setCovered, setHeld } from '../state/coverage'
import type { SupervisorRuntime } from './runtime'

export type HoldsPeers = { writeStatus: (identifier: string, change: IssueUpdate) => Promise<void> }

export class Holds {
  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly peers: HoldsPeers,
  ) {}

  covered(): string[] {
    return coveredIssues(this.rt.deps.db)
  }

  cover(issue: string, by: By = 'supervisor'): void {
    this.setCoverage(issue, true, by)
  }

  uncover(issue: string, by: By = 'supervisor'): void {
    this.setCoverage(issue, false, by)
  }

  private setCoverage(issue: string, covered: boolean, by: By): void {
    if (this.coveredSet().has(issue) === covered) return
    setCovered(this.rt.deps.db, issue, covered)
    this.rt.log.append({ type: 'COVERAGE_CHANGED', issue, data: { covered, by } })
  }

  coveredSet(): Set<string> {
    return new Set(coveredIssues(this.rt.deps.db))
  }

  viewOptions(issue: string): ViewOptions {
    return { covered: this.coveredSet().has(issue), awaiting: this.awaitingMap()[issue] ?? null }
  }

  awaiting(issue: string): Awaiting | null {
    return this.awaitingMap()[issue] ?? null
  }

  private awaitingMap(): Record<string, Awaiting> {
    return this.rt.metaMap<Awaiting>('awaiting')
  }

  setAwaiting(issue: string, value: Awaiting | null): void {
    const map = this.awaitingMap()
    if (value) map[issue] = value
    else delete map[issue]
    this.rt.setMeta('awaiting', JSON.stringify(map))
  }

  async holdForYou(issue: string, awaiting: Awaiting): Promise<void> {
    this.setAwaiting(issue, awaiting)
    await this.peers.writeStatus(issue, { status: 'blocked' })
  }

  async holdStage(issue: string, stage: string, reason: string, comment: string): Promise<void> {
    const current = this.awaiting(issue)
    if (current?.stage === stage && current.reason === reason) return
    await this.rt.postOnce(issue, `${stage}:${reason}`, comment)
    await this.holdForYou(issue, { kind: 'escalated', stage, reason })
    await this.rt.notify(`${stage}: ${reason}`, issue, {
      kind: 'blocked',
      action: `Answer on ${issue}, then move it to Todo to run ${stage} again`,
    })
  }

  held(): string[] {
    return heldIssues(this.rt.deps.db)
  }

  hold(issue: string, by: By = 'supervisor'): void {
    if (this.held().includes(issue)) return
    setHeld(this.rt.deps.db, issue, true)
    this.rt.log.append({ type: 'DISPATCH_PAUSED', issue, data: { reason: `${issue} held`, by } })
  }

  unhold(issue: string, by: By = 'supervisor'): void {
    if (!this.held().includes(issue)) return
    setHeld(this.rt.deps.db, issue, false)
    this.rt.log.append({ type: 'DISPATCH_RESUMED', issue, data: { reason: `${issue} released`, by } })
  }
}
