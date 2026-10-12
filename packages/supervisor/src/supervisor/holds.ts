import { lifecycleOf, type ViewOptions } from '../policy/stages'
import type { Intent } from '../policy/transition'
import type { Awaiting, DependentRef } from '../ports'
import { type By, ControlError } from '../ports/control'
import type { DependentsResponse as Dependents } from '../ports/generated/control'
import { coveredIssues, heldIssues, setCovered, setHeld } from '../state/coverage'
import type { SupervisorRuntime } from './runtime'

export type HoldsPeers = { applyIntent: (identifier: string, intent: Intent) => Promise<void> }

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

  /** Walks every open issue `issue` blocks, transitively; only those in its team and project are coverable. */
  async dependents(issue: string): Promise<Dependents> {
    const root = await this.rt.deps.linear.issue(issue)
    if (!root) throw new ControlError('not_found', `unknown issue ${issue}`)
    const project = root.project?.id ?? null
    const issues = [root.identifier]
    const other: Dependents['other'] = []
    const seen = new Set(issues)
    const queue = [root.identifier]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const d of (await this.rt.deps.linear.blocks(next)) ?? []) {
        if (seen.has(d.identifier)) continue
        seen.add(d.identifier)
        if (this.closed(d)) continue
        queue.push(d.identifier)
        if (d.team !== root.team) other.push({ issue: d.identifier, reason: 'other team' })
        else if (d.project !== project) other.push({ issue: d.identifier, reason: 'other project' })
        else issues.push(d.identifier)
      }
    }
    return { issues, other }
  }

  private closed(d: DependentRef): boolean {
    if (d.stateType !== undefined) return d.stateType === 'completed' || d.stateType === 'canceled'
    const state = lifecycleOf(this.rt.config(), d.team, d.status)
    return state === 'done' || state === 'canceled'
  }

  private setCoverage(issue: string, covered: boolean, by: By): void {
    if (!covered && this.awaiting(issue)) this.setAwaiting(issue, null)
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
    await this.peers.applyIntent(issue, { kind: 'heldForUser', awaiting })
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
