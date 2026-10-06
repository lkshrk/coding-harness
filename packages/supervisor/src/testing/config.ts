import { type Config, type LinearWorkspace, parseConfig } from '@nightshift/core'

const statuses = {
  triage: 'Triage',
  backlog: 'Backlog',
  ready: 'Todo',
  running: 'In Progress',
  review: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
  canceled: 'Canceled',
}

export function testConfig(): Config {
  return parseConfig({
    version: 1,
    paths: { state: '/tmp/ns/state', cache: '/tmp/ns/cache', vault: '/tmp/ns/vault' },
    gateway: {
      base_url: 'http://gateway.test',
      api_key: 'env:NS_GATEWAY_KEY',
      worker_key: 'env:NS_WORKER_KEY',
    },
    linear: {
      auth: { mode: 'api_key', api_key: 'env:NS_LINEAR_KEY' },
      exclude_labels: ['business'],
      teams: [{ key: 'FOR', statuses }],
    },
    github: { accounts: { me: { token: 'env:GH_TOKEN' } } },
    repositories: {
      omni: {
        path: '/tmp/omni',
        remote: 'origin',
        base: 'main',
        stacks: 'auto',
        checks: [{ name: 'test', run: 'bun test', timeout: '15m' }],
        risk_paths: [],
        macos_only: false,
      },
      web: {
        path: '/tmp/web',
        remote: 'origin',
        base: 'main',
        stacks: 'auto',
        checks: [{ name: 'test', run: 'bun test', timeout: '15m' }],
        risk_paths: [],
        macos_only: false,
      },
    },
    projects: [
      { match: { team: 'FOR', project: 'Omni' }, repositories: ['omni'], pipeline: 'feature' },
      { match: { team: 'FOR', label: 'bug' }, repositories: ['omni', 'web'], pipeline: 'bug' },
    ],
    pipelines: {
      feature: [
        'intake',
        'discovery',
        'design',
        'decomposition',
        'implementation',
        'verification',
        'integration',
        'acceptance',
      ],
      bug: ['intake', 'implementation', 'verification', 'integration'],
    },
    stages: {
      intake: { automatic: true, human_checkpoint: 'none' },
      discovery: { automatic: false, human_checkpoint: 'none' },
      design: { automatic: false, human_checkpoint: 'after' },
      decomposition: { automatic: false, human_checkpoint: 'after' },
      implementation: { automatic: true, human_checkpoint: 'none' },
      verification: { automatic: true, human_checkpoint: 'none' },
      integration: { automatic: true, human_checkpoint: 'none' },
      acceptance: { automatic: true, human_checkpoint: 'after' },
      release: { automatic: true, human_checkpoint: 'none' },
    },
    selection: [
      { when: { stage: 'intake' }, agent: 'intake' },
      { when: { stage: 'verification' }, agent: 'reviewer' },
      { when: { stage: 'acceptance' }, agent: 'acceptor' },
      { when: { stage: 'implementation', failure_class: 'implementation_defect' }, agent: 'repairer' },
      { when: { stage: 'implementation', issue_type: 'bug' }, agent: 'fixer' },
      { when: { stage: 'implementation', attempt: '>=3' }, agent: 'implementer-strong' },
      { when: { stage: 'implementation' }, agent: 'implementer' },
    ],
    profiles: {
      active: 'default',
      memory_budget_gb: 100,
      default: {
        roles: { worker: 'ns/worker', reviewer: 'ns/reviewer' },
        models: {
          'ns/worker': { model: 'qwen-coder', family: 'qwen', size_gb: 10, phases: ['implementation'] },
          'ns/reviewer': { model: 'glm', family: 'glm', size_gb: 10, phases: ['implementation'] },
        },
      },
    },
    limits: {
      concurrency: 2,
      worker: { wall_clock: '45m', tokens: '2M', steps: 200 },
      repair_rounds: 2,
      best_of: 2,
    },
    sandbox: { driver: 'docker', resources: { cpus: 4, memory: '8g' } },
    notifications: { macos: true, ntfy: null },
    policies: { deny: {} },
    secrets: { rbw_profile: 'nightshift' },
  })
}

export function testWorkspace(): LinearWorkspace {
  return {
    organization: { id: 'o', name: 'h-cloud', urlKey: 'h-cloud', plan: 'basic' },
    teams: [
      {
        id: 't-FOR',
        key: 'FOR',
        name: 'Forge',
        statuses: Object.values(statuses).map((name) => ({ id: `s-${name}`, name, type: 'started' })),
      },
    ],
    labels: [
      { id: 'l-bug', name: 'bug', isGroup: false, parentId: null, teamId: null },
      { id: 'l-business', name: 'business', isGroup: false, parentId: null, teamId: null },
    ],
    projectLabels: [],
    projects: [{ id: 'p-omni', name: 'Omni', state: 'started', milestones: [] }],
    initiatives: [],
    templates: [],
  }
}

export function issueBody(files: string[] = ['src/a.ts']): string {
  return [
    '## Goal',
    'Do the thing.',
    '## Why',
    'Because.',
    '## Design excerpt',
    '[design](https://linear.app/h-cloud/document/design-1) section 2',
    '## Interfaces in',
    'none',
    '## Interfaces out',
    'none',
    '## Files',
    ...files.map((f) => `- \`${f}\``),
    '## Constraints',
    'none',
    '## Out of scope',
    'none',
    '## Acceptance criteria',
    '- it works',
    '## Tests expected',
    '- a unit test',
    '## Verify',
    '- `bun test`',
    '',
  ].join('\n')
}
