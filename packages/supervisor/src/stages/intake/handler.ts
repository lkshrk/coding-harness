import type { Config, IntakeOutput } from '@nightshift/core'
import type { StageHandler, StageWork } from '../../ports'
import type { IntakeDeps } from './duplicates'
import { runIntake } from './intake'

export const INTAKE = 'intake'

export interface IntakeCallbacks {
  completeStage(identifier: string): Promise<void>
  holdStage(identifier: string, stage: string, reason: string, comment: string): Promise<void>
}

export type IntakeHandlerDeps = IntakeDeps & { callbacks: () => IntakeCallbacks }

export function projectsText(config: Config): string {
  return config.projects
    .map(({ match, repositories, pipeline }) => {
      const name =
        'project' in match
          ? match.project
          : 'initiative' in match
            ? `initiative ${match.initiative}`
            : `label ${match.label}`
      return `${name} (team ${match.team}): pipeline ${pipeline}; repositories: ${repositories.join(', ')}`
    })
    .join('\n')
}

function holdComment(output: IntakeOutput): { reason: string; comment: string } | null {
  switch (output.decision) {
    case 'accept':
      return null
    case 'duplicate':
      return {
        reason: 'duplicate',
        comment: `Intake: this looks like a duplicate of ${output.duplicate_of}. Close it as a duplicate, or move it to Todo to run intake again.`,
      }
    case 'needs_info':
      return {
        reason: 'needs_info',
        comment: `Intake: more information is needed before work can start:\n\n${output.missing_info.map((q) => `- ${q}`).join('\n')}\n\nAnswer in the description, then move the issue to Todo.`,
      }
    case 'propose_decline':
      return {
        reason: 'propose_decline',
        comment:
          'Intake proposes declining this issue: it is outside every project or already covered. Cancel it, or move it to Todo to run intake again.',
      }
  }
}

/** Runs the intake single call; accept advances the issue, any other decision holds it for you. */
export class IntakeHandler implements StageHandler {
  constructor(private readonly d: IntakeHandlerDeps) {}

  handles(stage: string): boolean {
    return stage === INTAKE
  }

  async run(work: StageWork): Promise<void> {
    if (work.stage !== INTAKE) return
    const id = work.issue.identifier
    const result = await runIntake(this.d, work.issue, projectsText(this.d.config()))
    if (!result.ok) throw new Error(`intake ${result.reason}: ${result.detail}`)
    const hold = holdComment(result.output)
    const cb = this.d.callbacks()
    if (hold) await cb.holdStage(id, INTAKE, hold.reason, hold.comment)
    else await cb.completeStage(id)
  }
}

/** Routes each role stage to the handler that owns it. */
export class StageRouter implements StageHandler {
  constructor(private readonly routes: Readonly<Record<string, StageHandler>>) {}

  handles(stage: string): boolean {
    return Object.hasOwn(this.routes, stage)
  }

  async run(work: StageWork): Promise<void> {
    const handler = Object.hasOwn(this.routes, work.stage) ? this.routes[work.stage] : undefined
    if (!handler) throw new Error(`no handler for stage ${work.stage}`)
    await handler.run(work)
  }
}
