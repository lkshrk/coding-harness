import { validateIssue } from '@nightshift/core'
import { filesOverlap } from '../policy/ready'
import { viewIssue } from '../policy/stages'
import type { Classification, IssueSnapshot, ReplanIssue, ReplanReport } from '../ports'
import type { Run } from '../state/runs'
import type { RunFlow, SupervisorRuntime } from './runtime'

export type Proposal = {
  comment: string
  run: string
  action: 'split' | 'create_blocker'
  stage: string
  issues: ReplanIssue[]
  approved?: boolean
  /** Identifiers of the children created so far, by index into `issues`. */
  created?: string[]
  /** Children whose `blocks` relation to the issue is confirmed. */
  linked?: string[]
}

const PROPOSALS = 'proposals'
const REPLANNED = ['split', 'create_blocker', 'escalate_lead']

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** Errors that make a replanner report unusable for `original`; empty when it can be proposed. */
export function proposalErrors(original: string, report: ReplanReport): string[] {
  const issues =
    report.action === 'split' ? (report.sub_issues ?? []) : report.blocker ? [report.blocker] : []
  if (report.action === 'escalate_lead') return ['the replanner escalated to the lead']
  if (report.action === 'split' && (issues.length < 2 || issues.length > 6))
    return [`a split needs 2–6 sub-issues, got ${issues.length}`]
  if (issues.length === 0) return ['no blocker issue']
  const errors: string[] = []
  const parsed = issues.flatMap((i) => {
    const r = validateIssue(i.description)
    if (!r.ok) errors.push(...r.errors.map((e) => `${i.title}: ${e.message}`))
    return r.ok ? [r.issue] : []
  })
  if (errors.length || report.action !== 'split') return errors
  const base = validateIssue(original, { allowNoDesign: true })
  if (!base.ok) return errors
  const files = parsed.flatMap((p) => p.files)
  for (const f of base.issue.files)
    if (!files.some((c) => filesOverlap([f], [c]))) errors.push(`no sub-issue covers file ${f}`)
  const criteria = new Set(parsed.flatMap((p) => p.acceptance.map(norm)))
  for (const a of base.issue.acceptance)
    if (!criteria.has(norm(a))) errors.push(`no sub-issue covers criterion: ${a}`)
  return errors
}

export function proposalComment(issue: string, report: ReplanReport): string {
  const issues =
    report.action === 'split' ? (report.sub_issues ?? []) : report.blocker ? [report.blocker] : []
  const rows = issues.map((i) => {
    const parsed = validateIssue(i.description)
    const files = parsed.ok ? parsed.issue.files.map((f) => `\`${f}\``).join(', ') : ''
    return `| ${cell(i.title)} | – | ${cell(files)} | ${issue} |`
  })
  const what =
    report.action === 'split' ? `Split ${issue} into ${issues.length} issues` : `Add a blocker for ${issue}`
  return [
    `Proposal: ${what}. ${report.reason}`,
    '',
    '| title | estimate | files | blocks |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `Reply \`approve\` to create ${issues.length === 1 ? 'it' : 'them'} (\`ns answer ${issue} approve\`), anything else rejects.`,
  ].join('\n')
}

export class Replan {
  constructor(
    private readonly rt: SupervisorRuntime,
    private readonly flow: RunFlow,
  ) {}

  proposal(issue: string): Proposal | undefined {
    return this.rt.metaMap<Proposal>(PROPOSALS)[issue]
  }

  private store(issue: string, value: Proposal | null): void {
    const map = this.rt.metaMap<Proposal>(PROPOSALS)
    if (value) map[issue] = value
    else delete map[issue]
    this.rt.setMeta(PROPOSALS, JSON.stringify(map))
  }

  /** Runs the replanner and posts its proposal; false leaves the failure to the usual escalation. */
  async propose(run: Run, c: Classification, detail?: string): Promise<boolean> {
    const replanner = this.rt.deps.replanner
    if (!replanner || !REPLANNED.includes(c.action)) return false
    const issue: IssueSnapshot | null =
      this.rt.cache.get(run.issue) ?? (await this.rt.deps.linear.issue(run.issue))
    if (!issue) return false
    let report: ReplanReport | null
    try {
      report = await replanner.replan({ run, issue, classification: c, ...(detail ? { detail } : {}) })
    } catch (e) {
      console.error(`${run.issue}: replanner failed: ${(e as Error).message}`)
      return false
    }
    if (!report) return false
    if (report.action === 'escalate_lead') {
      await this.rt.postOnce(
        run.issue,
        `replan:${run.id}`,
        `Replanner: escalate to the lead. ${report.reason}`,
      )
      return false
    }
    const errors = proposalErrors(issue.description, report)
    if (errors.length) {
      console.error(`${run.issue}: replan not proposed: ${errors.join('; ')}`)
      return false
    }
    const issues = report.action === 'split' ? (report.sub_issues ?? []) : [report.blocker as ReplanIssue]
    const comment = await this.rt.postOnce(run.issue, `replan:${run.id}`, proposalComment(run.issue, report))
    const stage = viewIssue(issue, this.rt.config())?.stage ?? ''
    this.store(run.issue, { comment: comment.id, run: run.id, action: report.action, stage, issues })
    this.rt.deps.db
      .query(
        'INSERT OR IGNORE INTO questions (comment, issue, run, asked_to, asked_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(comment.id, run.issue, run.id, 'user', this.rt.now().toISOString())
    await this.flow.holdForYou(run.issue, { kind: 'split_proposed', stage })
    await this.rt.notify(`replan proposed (${report.action})`, run.issue, {
      kind: 'question',
      context: [`${issues.length} issue(s): ${issues.map((i) => i.title).join('; ')}`],
      question: { comment: comment.id, text: 'Approve the proposal?', options: ['approve', 'reject'] },
    })
    return true
  }

  /** Applies the answer to a stored proposal; false when the comment holds no proposal. */
  async answered(issue: string, comment: string, answer: string): Promise<boolean> {
    const p = this.proposal(issue)
    if (!p || p.comment !== comment) return false
    if (!/^approve\b/i.test(answer.trim())) {
      this.store(issue, null)
      await this.flow.holdForYou(issue, { kind: 'escalated', stage: p.stage, reason: 'replan rejected' })
      return true
    }
    this.store(issue, { ...p, approved: true, created: p.created ?? [], linked: p.linked ?? [] })
    await this.complete(issue)
    return true
  }

  /** Retries approved proposals whose children or relations are not all confirmed yet. */
  async resumeApproved(): Promise<void> {
    for (const [issue, p] of Object.entries(this.rt.metaMap<Proposal>(PROPOSALS)))
      if (p.approved) await this.complete(issue)
  }

  // Progress is stored after every confirmed write so a failed request resumes without duplicates.
  private async complete(issue: string): Promise<void> {
    const p = this.proposal(issue)
    if (!p?.approved) return
    const created = [...(p.created ?? [])]
    const linked = [...(p.linked ?? [])]
    try {
      for (const [n, i] of p.issues.entries()) {
        if (!created[n]) {
          created[n] = await this.rt.deps.linear.createChild(issue, i)
          this.store(issue, { ...p, created, linked })
        }
        const child = created[n] as string
        if (!linked.includes(child)) {
          await this.rt.deps.linear.addBlocks(child, issue)
          linked.push(child)
          this.store(issue, { ...p, created, linked })
        }
      }
    } catch (e) {
      console.error(`${issue}: creating the approved replan failed, retrying: ${(e as Error).message}`)
      return
    }
    await this.rt.postOnce(
      issue,
      `replan-created:${p.run}`,
      `Created ${created.join(', ')}; each blocks ${issue}.`,
    )
    await this.flow.holdForYou(issue, {
      kind: 'escalated',
      stage: p.stage,
      reason: `replanned into ${created.join(', ')}`,
    })
    this.store(issue, null)
    await this.flow.refresh(issue)
  }
}
