import {
  activeProfile,
  fence,
  type IntakeOutput,
  runSingleCall,
  type SingleCallResult,
} from '@nightshift/core'
import type { IssueSnapshot } from '../../ports/ports'
import { findDuplicates, type IntakeDeps, issueText } from './duplicates'

export function intakeInput(
  issue: IssueSnapshot,
  similar: readonly IssueSnapshot[],
  projects: string,
): string {
  return `${[
    fence('ISSUE', issueText(issue)),
    fence('PROJECTS', projects),
    fence('SIMILAR', similar.map(issueText).join('\n\n')),
  ].join('\n\n')}\n`
}

export async function runIntake(
  d: IntakeDeps,
  issue: IssueSnapshot,
  projects: string,
): Promise<SingleCallResult<IntakeOutput>> {
  const def = d.agents.get('intake')
  if (!def) throw new Error('no intake agent loaded')
  const similar = await findDuplicates(d, issue)
  const config = d.config()
  const result = await (d.call ?? runSingleCall)<IntakeOutput>(def, intakeInput(issue, similar, projects), {
    profile: activeProfile(config.profiles),
    gateway: await d.gateway(),
  })
  if (
    result.ok &&
    result.output.duplicate_of !== null &&
    !similar.some((c) => c.identifier === result.output.duplicate_of)
  ) {
    return {
      ok: false,
      reason: 'invalid_output',
      detail: 'duplicate_of must identify a judged candidate in SIMILAR',
      trace: result.trace,
    }
  }
  return result
}
