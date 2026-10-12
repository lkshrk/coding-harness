import { validateIssue } from '@nightshift/core'
import type { IssueSnapshot } from '../../ports'
import type { GateEventData } from '../gates/report'
import { findingLabel, type ReviewFinding } from '../gates/review'
import { capNotes, type ScreenshotOutcome } from './screenshots'

export type AttemptFinish = { summary?: string; concerns?: string[] } | null

export type AttemptSummary = { attempt: number; headSha: string; finish: AttemptFinish }

export type PullRequestBodyInput = {
  issue: IssueSnapshot
  runId: string
  finish: AttemptFinish
  attempts?: readonly AttemptSummary[]
  gates: readonly GateEventData[]
  review: { verdict: 'pass' | 'fail'; findings: ReviewFinding[] } | null
  unreviewed: string | null
  riskPaths: readonly string[]
  screenshots?: ScreenshotOutcome
  traceUrl?: string
}

export function pullRequestTitle(issue: Pick<IssueSnapshot, 'identifier' | 'title'>): string {
  return `${issue.identifier}: ${issue.title}`
}

function summarySection(i: PullRequestBodyInput): string[] {
  const changed: AttemptSummary[] = []
  for (const a of i.attempts ?? []) if (a.headSha !== changed.at(-1)?.headSha) changed.push(a)
  const [first, ...repairs] = changed.length ? changed : [{ attempt: 0, headSha: '', finish: i.finish }]
  const listed = [first, ...repairs].flatMap((a) => a?.finish?.concerns ?? [])
  const concerns = repairs.length ? [...new Set(listed)] : listed
  return [
    first?.finish?.summary?.trim() || '(no summary)',
    ...(repairs.length
      ? [
          '',
          ...repairs.map(
            (a) =>
              `- Attempt ${a.attempt}: ${a.finish?.summary?.trim().replace(/\s+/g, ' ') || '(no summary)'}`,
          ),
        ]
      : []),
    ...(concerns.length ? ['', 'Concerns:', ...concerns.map((c) => `- ${c}`)] : []),
  ]
}

export function pullRequestBody(i: PullRequestBodyInput): string {
  const parsed = validateIssue(i.issue.description, { allowNoDesign: true })
  const acceptance = parsed.ok ? parsed.issue.acceptance : []
  const parts: string[] = [
    '## Summary',
    ...summarySection(i),
    '',
    '## Acceptance criteria',
    ...(acceptance.length ? acceptance.map((a) => `- [ ] ${a}`) : ['(none listed)']),
    '',
    '## Gates',
    ...(i.gates.length
      ? i.gates.map(
          (g) =>
            `- \`${g.check}\`: ${g.exit_code === 0 ? 'passed' : `failed (exit ${g.exit_code})`} in ${(g.duration_ms / 1000).toFixed(1)}s`,
        )
      : ['(no gate results)']),
    '',
    '## Review',
  ]
  if (i.unreviewed) parts.push(`Unreviewed: ${i.unreviewed}. Merge manually after your own review.`)
  else if (!i.review) parts.push('(no review recorded)')
  else {
    parts.push(`Verdict: ${i.review.verdict}`)
    for (const f of i.review.findings) {
      const where = f.lines ? `${f.file}:${f.lines}` : f.file
      const confidence = f.downgraded ? ` (confidence ${f.confidence})` : ''
      parts.push(`- ${findingLabel(f)} \`${where}\`${confidence}: ${f.message}`)
    }
  }
  if (i.riskPaths.length) {
    parts.push('', '## Risk paths', 'Draft: this change touches configured risk paths.')
    parts.push(...i.riskPaths.map((p) => `- \`${p}\``))
  }
  if (i.screenshots) {
    parts.push('', '## Screenshots')
    if ('reason' in i.screenshots)
      parts.push(
        `Draft: this change touches UI paths, but no screenshots were taken: ${i.screenshots.reason}.`,
      )
    else
      parts.push(
        `Before and after: ${i.screenshots.url}`,
        ...capNotes(i.screenshots.reduced, i.screenshots.dropped),
      )
  }
  parts.push('', '## Trace', i.traceUrl ? `${i.traceUrl} (session \`${i.runId}\`)` : `Session \`${i.runId}\``)
  return `${parts.join('\n')}\n`
}
