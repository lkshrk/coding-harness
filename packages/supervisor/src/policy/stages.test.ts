import { describe, expect, test } from 'bun:test'
import { issueBody, snapshot, testConfig } from '../testing/testing'
import { decide, lifecycleOf, nextStage, type ViewOptions, viewIssue } from './stages'

const config = testConfig()
const kinds: Record<string, 'worker' | 'single_call'> = {
  intake: 'single_call',
  reviewer: 'single_call',
  acceptor: 'single_call',
  implementer: 'worker',
  fixer: 'worker',
}
const ctx = { agentKind: (name: string) => kinds[name] }

const view = (over: Parameters<typeof snapshot>[0], opts: ViewOptions = {}) => {
  const v = viewIssue(snapshot(over), config, opts)
  if (!v) throw new Error('unmanaged')
  return v
}

describe('viewIssue', () => {
  test('maps status, stage, type, repository, merge mode and files', () => {
    const v = view({
      identifier: 'FOR-1',
      status: 'In Progress',
      labels: ['ai-stage:implementation', 'type:feature'],
      description: issueBody(['src/sync/*.go', 'src/a.ts']),
    })
    expect(v).toMatchObject({
      lifecycle: 'running',
      stage: 'implementation',
      awaiting: null,
      issueType: 'feature',
      repository: 'omni',
      mergeMode: 'auto',
      pipeline: config.pipelines.feature,
      files: ['src/sync/*.go', 'src/a.ts'],
      templateErrors: [],
    })
  })

  test('an issue that fails the template validator has no file set and lists the errors', () => {
    const v = view({ identifier: 'FOR-1', description: '## Files\n- a\n' })
    expect(v.files).toEqual([])
    expect(v.templateErrors).toContain('missing section ## Goal')
  })

  test('matches projects by label and needs a repo label when several repositories are mapped', () => {
    const v = view({ identifier: 'FOR-2', project: null, labels: ['bug', 'repo:web'] })
    expect(v.pipeline).toEqual(config.pipelines.bug as string[])
    expect(v.repository).toBe('web')
    expect(view({ identifier: 'FOR-3', project: null, labels: ['bug'] }).repository).toBeNull()
  })

  test('an issue whose type has its own pipeline uses it; a bug in a feature project needs no design link', () => {
    const description = issueBody(['src/a.ts']).replace(
      /## Design excerpt[\s\S]*?(?=\n## )/,
      '## Design excerpt\n\nnone\n',
    )
    const bug = view({ identifier: 'FOR-5', labels: ['type:bug'], description })
    expect(bug.pipeline).toEqual(config.pipelines.bug as string[])
    expect(bug.templateErrors).toEqual([])
    const feature = view({ identifier: 'FOR-6', labels: [], description })
    expect(feature.pipeline).toEqual(config.pipelines.feature as string[])
    expect(feature.templateErrors).toContain("## Design excerpt: 'none' is not allowed")
  })

  test('a child pipeline ends at integration; an issue without a parent keeps acceptance', () => {
    const feature = config.pipelines.feature as string[]
    const child = view({ identifier: 'FOR-7', parent: 'FOR-1' })
    expect(child.pipeline).toEqual(feature.slice(0, feature.indexOf('integration') + 1))
    expect(nextStage(config, child.pipeline, 'integration')).toBeNull()
    const parentless = view({ identifier: 'FOR-8', parent: null })
    expect(parentless.pipeline).toEqual(feature)
    expect(nextStage(config, parentless.pipeline, 'integration')).toBe('acceptance')
    const bug = view({ identifier: 'FOR-9', project: null, labels: ['bug'], parent: 'FOR-1' })
    expect(bug.pipeline).toEqual(config.pipelines.bug as string[])
  })

  test('ignores unmanaged issues and issues with an exclude label', () => {
    expect(viewIssue(snapshot({ identifier: 'FOR-4', project: null, labels: [] }), config)).toBeNull()
    expect(viewIssue(snapshot({ identifier: 'FOR-5', labels: ['business'] }), config)).toBeNull()
    expect(viewIssue(snapshot({ identifier: 'XYZ-5', team: 'XYZ' }), config)).toBeNull()
  })
})

describe('lifecycleOf / nextStage', () => {
  test('triage shares Backlog by default and Backlog reads as backlog', () => {
    expect(lifecycleOf(config, 'ROU', 'Backlog')).toBe('backlog')
  })

  test('lifecycle comes from the team status mapping', () => {
    expect(lifecycleOf(config, 'FOR', 'In Review')).toBe('review')
    expect(lifecycleOf(config, 'FOR', 'Duplicate')).toBeNull()
    expect(lifecycleOf(config, 'XYZ', 'Done')).toBe('done')
    expect(lifecycleOf(config, 'XYZ', 'Shipped')).toBeNull()
  })

  test('next stage follows the pipeline; a stage outside it continues after its canonical position', () => {
    const bug = config.pipelines.bug as string[]
    expect(nextStage(config, bug, 'intake')).toBe('implementation')
    expect(nextStage(config, bug, 'integration')).toBeNull()
    expect(nextStage(config, bug, 'design')).toBe('implementation')
  })
})

describe('decide', () => {
  test('terminal or unmapped statuses are ignored', () => {
    expect(decide(view({ identifier: 'FOR-1', status: 'Done' }), config, ctx).kind).toBe('ignore')
    expect(decide(view({ identifier: 'FOR-1', status: 'Duplicate' }), config, ctx).kind).toBe('ignore')
  })

  test('an issue without a stage enters the first stage of its pipeline', () => {
    expect(decide(view({ identifier: 'FOR-1', status: 'Triage', labels: [] }), config, ctx)).toEqual({
      kind: 'enter',
      stage: 'intake',
    })
  })

  test('a ready issue with a valid description and no stage skips intake to implementation', () => {
    expect(decide(view({ identifier: 'FOR-1', status: 'Todo', labels: [] }), config, ctx)).toEqual({
      kind: 'enter',
      stage: 'implementation',
    })
    const invalid = view({ identifier: 'FOR-2', status: 'Todo', labels: [], description: '## Goal\n\nx\n' })
    expect(decide(invalid, config, ctx)).toEqual({ kind: 'enter', stage: 'intake' })
  })

  test('an unstaged child in Backlog with a valid description enters implementation', () => {
    const child = view({ identifier: 'FOR-3', status: 'Backlog', labels: [], parent: 'FOR-1' })
    expect(decide(child, config, ctx)).toEqual({ kind: 'enter', stage: 'implementation' })
  })

  test('an unstaged issue without a parent in Backlog enters the first stage', () => {
    const orphan = view({ identifier: 'FOR-4', status: 'Backlog', labels: [], parent: null })
    expect(decide(orphan, config, ctx)).toEqual({ kind: 'enter', stage: 'intake' })
  })

  test('a child with template errors enters the first stage', () => {
    const child = view({
      identifier: 'FOR-5',
      status: 'Backlog',
      labels: [],
      parent: 'FOR-1',
      description: '## Goal\n\nx\n',
    })
    expect(decide(child, config, ctx)).toEqual({ kind: 'enter', stage: 'intake' })
  })

  test('a stage the pipeline omits is skipped to the next pipeline stage', () => {
    const v = view({ identifier: 'FOR-1', project: null, labels: ['bug', 'ai-stage:design'] })
    expect(decide(v, config, ctx)).toEqual({ kind: 'enter', stage: 'implementation', from: 'design' })
  })

  test('non-automatic stages are never acted on', () => {
    expect(
      decide(view({ identifier: 'FOR-1', status: 'Backlog', labels: ['ai-stage:discovery'] }), config, ctx)
        .kind,
    ).toBe('wait')
  })

  test('human checkpoints hold in blocked and release on ready', () => {
    const after = { awaiting: { kind: 'after' as const, stage: 'acceptance' } }
    const held = view({ identifier: 'FOR-1', status: 'Blocked', labels: ['ai-stage:acceptance'] }, after)
    expect(decide(held, config, ctx).kind).toBe('wait')
    const confirmed = view({ identifier: 'FOR-1', status: 'Todo', labels: ['ai-stage:acceptance'] }, after)
    expect(decide(confirmed, config, ctx)).toEqual({ kind: 'advance', stage: 'acceptance' })
    const before = {
      ...config,
      stages: { ...config.stages, implementation: { automatic: true, human_checkpoint: 'before' as const } },
    }
    const released = view(
      { identifier: 'FOR-1', status: 'Todo', labels: ['ai-stage:implementation'] },
      { awaiting: { kind: 'before', stage: 'implementation' } },
    )
    expect(decide(released, before, ctx)).toEqual({ kind: 'release', stage: 'implementation' })
  })

  test('an awaiting record for another stage is ignored', () => {
    const stale = view(
      { identifier: 'FOR-1', status: 'Todo', labels: ['ai-stage:implementation'] },
      { awaiting: { kind: 'after', stage: 'acceptance' } },
    )
    expect(decide(stale, config, ctx)).toEqual({ kind: 'dispatch', agent: 'implementer' })
  })

  test('worker stages go to the ready set; single-call stages to their role; others to the supervisor', () => {
    expect(decide(view({ identifier: 'FOR-1' }), config, ctx)).toEqual({
      kind: 'dispatch',
      agent: 'implementer',
    })
    expect(decide(view({ identifier: 'FOR-1', status: 'Backlog' }), config, ctx).kind).toBe('dispatch')
    expect(decide(view({ identifier: 'FOR-1', status: 'In Progress' }), config, ctx).kind).toBe('running')
    expect(
      decide(view({ identifier: 'FOR-1', status: 'Triage', labels: ['ai-stage:intake'] }), config, ctx),
    ).toEqual({ kind: 'role', stage: 'intake', agent: 'intake' })
    expect(
      decide(
        view({ identifier: 'FOR-1', status: 'In Review', labels: ['ai-stage:integration'] }),
        config,
        ctx,
      ),
    ).toEqual({ kind: 'role', stage: 'integration', agent: undefined })
  })
})

describe('act_on opt-in', () => {
  const labelsOnly = {
    ...config,
    linear: { ...config.linear, act_on: { delegated: false, labels: ['autopilot'] } },
  }

  test('an issue that is neither delegated nor labelled is ignored', () => {
    expect(viewIssue(snapshot({ identifier: 'FOR-20', delegated: false }), config)).toBeNull()
  })

  test('an act_on label opts an issue in, case-insensitively', () => {
    const plain = snapshot({
      identifier: 'FOR-21',
      delegated: false,
      labels: ['ai-stage:implementation', 'autopilot'],
    })
    const cased = snapshot({
      identifier: 'FOR-22',
      delegated: false,
      labels: ['ai-stage:implementation', 'Autopilot'],
    })
    expect(viewIssue(plain, config)).not.toBeNull()
    expect(viewIssue(cased, config)).not.toBeNull()
  })

  test('delegation counts only while act_on.delegated is enabled', () => {
    expect(viewIssue(snapshot({ identifier: 'FOR-23', delegated: true }), labelsOnly)).toBeNull()
    expect(viewIssue(snapshot({ identifier: 'FOR-24', delegated: true }), config)).not.toBeNull()
  })

  test('exclude_labels wins over opt-in', () => {
    const issue = snapshot({ identifier: 'FOR-25', delegated: true, labels: ['autopilot', 'business'] })
    expect(viewIssue(issue, config)).toBeNull()
  })

  test('a grouped label matches its plain name regardless of case', () => {
    const typed = {
      ...config,
      projects: [{ ...config.projects[0], match: { team: 'FOR', label: 'bug' } }],
    } as typeof config
    const issue = snapshot({
      identifier: 'FOR-26',
      project: null,
      labels: ['ai-stage:implementation', 'type:Bug'],
    })
    expect(viewIssue(issue, typed)).not.toBeNull()
  })
})
