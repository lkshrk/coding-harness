import type { LinearWorkspace } from '../linear/workspace'
import type { ConfigError } from './errors'
import { formatPath } from './errors'
import { type Config, LIFECYCLE_STATES, teamStatuses } from './schema'

const err = (path: PropertyKey[], message: string, hint?: string): ConfigError => ({
  path: formatPath(path),
  message,
  ...(hint ? { hint } : {}),
})

export function validateAgainstWorkspace(config: Config, linear: LinearWorkspace): ConfigError[] {
  const errors: ConfigError[] = []
  const teams = new Map(linear.teams.map((t) => [t.key, t]))
  const noTeam = (key: string) => `no team ${key} in workspace ${linear.organization.urlKey}`
  const labels = linear.labels.filter((l) => !l.isGroup)
  const hasLabel = (name: string, teamId?: string | null) =>
    labels.some((l) => l.name === name && (l.teamId === null || teamId === undefined || l.teamId === teamId))

  config.linear.teams.forEach((team, i) => {
    const found = teams.get(team.key)
    if (!found) {
      errors.push(err(['linear', 'teams', i, 'key'], noTeam(team.key)))
      return
    }
    for (const state of LIFECYCLE_STATES) {
      const status = teamStatuses(config, team.key)[state]
      if (!found.statuses.some((s) => s.name === status)) {
        errors.push(
          err(
            ['linear', 'teams', i, 'statuses', state],
            `status ${status} not found`,
            'nightshift doctor --apply creates it',
          ),
        )
      }
    }
  })

  config.linear.exclude_labels.forEach((label, i) => {
    if (!hasLabel(label))
      errors.push(err(['linear', 'exclude_labels', i], `no label '${label}' in the workspace`))
  })

  config.projects.forEach((project, i) => {
    const { match } = project
    const team = teams.get(match.team)
    if (!team) errors.push(err(['projects', i, 'match', 'team'], noTeam(match.team)))
    if (
      'initiative' in match &&
      linear.initiatives &&
      !linear.initiatives.some((x) => x.name === match.initiative)
    ) {
      errors.push(err(['projects', i, 'match', 'initiative'], `no initiative '${match.initiative}'`))
    }
    if ('project' in match && !linear.projects.some((x) => x.name === match.project)) {
      errors.push(err(['projects', i, 'match', 'project'], `no project '${match.project}'`))
    }
    if ('label' in match && !hasLabel(match.label, team?.id ?? null)) {
      errors.push(
        err(
          ['projects', i, 'match', 'label'],
          `no label '${match.label}' in team ${match.team} or the workspace`,
        ),
      )
    }
  })
  return errors
}
