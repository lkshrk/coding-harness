import { type Config, LABEL_GROUPS, teamStatuses, validateIssue } from '@nightshift/core'
import type { Awaiting, IssueSnapshot, LifecycleState, MergeMode } from '../ports'
import { selectAgent } from './selection'

export type IssueView = {
  snapshot: IssueSnapshot
  project: Config['projects'][number]
  pipeline: string[]
  lifecycle: LifecycleState | null
  stage: string | null
  awaiting: Awaiting | null
  issueType: string | null
  repository: string | null
  mergeMode: MergeMode | null
  files: string[]
  templateErrors: string[]
}

export type AgentKind = 'worker' | 'single_call' | 'interactive'

export type DecideContext = { agentKind: (agent: string) => AgentKind | undefined }

export type Decision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'enter'; stage: string; from?: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'advance'; stage: string }
  | { kind: 'release'; stage: string }
  | { kind: 'dispatch'; agent: string }
  | { kind: 'running' }
  | { kind: 'role'; stage: string; agent: string | undefined }

const MERGE_MODES: readonly MergeMode[] = ['manual', 'auto', 'feature-branch']

export const IMPLEMENTATION = 'implementation'
export const VERIFICATION = 'verification'
export const INTEGRATION = 'integration'

export function labelValue(labels: readonly string[], group: string): string | null {
  const prefix = `${group}:`
  const hit = labels.find((l) => l.startsWith(prefix))
  return hit === undefined ? null : hit.slice(prefix.length)
}

const hasLabel = (labels: readonly string[], name: string) => {
  const wanted = name.toLowerCase()
  return labels.some((l) => {
    const label = l.toLowerCase()
    return label === wanted || label.endsWith(`:${wanted}`)
  })
}

export function optedIn(issue: IssueSnapshot, config: Config): boolean {
  const { delegated, labels } = config.linear.act_on
  return (delegated && issue.delegated) || labels.some((l) => hasLabel(issue.labels, l))
}

export function lifecycleOf(config: Config, team: string, status: string): LifecycleState | null {
  const hits = Object.entries(teamStatuses(config, team))
    .filter(([, name]) => name === status)
    .map(([state]) => state as LifecycleState)
  return hits.find((s) => s !== 'triage') ?? hits[0] ?? null
}

function matchProject(issue: IssueSnapshot, config: Config): Config['projects'][number] | undefined {
  return config.projects.find(({ match }) => {
    if (match.team !== issue.team) return false
    if ('project' in match) return issue.project?.name === match.project
    if ('initiative' in match) return issue.project?.initiatives.includes(match.initiative) ?? false
    return hasLabel(issue.labels, match.label)
  })
}

export type ViewOptions = { covered?: boolean; awaiting?: Awaiting | null }

export function viewIssue(issue: IssueSnapshot, config: Config, opts: ViewOptions = {}): IssueView | null {
  const covered = opts.covered ?? false
  if (!covered && !optedIn(issue, config)) return null
  if (config.linear.exclude_labels.some((l) => hasLabel(issue.labels, l))) return null
  const project = matchProject(issue, config)
  if (!project) return null
  const issueType = labelValue(issue.labels, 'type')?.toLowerCase() ?? null
  const pipeline =
    (issueType ? config.pipelines[issueType] : undefined) ?? config.pipelines[project.pipeline] ?? []
  const repoLabel = labelValue(issue.labels, LABEL_GROUPS.repo)
  const repository =
    project.repositories.length === 1
      ? (project.repositories[0] ?? null)
      : repoLabel && project.repositories.includes(repoLabel)
        ? repoLabel
        : null
  const merge = labelValue(issue.project?.labels ?? [], LABEL_GROUPS.merge)
  const template = validateIssue(issue.description, { allowNoDesign: !pipeline.includes('design') })
  return {
    snapshot: issue,
    project,
    pipeline: [...pipeline],
    lifecycle: lifecycleOf(config, issue.team, issue.status),
    stage: labelValue(issue.labels, LABEL_GROUPS.stage),
    awaiting: opts.awaiting ?? null,
    issueType,
    repository,
    mergeMode: MERGE_MODES.includes(merge as MergeMode) ? (merge as MergeMode) : null,
    files: template.ok ? template.issue.files : [],
    templateErrors: template.ok ? [] : template.errors.map((e) => e.message),
  }
}

export function nextStage(config: Config, pipeline: readonly string[], stage: string): string | null {
  const at = pipeline.indexOf(stage)
  if (at >= 0) return pipeline[at + 1] ?? null
  const order = Object.keys(config.stages)
  const pos = order.indexOf(stage)
  return pipeline.find((s) => order.indexOf(s) > pos) ?? null
}

export function decide(view: IssueView, config: Config, ctx: DecideContext): Decision {
  const { lifecycle, stage, pipeline } = view
  if (lifecycle === null) return { kind: 'ignore', reason: `status ${view.snapshot.status} is not mapped` }
  if (lifecycle === 'done' || lifecycle === 'canceled') return { kind: 'ignore', reason: lifecycle }
  if (stage === null) {
    if (lifecycle === 'ready' && view.templateErrors.length === 0 && pipeline.includes('implementation'))
      return { kind: 'enter', stage: 'implementation' }
    const first = pipeline[0]
    return first ? { kind: 'enter', stage: first } : { kind: 'ignore', reason: 'empty pipeline' }
  }
  const def = config.stages[stage]
  if (!def) return { kind: 'ignore', reason: `unknown stage ${stage}` }
  if (!pipeline.includes(stage)) {
    const next = nextStage(config, pipeline, stage)
    return next
      ? { kind: 'enter', stage: next, from: stage }
      : { kind: 'ignore', reason: 'past the pipeline' }
  }
  if (!def.automatic) return { kind: 'wait', reason: `stage ${stage} runs in a lead session` }
  if (view.awaiting && view.awaiting.stage === stage) {
    if (lifecycle !== 'ready') return { kind: 'wait', reason: 'waiting for you' }
    if (view.awaiting.kind === 'after') return { kind: 'advance', stage }
    return { kind: 'release', stage }
  }
  if (lifecycle === 'blocked') return { kind: 'wait', reason: 'blocked' }
  const agent = selectAgent(config.selection, { stage, issueType: view.issueType, attempt: 1 })
  if (agent !== undefined && ctx.agentKind(agent) === 'worker') {
    if (lifecycle === 'running') return { kind: 'running' }
    if (lifecycle === 'ready' || lifecycle === 'backlog') return { kind: 'dispatch', agent }
    return { kind: 'wait', reason: `${lifecycle} in stage ${stage}` }
  }
  return { kind: 'role', stage, agent }
}
