import {
  type AcceptorOutput,
  type AgentDef,
  activeProfile,
  type Config,
  type FinishPayload,
  fence,
  type Gateway,
  runSingleCall,
  validateIssue,
} from '@nightshift/core'
import type { IssueSnapshot, LinearPort, StageHandler, StageWork } from '../../ports'
import type { Event, EventFilter } from '../../state/events'
import type { Run } from '../../state/runs'
import type { SingleCall } from '../gates'
import type { GateEventData } from '../gates/report'

export const ACCEPTANCE = 'acceptance'

export interface AcceptanceCallbacks {
  completeStage(identifier: string): Promise<void>
  holdStage(identifier: string, stage: string, reason: string, comment: string): Promise<void>
  log: { since(id: string | null, filter?: EventFilter): Event[] }
  runs: { forIssue(issue: string): Run[] }
  gateResults(runId: string): GateEventData[]
  children(identifier: string): IssueSnapshot[]
}

export type AcceptanceHandlerDeps = {
  config: () => Config
  agents: ReadonlyMap<string, AgentDef>
  gateway: () => Promise<Gateway>
  linear: Pick<LinearPort, 'comment'>
  call?: SingleCall
  callbacks: () => AcceptanceCallbacks
  out?: (line: string) => void
}

type Verdict = AcceptorOutput['criteria'][number]

function criteria(issue: IssueSnapshot): string[] {
  const parsed = validateIssue(issue.description, { allowNoDesign: true })
  if (parsed.ok) return parsed.issue.acceptance
  const section = /^##\s*Acceptance criteria\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(issue.description)?.[1]
  return (section ?? '')
    .split('\n')
    .map((l) => /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l)?.[1]?.trim())
    .filter((l): l is string => !!l)
}

function gateEvents(cb: AcceptanceCallbacks, runs: Run[]): Event[] {
  for (const run of [...runs].reverse()) {
    const events = cb.log.since(null, { run: run.id, types: ['GATE_PASSED', 'GATE_FAILED'] })
    if (events.length > 0) return events
  }
  return []
}

function gatesText(issue: string, events: Event[]): string {
  return events
    .map((e) => {
      const g = e.data as unknown as GateEventData
      return `${issue} ${g.check}: exit code ${g.exit_code}\n${g.output_tail}`
    })
    .join('\n\n')
}

function finishOf(runs: Run[]): Partial<FinishPayload> | undefined {
  return (
    [...runs]
      .reverse()
      .map((r) => r.finish as Partial<FinishPayload> | null)
      .find((f) => f && typeof f === 'object') ?? undefined
  )
}

function issueText(issue: IssueSnapshot, runs: Run[]): string {
  const finish = finishOf(runs)
  return [
    `${issue.identifier}: ${issue.title}`,
    `summary: ${finish?.summary ?? 'no finish report'}`,
    `changed files: ${finish?.changed_files?.join(', ') || 'none recorded'}`,
  ].join('\n')
}

export function acceptanceInput(issue: IssueSnapshot, list: string[], cb: AcceptanceCallbacks): string {
  const issues = [issue, ...cb.children(issue.identifier)]
  const runs = new Map(issues.map((i) => [i.identifier, cb.runs.forIssue(i.identifier)]))
  const gates = issues
    .map((i) => gatesText(i.identifier, gateEvents(cb, runs.get(i.identifier) ?? [])))
    .filter(Boolean)
  return `${[
    fence('CRITERIA', list.join('\n')),
    fence('GATES', gates.join('\n\n')),
    fence('ISSUES', issues.map((i) => issueText(i, runs.get(i.identifier) ?? [])).join('\n\n')),
  ].join('\n\n')}\n`
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

function verdictComment(verdicts: Verdict[]): string {
  return [
    'Acceptance verdict:',
    '',
    '| criterion | verdict | evidence |',
    '| --- | --- | --- |',
    ...verdicts.map((v) => `| ${cell(v.criterion)} | ${v.verdict} | ${cell(v.evidence)} |`),
  ].join('\n')
}

const listed = (verdicts: Verdict[]) => verdicts.map((v) => `- ${v.criterion}: ${v.evidence}`).join('\n')

/** Judges a parent issue against its acceptance criteria with one acceptor call and holds it for you. */
export class AcceptanceHandler implements StageHandler {
  constructor(private readonly d: AcceptanceHandlerDeps) {}

  handles(stage: string): boolean {
    return stage === ACCEPTANCE
  }

  async run(work: StageWork): Promise<void> {
    if (work.stage !== ACCEPTANCE) return
    const id = work.issue.identifier
    const cb = this.d.callbacks()
    const list = criteria(work.issue)
    if (list.length === 0) {
      await cb.holdStage(
        id,
        ACCEPTANCE,
        'no_criteria',
        'Acceptance: the description has no `## Acceptance criteria` list items to judge. Add them, then move the issue to Todo.',
      )
      return
    }
    const def = this.d.agents.get('acceptor')
    if (!def) throw new Error('no acceptor agent loaded')
    const result = await (this.d.call ?? runSingleCall)<AcceptorOutput>(
      def,
      acceptanceInput(work.issue, list, cb),
      { profile: activeProfile(this.d.config().profiles), gateway: await this.d.gateway() },
    )
    if (!result.ok) throw new Error(`acceptor ${result.reason}: ${result.detail}`)
    const verdicts = result.output.criteria
    await this.d.linear.comment(id, verdictComment(verdicts))
    const notMet = verdicts.filter((v) => v.verdict === 'not_met')
    const unverifiable = verdicts.filter((v) => v.verdict === 'unverifiable')
    this.d.out?.(
      `${id}: acceptance ${verdicts.length - notMet.length - unverifiable.length}/${verdicts.length} met`,
    )
    if (notMet.length > 0)
      await cb.holdStage(
        id,
        ACCEPTANCE,
        'not_met',
        `Acceptance: these criteria are not met:\n\n${listed(notMet)}\n\nFix them, then move the issue to Todo to judge it again.`,
      )
    else if (unverifiable.length > 0)
      await cb.holdStage(
        id,
        ACCEPTANCE,
        'unverifiable',
        `Acceptance: no recorded evidence decides these criteria:\n\n${listed(unverifiable)}\n\nCheck them yourself and move the issue on, or move it to Todo to judge it again.`,
      )
    else await cb.completeStage(id)
  }
}
