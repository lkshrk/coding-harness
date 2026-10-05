import { validateIssue } from '@nightshift/core'
import type { GateEventData } from '../gates/report'
import type { ReviewFinding } from '../gates/review'
import type { IssueSnapshot } from '../ports'

export type PullRequestBodyInput = {
  issue: IssueSnapshot
  runId: string
  finish: { summary?: string; concerns?: string[] } | null
  gates: readonly GateEventData[]
  review: { verdict: 'pass' | 'fail'; findings: ReviewFinding[] } | null
  unreviewed: string | null
  riskPaths: readonly string[]
  traceUrl?: string
}

export function pullRequestTitle(issue: Pick<IssueSnapshot, 'identifier' | 'title'>): string {
  return `${issue.identifier}: ${issue.title}`
}

export function pullRequestBody(i: PullRequestBodyInput): string {
  const parsed = validateIssue(i.issue.description, { allowNoDesign: true })
  const acceptance = parsed.ok ? parsed.issue.acceptance : []
  const parts: string[] = [
    '## Summary',
    i.finish?.summary?.trim() || '(no summary)',
    ...(i.finish?.concerns?.length ? ['', 'Concerns:', ...i.finish.concerns.map((c) => `- ${c}`)] : []),
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
      parts.push(`- **${f.severity}** \`${where}\`: ${f.message}`)
    }
  }
  if (i.riskPaths.length) {
    parts.push('', '## Risk paths', 'Draft: this change touches configured risk paths.')
    parts.push(...i.riskPaths.map((p) => `- \`${p}\``))
  }
  parts.push('', '## Trace', i.traceUrl ? `${i.traceUrl} (session \`${i.runId}\`)` : `Session \`${i.runId}\``)
  return `${parts.join('\n')}\n`
}
