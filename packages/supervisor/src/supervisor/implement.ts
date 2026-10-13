import { LABEL_GROUPS, profileEntries } from '@nightshift/core'
import { validatePlan } from '../policy/plan'
import { labelValue } from '../policy/stages'
import type { Intent } from '../policy/transition'
import type { IssueSnapshot } from '../ports'
import { type By, ControlError } from '../ports/control'
import type { ImplementRequest, ImplementResponse } from '../ports/generated/control'
import type { SupervisorRuntime } from './runtime'

export type ImplementPeers = {
  cover: (issue: string, by: By) => void
  refresh: (identifier: string) => Promise<void>
  applyIntent: (identifier: string, intent: Intent) => Promise<void>
}

const IMPLEMENTATION = 'implementation'

/** Hands a project's open issues over: validates its plan, records merge mode and profile, releases ready issues. */
export async function implementProject(
  rt: SupervisorRuntime,
  peers: ImplementPeers,
  req: ImplementRequest,
  by: By,
): Promise<ImplementResponse> {
  const config = rt.config()
  const linear = rt.deps.linear
  const project = (await linear.workspace()).projects.find((p) => p.name === req.project)
  if (!project) throw new ControlError('not_found', `no Linear project '${req.project}'`)
  const teams = [
    ...new Set(
      config.projects.flatMap((p) =>
        'project' in p.match && p.match.project === project.name ? [p.match.team] : [],
      ),
    ),
  ]
  if (!teams.length) throw new ControlError('refused', `${project.name} is not a configured project`)
  if (req.profile !== undefined && !profileEntries(config.profiles).some(([n]) => n === req.profile))
    throw new ControlError('refused', `no profile '${req.profile}'`)

  const closedSince = rt.now().toISOString()
  const issues = (
    await Promise.all(teams.map((team) => linear.candidates({ team, project: project.id, closedSince })))
  ).flat()
  const plan = validatePlan(issues, config)
  if (plan.errors.length) throw new ControlError('refused', plan.errors.join('\n'))

  await linear.setProjectLabel(project.id, LABEL_GROUPS.merge, req.merge_mode)
  if (req.profile !== undefined)
    rt.deps.db
      .query(
        `INSERT INTO session_choices (project, key, value, chosen_at) VALUES (?, 'profile', ?, ?)
         ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, chosen_at = excluded.chosen_at`,
      )
      .run(project.id, req.profile, closedSince)

  const byId = new Map<string, IssueSnapshot>(issues.map((i) => [i.identifier, i]))
  const ready = new Set(plan.ready)
  for (const id of [...plan.ready, ...plan.waiting]) {
    peers.cover(id, by)
    await peers.refresh(id)
    if (labelValue(byId.get(id)?.labels ?? [], LABEL_GROUPS.stage) === null)
      await peers.applyIntent(id, { kind: 'stageEntered', stage: IMPLEMENTATION })
    // Only a Backlog issue moves to Todo; one already queued or running keeps its status.
    if (ready.has(id)) await peers.applyIntent(id, { kind: 'unblocked' })
  }
  return { ready: plan.ready, waiting: plan.waiting, warnings: plan.warnings }
}
