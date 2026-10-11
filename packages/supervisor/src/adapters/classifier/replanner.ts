import {
  type AgentDef,
  activeProfile,
  type Config,
  fence,
  type Gateway,
  runSingleCall,
} from '@nightshift/core'
import type { Replanner, ReplanReport, ReplanRequest } from '../../ports'
import type { SingleCall } from '../../ports/context'
import type { Run } from '../../state/runs'

type ReplannerDeps = {
  config: () => Config
  agents: ReadonlyMap<string, AgentDef>
  gateway: () => Promise<Gateway>
  runs: (issue: string) => Run[]
  call?: SingleCall
  out?: (line: string) => void
}

type FinishReport = {
  status?: string
  summary?: string
  concerns?: string[]
  changed_files?: string[]
  blocker?: { reason?: string }
}

function attempt(run: Run): string {
  const f = (run.finish ?? {}) as FinishReport
  return [
    `attempt ${run.attempt} (${run.agent}): ${run.state}${run.failure ? `, ${run.failure}` : ''}`,
    f.summary ? `summary: ${f.summary}` : '',
    f.concerns?.length ? `concerns: ${f.concerns.join('; ')}` : '',
    f.blocker?.reason ? `blocker: ${f.blocker.reason}` : '',
    f.changed_files?.length ? `changed (${f.changed_files.length} files): ${f.changed_files.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function replannerInput(r: ReplanRequest, history: Run[]): string {
  return [
    fence('ISSUE', `# ${r.issue.title}\n\n${r.issue.description}`),
    fence(
      'FAILURE',
      [
        `class: ${r.classification.class}`,
        `evidence: ${r.classification.evidence ?? r.detail ?? 'none'}`,
      ].join('\n'),
    ),
    fence('HISTORY', history.map(attempt).join('\n\n')),
  ].join('\n\n')
}

export function agentReplanner(d: ReplannerDeps): Replanner {
  return {
    async replan(r): Promise<ReplanReport | null> {
      const out = d.out ?? console.error
      const def = d.agents.get('replanner')
      if (!def) {
        out(`${r.run.issue}: replanner agent unavailable`)
        return null
      }
      const result = await (d.call ?? runSingleCall)<ReplanReport>(
        def,
        replannerInput(r, d.runs(r.run.issue)),
        {
          profile: activeProfile(d.config().profiles, r.run.profile),
          gateway: await d.gateway(),
          sessionId: `${r.run.id}-replanner`,
        },
      )
      if (result.ok) return result.output
      out(`${r.run.issue}: replanner ${result.reason}: ${result.detail}`)
      return null
    },
  }
}
